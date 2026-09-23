import { config, effectiveEysFlowFloorUsd, EYS_MAX_POOL_RESOLUTION_MINTS, SOL_MINT } from "../config.js";
import { getDb, isBlacklisted, now, recordDecision } from "../db/db.js";
import type { Candidate, GateFailure, PoolInfo } from "../types.js";
import { poolGates } from "./gates.js";
import { priceDivergenceGate } from "./priceGate.js";
import { GMGN_ONE_MINUTE_FRESHNESS_MS, gmgnOneMinuteFlow, trendingByMint, tokenInfoByMint, mergeGmgnPresenceMaps } from "./gmgn.js";
import { discoverRecentMeteoraPools } from "./meteora-events.js";
import { fetchPoolsByTokenMints, sweepPools } from "./meteora.js";
import { fetchCandlesDeep } from "./candles.js";
import { feeMomentumPart, opportunityScore, structurePart, timingPart, turnoverPart } from "./score.js";

// STRATEGY.md §1 — sweep → dedupe copycats → best pool per token → gates → score.

/**
 * Copycat cooldown (§1.2): mints that LOST a symbol dedupe are ignored for
 * scanner.copycat_ignore_h, so the "canonical" token for a symbol can't flip
 * sweep-to-sweep as 24h volumes wobble. In-memory on purpose — a restart
 * re-judging from fresh volumes is fine; what we're damping is oscillation
 * within a session. The knob existed since launch but was never read.
 */
const copycatIgnoredUntil = new Map<string, number>();

/**
 * Choose which of a token's pools to trade. Pure; exported for tests.
 *
 * The old rule was "highest 24h fee/TVL". Fee/TVL is inversely proportional to
 * TVL, so among sibling pools of the same token that rule *structurally* picks
 * the thinnest one — measured 2026-08-15: in 11 of 18 multi-pool mints on the
 * scanner's board the thinner pool ranked higher, and in 9 of those the deeper
 * pool also had more absolute volume. Thin pools cost twice: less fee income
 * (volume happens where depth is), and TVL that jitters 40–50% on ordinary LP
 * repositioning, which is precisely what P0 `tvl_drain` reads as a rug. Same
 * token, same price move, sampled 4 minutes: $8k pool swung 51%, $67k pool 9%.
 *
 * So: among the token's pools that pass the hard gates, take the DEEPEST.
 * The gates already encode which pool SHAPES the strategy accepts — bin step,
 * fee mode, quote mint — so "passes the gates" is the family boundary; a
 * bin-20 pool is not an alternative to a bin-100 pool because bin_step_new
 * rejects it, not because we compare bin steps by hand. (An earlier draft
 * required identical bin steps and, on the real board, chose a $6k bin-80
 * pool over a $60k bin-100 pool that the gates were perfectly happy with.)
 * Fee/TVL breaks ties only when TVL is within `sibling_tvl_tie_pct` of the
 * deepest (depth so close that the fee edge is real). A pool that fails the
 * gates never wins on depth alone; and if nothing passes we still return the
 * best-by-fee pool so the decisions log records the rejection instead of the
 * token vanishing.
 */
export function pickBestPool<P extends { tvlUsd: number; feeTvl24hPct: number }>(
  pools: P[],
  passesGates: (p: P) => boolean,
  tiePct: number,
): P | null {
  if (!pools.length) return null;
  const byFee = (a: P, b: P) => b.feeTvl24hPct - a.feeTvl24hPct;
  const eligible = pools.filter(passesGates);
  if (!eligible.length) return [...pools].sort(byFee)[0]!;
  const deepest = [...eligible].sort((a, b) => b.tvlUsd - a.tvlUsd)[0]!;
  const nearDepth = eligible.filter((p) => p.tvlUsd >= deepest.tvlUsd * (1 - tiePct / 100));
  return nearDepth.sort(byFee)[0]!;
}

/**
 * Eys gets a broad discovery universe before the core economic gates. Keep only
 * structural facts that are required to identify an executable SOL DLMM pool;
 * fee/volume/base-fee/price-divergence selection belongs to the Eys evidence
 * stage or the final execution checks, not this intake boundary.
 */
export function eysDiscoveryGates(
  p: PoolInfo & { extras: import("./meteora.js").RawPoolExtras },
): GateFailure[] {
  const g = config().gates;
  const fails: GateFailure[] = [];
  const fail = (gate: string, value: unknown, limit: unknown) =>
    fails.push({ gate, value: String(value), limit: String(limit) });
  if (p.isBlacklisted === true) fail("pool_blacklisted", "true", "false");
  if (!Number.isFinite(p.tvlUsd) || p.tvlUsd <= 0) {
    fail("tvl_invalid", p.tvlUsd, "finite > 0");
  } else if (p.tvlUsd < g.tvl_min_usd) {
    fail("tvl_min", p.tvlUsd.toFixed(0), g.tvl_min_usd);
  }
  if (g.fee_collection === "both_only" && !p.feesBothTokens) {
    fail("fee_collection", `collect_fee_mode=${p.extras.collectFeeMode}`, "0 (both tokens)");
  }
  if (g.fee_collection === "quote_only" && p.feesBothTokens) {
    fail("fee_collection", `collect_fee_mode=${p.extras.collectFeeMode}`, "1 (quote/SOL only)");
  }
  if (p.mintY !== SOL_MINT) fail("quote_mint", p.mintY, SOL_MINT);
  if (p.mintX === SOL_MINT) fail("base_mint", p.mintX, "non-SOL token");
  return fails;
}

/** Pure winner selection for one symbol group: mint -> 24h vol. Exported for tests. */
export function pickCopycatWinner(
  volByMint: Map<string, number>,
  ignoredUntil: Map<string, number>,
  nowS: number,
  ignoreS: number,
): string | null {
  const eligible = [...volByMint.entries()]
    .filter(([mint]) => (ignoredUntil.get(mint) ?? 0) <= nowS)
    .sort((a, b) => b[1] - a[1]);
  const winner = eligible[0];
  if (!winner) return null; // every contender is cooling down — skip the symbol
  if (volByMint.size > 1) {
    for (const [mint] of volByMint) {
      if (mint === winner[0]) continue;
      // Don't extend an active cooldown: refreshing it every sweep would make
      // "ignored for copycat_ignore_h" effectively permanent for any loser
      // that keeps showing up. Expired losers get re-judged and may win.
      if ((ignoredUntil.get(mint) ?? 0) > nowS) continue;
      ignoredUntil.set(mint, nowS + ignoreS);
    }
  }
  return winner[0];
}

export interface ScanResult {
  candidates: Candidate[];   // passed all pool gates, sorted by score desc
  rejected: Candidate[];     // failed gates (kept for the decisions log)
  sweptPools: number;
  /** Shared discovery evidence for the hosted strategy boundary. */
  gmgnByMint?: ReadonlyMap<string, import("./gmgn.js").GmgnPresence>;
  /** Supplemental event-intake telemetry; no admission authority. */
  discovery?: {
    enabled: boolean;
    signaturesFetched: number;
    signaturesParsed: number;
    eventsFound: number;
    unavailableSignatures: number;
    backlogCapped: boolean;
    windowTruncated: boolean;
    exactPoolsResolved: number;
  };
  /** Bounded supplemental Eys intake resolved from fresh GMGN 1m rows. */
  eysIntake?: {
    gmgnMintsAtFlowFloor: number;
    gmgnMintLookups: number;
    gmgnProviderSuccesses: number;
    gmgnEmptyResults: number;
    gmgnFailedLookups: number;
    gmgnPartialLookups: number;
    gmgnPoolsReturned: number;
  };
}

export function eysModeActive(): boolean {
  return config().strategy?.mode === "eys" && config().eys?.enabled === true;
}

/** Select only fresh, official-flow-qualified GMGN mints for exact-pool lookup. */
export function selectEysPoolResolutionMints(
  gmgnByMint: ReadonlyMap<string, import("./gmgn.js").GmgnPresence>,
  nowMs = Date.now(),
): string[] {
  const cfg = config().eys;
  const floor = effectiveEysFlowFloorUsd(cfg?.flow_floor_usd);
  const maxMints = Math.min(
    Number.isInteger(cfg?.gmgn_pool_resolution_max_mints) && cfg.gmgn_pool_resolution_max_mints > 0
      ? cfg.gmgn_pool_resolution_max_mints
      : 12,
    EYS_MAX_POOL_RESOLUTION_MINTS,
  );
  const mcapFloor = Number(cfg?.market_cap_floor_usd) || 0;
  return [...gmgnByMint.entries()]
    .map(([mint, presence]) => ({
      mint,
      flow: gmgnOneMinuteFlow(presence, nowMs, GMGN_ONE_MINUTE_FRESHNESS_MS),
      // `evaluateEys` rejects below the market-cap floor after the pools are
      // already resolved — skip those mints here so provider budget is only
      // spent on tokens that can actually reach a proposal.
      mcap: presence.tokenByInterval.get("1m")?.marketCapUsd ?? 0,
    }))
    .filter((row): row is { mint: string; flow: NonNullable<ReturnType<typeof gmgnOneMinuteFlow>>; mcap: number } =>
      row.flow !== null && row.flow.volumeUsd >= floor && row.mcap >= mcapFloor,
    )
    .sort((a, b) => b.flow.volumeUsd - a.flow.volumeUsd)
    .slice(0, maxMints)
    .map((row) => row.mint);
}

/**
 * Eys sources candidates from the GMGN trending/event universe ("trending 1m
 * $100k+"). A Meteora-swept pool whose mint has no GMGN sighting is never
 * trending: its token-info volume_1m is 0, so it can never yield a fresh 1m
 * flow row. It would only reach evaluateEys as flow_unavailable (46% of all
 * rejections) while consuming refresh budget the genuinely-hot tokens need.
 * Returns a gate failure when the mint carries no GMGN flow source.
 */
export function eysFlowSourceGateFailure(
  mint: string,
  gmgnByMint: ReadonlyMap<string, unknown>,
): { gate: string; value: string; limit: string } | null {
  if (gmgnByMint.has(mint)) return null;
  return { gate: "no_gmgn_flow_source", value: "absent", limit: "GMGN trending/event sighting" };
}

export async function scan(opts: { withTiming?: boolean } = {}): Promise<ScanResult> {
  const eysMode = eysModeActive();
  const [sweptPools, gmgnTrending, eventDiscovery] = await Promise.all([
    sweepPools(),
    trendingByMint(),
    discoverRecentMeteoraPools(),
  ]);
  const eventGmgn = await tokenInfoByMint(eventDiscovery.tokenMints);
  const gmgnByMint = mergeGmgnPresenceMaps(gmgnTrending, eventGmgn);
  const gmgnMintsAtFlowFloor = eysMode
    ? [...gmgnTrending.values()].filter((presence) => {
      const flow = gmgnOneMinuteFlow(presence, Date.now(), GMGN_ONE_MINUTE_FRESHNESS_MS);
      return flow !== null && flow.volumeUsd >= effectiveEysFlowFloorUsd(config().eys.flow_floor_usd);
    }).length
    : 0;
  const gmgnPoolMints = eysMode ? selectEysPoolResolutionMints(gmgnTrending) : [];
  const gmgnResolution = eysMode && gmgnPoolMints.length > 0
    ? await fetchPoolsByTokenMints(gmgnPoolMints)
    : { pools: [], attemptedMints: 0, providerSuccessMints: 0, emptyMints: 0, failedMints: 0, partialMints: 0 };
  const gmgnPools = gmgnResolution.pools;
  const pools = [...new Map(
    [...sweptPools, ...eventDiscovery.pools, ...gmgnPools].map((pool) => [pool.address, pool]),
  ).values()];
  const db = getDb();

  // Snapshot every swept pool (offline replay/tuning dataset, §7).
  const snap = db.prepare(
    `INSERT INTO pool_snapshots (pool, ts, tvl_usd, price, vol_30m, vol_1h, vol_24h, fee_tvl_30m, fee_tvl_24h)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const ts = now();
  const insertMany = db.transaction(() => {
    for (const p of pools)
      snap.run(p.address, ts, p.tvlUsd, p.price, p.vol30mUsd, p.vol1hUsd, p.vol24hUsd, p.feeTvl30mPct, p.feeTvl24hPct);
  });
  insertMany();

  // Consider only SOL-quoted, non-SOL-base pools; skip blacklisted tokens.
  const memePools = pools.filter((p) => p.mintY === SOL_MINT && p.mintX !== SOL_MINT);

  // Copycat dedupe (§1.2): same symbol -> keep highest 24h volume.
  const bySymbol = new Map<string, typeof memePools>();
  for (const p of memePools) {
    const sym = (p.name.split("-")[0] ?? p.name).toUpperCase();
    const list = bySymbol.get(sym) ?? [];
    list.push(p);
    bySymbol.set(sym, list);
  }
  const canonical = new Set<string>();
  if (eysMode) {
    // Eys owns its discovery universe. Do not let the core symbol/copycat
    // heuristic discard a hot mint before its exact-pool evidence is evaluated.
    for (const p of memePools) canonical.add(p.mintX);
  } else {
    const ignoreS = (config().scanner.copycat_ignore_h ?? 24) * 3600;
    for (const [mint, until] of copycatIgnoredUntil) {
      if (until <= ts) copycatIgnoredUntil.delete(mint); // prune expired cooldowns
    }
    for (const list of bySymbol.values()) {
      const byMint = new Map<string, number>();
      for (const p of list) byMint.set(p.mintX, (byMint.get(p.mintX) ?? 0) + p.vol24hUsd);
      const winner = pickCopycatWinner(byMint, copycatIgnoredUntil, ts, ignoreS);
      if (winner) canonical.add(winner);
    }
  }

  // Best pool per canonical token: deepest gate-passing sibling in the same
  // bin-step family (see pickBestPool — "highest fee/TVL" picked thin pools).
  const poolsByMint = new Map<string, typeof memePools>();
  for (const p of memePools) {
    if (!canonical.has(p.mintX)) continue;
    if (isBlacklisted(p.mintX)) continue;
    const list = poolsByMint.get(p.mintX) ?? [];
    list.push(p);
    poolsByMint.set(p.mintX, list);
  }
  const bestPool = new Map<string, (typeof memePools)[number]>();
  const tiePct = config().scanner.sibling_tvl_tie_pct ?? 25;
  for (const [mint, list] of poolsByMint) {
    const pick = pickBestPool(
      list,
      (p) => (eysMode ? eysDiscoveryGates(p) : poolGates(p)).length === 0,
      tiePct,
    );
    if (pick) bestPool.set(mint, pick);
  }

  const candidates: Candidate[] = [];
  const rejected: Candidate[] = [];

  for (const p of bestPool.values()) {
    const gateFailures = eysMode ? eysDiscoveryGates(p) : poolGates(p);
    // Eys candidates must have a GMGN flow source (trending/event): a swept
    // pool with no GMGN sighting can never produce a 1m flow row (not trending;
    // token-info volume_1m=0) and only floods flow_unavailable while diluting
    // the refresh budget. Non-core strategies keep the broad Meteora sweep.
    if (eysMode) {
      const flowSource = eysFlowSourceGateFailure(p.mintX, gmgnByMint);
      if (flowSource) gateFailures.push(flowSource);
    }
    const symbol = p.name.split("-")[0] ?? p.name;

    // Eys evaluates price/flow economics after broad intake. Core retains the
    // generic Jupiter divergence gate at scanner admission.
    if (!eysMode && gateFailures.length === 0) {
      const divergence = await priceDivergenceGate(p.mintX, p.price);
      if (divergence) gateFailures.push(divergence);
    }

    // Timing needs a candles fetch per pool — only for gate-passers (cheap sweep).
    let timing = 0.5;
    if (gateFailures.length === 0 && opts.withTiming !== false) {
      try {
        timing = timingPart(await fetchCandlesDeep(p.address, "5m"), p.price);
      } catch {
        timing = 0.5;
      }
    }

    const parts = {
      feeMomentum: feeMomentumPart(p),
      turnover: turnoverPart(p),
      vettingSoft: 0.5, // replaced by the vetting engine downstream
      timing,
      structure: structurePart(p),
    };
    let { score, weighted } = opportunityScore(parts);

    // GMGN enrichment (§1): tiered trending bonus + cheap pre-vet from trending metadata.
    const g = config().gmgn;
    const gm = gmgnByMint.get(p.mintX);
    // The tracked core strategy historically used only the 5m/1h enrichment
    // windows. Eys may consume the additional 1m row, but a 1m-only sighting
    // must not silently change core admission or renounced-token behavior.
    const coreGm = gm && (gm.intervals.has("5m") || gm.intervals.has("1h")) ? gm : undefined;
    if (coreGm) {
      const t = coreGm.tokenByInterval.get("5m") ?? coreGm.tokenByInterval.get("1h") ?? coreGm.token;
      if (!eysMode && g.require_renounced && (!t.renouncedMint || !t.renouncedFreeze)) {
        gateFailures.push({ gate: "gmgn_renounced", value: `mint=${t.renouncedMint} freeze=${t.renouncedFreeze}`, limit: "both renounced" });
      } else {
        const in5m = coreGm.intervals.has("5m");
        const in1h = coreGm.intervals.has("1h");
        const bonus = in5m && in1h ? g.bonus_sustained : in5m ? g.bonus_emerging : in1h ? g.bonus_fading : 0;
        if (bonus > 0) {
          score = Math.min(100, score + bonus);
          weighted = { ...weighted, gmgn_trending: bonus };
        }
      }
    }

    const cand: Candidate = { pool: p, tokenMint: p.mintX, symbol, score, scoreParts: weighted, gateFailures };
    if (gateFailures.length === 0) candidates.push(cand);
    else {
      rejected.push(cand);
      // Every rejected pool, every sweep, used to serialise the WHOLE pool
      // object here (~1 KB/row, ~100 rows/hour, no retention) — the Railway
      // volume hit 83% inside a day and the local DB grew 27 MB in 200 hours
      // of `decisions` alone. The pool's numbers for this exact sweep are
      // already in pool_snapshots; the decision row only needs the reason and
      // the few numbers the funnel reads to explain it.
      recordDecision(p.mintX, p.address, "skipped", gateFailures[0]?.gate ?? null, score, {
        symbol, gateFailures,
        tvlUsd: Math.round(p.tvlUsd), vol30mUsd: Math.round(p.vol30mUsd),
        feeTvl24hPct: +p.feeTvl24hPct.toFixed(2), feeTvl30mPct: +p.feeTvl30mPct.toFixed(2),
        binStep: p.binStep, mcapUsd: Math.round(p.marketCapUsd ?? 0),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return {
    candidates,
    rejected,
    sweptPools: sweptPools.length,
    gmgnByMint,
    discovery: {
      enabled: eventDiscovery.enabled,
      signaturesFetched: eventDiscovery.signaturesFetched,
      signaturesParsed: eventDiscovery.signaturesParsed,
      eventsFound: eventDiscovery.eventsFound,
      unavailableSignatures: eventDiscovery.unavailableSignatures,
      backlogCapped: eventDiscovery.backlogCapped,
      windowTruncated: eventDiscovery.windowTruncated,
      exactPoolsResolved: eventDiscovery.pools.length,
    },
    eysIntake: eysMode
      ? {
        gmgnMintsAtFlowFloor,
        gmgnMintLookups: gmgnResolution.attemptedMints,
        gmgnProviderSuccesses: gmgnResolution.providerSuccessMints,
        gmgnEmptyResults: gmgnResolution.emptyMints,
        gmgnFailedLookups: gmgnResolution.failedMints,
        gmgnPartialLookups: gmgnResolution.partialMints,
        gmgnPoolsReturned: gmgnPools.length,
      }
      : undefined,
  };
}
