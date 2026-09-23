import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config, effectiveEysFlowFloorUsd, EYS_MAX_POOL_RESOLUTION_MINTS, EYS_MIN_FLOW_FLOOR_USD } from "../config.js";
import { recordDecision } from "../db/db.js";
import { mapLimit } from "../concurrent.js";
import { GMGN_ONE_MINUTE_FRESHNESS_MS, gmgnOneMinuteFlow, mergeGmgnPresenceMaps, tokenInfoByMint } from "../scanner/gmgn.js";
import type { GmgnPresence } from "../scanner/gmgn.js";
import type { Candidate } from "../types.js";
import { binArraysSpanned, binIdToPrice, priceToBinId } from "../ranges/planner.js";
import type {
  EysStage,
  StrategyDecision,
  StrategyDiscoveryContext,
  StrategyModelInput,
  StrategyEvidence,
  StrategyMarkInput,
  StrategyPlan,
  StrategyPlanInput,
  StrategyPlugin,
  StrategyProposal,
} from "./plugin.js";
import { buildLayaRequest, decideLayaGate, layaMode, requestLaya } from "./laya.js";

export interface FlowObservation {
  poolAddress: string;
  tokenMint: string;
  tsMs: number;
  flowUsdPerMin: number;
  source: "gmgn-market-trending";
  cadence: "1m";
}

const DEFAULT_EYS = {
  enabled: false,
  market_cap_floor_usd: 100_000,
  flow_floor_usd: EYS_MIN_FLOW_FLOOR_USD,
  entry_sol: 0.1,
  anchor_range_below_pct: 40,
  tight_price_change_pct: 10,
  token_breakout_pct: 25,
  dump_bonus_price_change_pct: 20,
  gmgn_pool_resolution_max_mints: 12,
  // Eys' "at least 10 SOL in fees" rule (post 2099817371372560521) ≈ $1,700.
  min_pool_fees_usd: 1_700,
  // Entry floor == meme rotation exit floor: feeTvl30m × 48 ≥ 5%/d.
  min_fee_yield_daily_pct: 5,
};

function finiteAtLeast(value: unknown, fallback: number, minimum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum ? value : fallback;
}

function integerAtLeast(value: unknown, fallback: number, minimum: number): number {
  const number = finiteAtLeast(value, fallback, minimum);
  return Number.isInteger(number) ? number : fallback;
}

const EYS_REJECTION_DEDUPE_MS = 5 * 60_000;
const eysRejectionLoggedAt = new Map<string, number>();

function recordEysRejection(candidate: Candidate, reason: string | undefined, evidence: unknown): void {
  const gate = `eys_${reason ?? "rejected"}`;
  const key = `${candidate.tokenMint}:${candidate.pool.address}:${gate}`;
  const nowMs = Date.now();
  const previous = eysRejectionLoggedAt.get(key);
  if (previous !== undefined && nowMs - previous < EYS_REJECTION_DEDUPE_MS) return;
  eysRejectionLoggedAt.set(key, nowMs);
  if (eysRejectionLoggedAt.size > 4096) {
    for (const [entryKey, tsMs] of eysRejectionLoggedAt) {
      if (nowMs - tsMs >= EYS_REJECTION_DEDUPE_MS) eysRejectionLoggedAt.delete(entryKey);
    }
  }
  recordDecision(
    candidate.tokenMint,
    candidate.pool.address,
    "skipped",
    gate,
    candidate.score,
    { strategy: "eys", symbol: candidate.symbol, evidence },
  );
}

function settings() {
  const raw = config().eys ?? {};
  return {
    enabled: raw.enabled === true,
    market_cap_floor_usd: finiteAtLeast(raw.market_cap_floor_usd, DEFAULT_EYS.market_cap_floor_usd, 1),
    flow_floor_usd: effectiveEysFlowFloorUsd(raw.flow_floor_usd),
    min_pool_fees_usd: finiteAtLeast(raw.min_pool_fees_usd, DEFAULT_EYS.min_pool_fees_usd, 0),
    min_fee_yield_daily_pct: finiteAtLeast(raw.min_fee_yield_daily_pct, DEFAULT_EYS.min_fee_yield_daily_pct, 0),
    entry_sol: finiteAtLeast(raw.entry_sol, DEFAULT_EYS.entry_sol, 0.000001),
    anchor_range_below_pct: finiteAtLeast(raw.anchor_range_below_pct, DEFAULT_EYS.anchor_range_below_pct, 0),
    tight_price_change_pct: finiteAtLeast(raw.tight_price_change_pct, DEFAULT_EYS.tight_price_change_pct, 0),
    token_breakout_pct: finiteAtLeast(raw.token_breakout_pct, DEFAULT_EYS.token_breakout_pct, 0),
    dump_bonus_price_change_pct: finiteAtLeast(raw.dump_bonus_price_change_pct, DEFAULT_EYS.dump_bonus_price_change_pct, 0),
    gmgn_pool_resolution_max_mints: Math.min(
      integerAtLeast(raw.gmgn_pool_resolution_max_mints, DEFAULT_EYS.gmgn_pool_resolution_max_mints, 1),
      EYS_MAX_POOL_RESOLUTION_MINTS,
    ),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function modelSnapshot(input: StrategyModelInput) {
  return {
    strategy: "eys" as const,
    discovery: input.discovery,
    candidate: asRecord({
      mint: input.candidate.tokenMint,
      symbol: input.candidate.symbol,
      score: input.candidate.score,
      scoreParts: input.candidate.scoreParts,
      pool: input.candidate.pool,
    }),
    proposal: {
      stage: input.proposal.stage,
      fundingSide: input.proposal.fundingSide,
      shape: input.proposal.shape,
    },
    evidence: asRecord(input.proposal.evidence),
    hardGates: {
      candidateGateFailures: input.candidate.gateFailures,
      vetting: asRecord(input.vetting),
      ...(input.hardGates ?? {}),
    },
    risk: {
      score: input.score,
      requestedSizeSol: input.requestedSizeSol,
      bankroll: input.bankroll,
      positionContext: input.positionContext ?? {},
    },
    range: {
      plan: asRecord(input.range),
      quote: input.quote ?? {},
      rent: input.rent ?? {},
    },
  };
}

function observationPath(): string {
  const dbPath = process.env.FARMER_DB_PATH ?? resolve(process.cwd(), "data", "farmer.db");
  return join(dirname(resolve(dbPath)), "eys-observations.json");
}

let loaded: { path: string; rows: FlowObservation[] } | null = null;

function loadRows(): FlowObservation[] {
  const path = observationPath();
  if (loaded?.path === path) return loaded.rows;
  let rows: FlowObservation[] = [];
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        rows = parsed.filter((r): r is FlowObservation =>
          !!r && typeof r === "object" &&
          typeof (r as FlowObservation).poolAddress === "string" &&
          typeof (r as FlowObservation).tokenMint === "string" &&
          Number.isFinite((r as FlowObservation).tsMs) &&
          Number.isFinite((r as FlowObservation).flowUsdPerMin) &&
          (r as FlowObservation).source === "gmgn-market-trending" &&
          (r as FlowObservation).cadence === "1m",
        );
      }
    } catch {
      // Corrupt evidence is not trusted; the next observation rebuilds it.
      rows = [];
    }
  }
  loaded = { path, rows };
  return rows;
}

function persistRows(rows: FlowObservation[]): void {
  const path = observationPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rows.slice(-2048)), { mode: 0o600 });
  renameSync(tmp, path);
}

export function recordFlowObservation(observation: FlowObservation): void {
  if (
    !observation.poolAddress || !observation.tokenMint ||
    !Number.isFinite(observation.tsMs) || !Number.isFinite(observation.flowUsdPerMin) ||
    observation.flowUsdPerMin <= 0 ||
    observation.source !== "gmgn-market-trending" || observation.cadence !== "1m"
  ) return;
  const rows = loadRows();
  const duplicate = rows.some((r) =>
    r.poolAddress === observation.poolAddress && r.tsMs === observation.tsMs,
  );
  if (duplicate) return;
  rows.push(observation);
  rows.sort((a, b) => a.tsMs - b.tsMs);
  persistRows(rows);
}

export function resetEysObservationStoreForTests(): void {
  loaded = null;
}

function stageFor(priceChangePct1h: number, cfg: ReturnType<typeof settings>): EysStage {
  if (priceChangePct1h <= -Math.abs(cfg.dump_bonus_price_change_pct)) return "dump-bonus";
  if (priceChangePct1h >= cfg.token_breakout_pct) return "token";
  if (priceChangePct1h >= cfg.tight_price_change_pct) return "tight";
  return "anchor";
}

export function evaluateEys(
  candidate: Candidate,
  evidence: StrategyEvidence,
  stage: EysStage,
): StrategyDecision {
  const cfg = settings();
  if (!cfg.enabled) return { accepted: false, reason: "eys_disabled" };
  if (evidence.exactPool !== candidate.pool.address) return { accepted: false, reason: "exact_pool_mismatch" };
  const nowMs = Date.now();
  if (
    evidence.flowObservedAtMs == null ||
    !Number.isFinite(evidence.flowObservedAtMs) ||
    evidence.flowObservedAtMs > nowMs ||
    nowMs - evidence.flowObservedAtMs > GMGN_ONE_MINUTE_FRESHNESS_MS
  ) {
    return { accepted: false, reason: "flow_stale" };
  }
  if (!(Number.isFinite(candidate.pool.marketCapUsd) && candidate.pool.marketCapUsd >= cfg.market_cap_floor_usd)) {
    return { accepted: false, reason: "market_cap_floor" };
  }
  if (!(evidence.flowUsdPerMin != null && evidence.flowUsdPerMin >= cfg.flow_floor_usd)) {
    return { accepted: false, reason: "flow_floor" };
  }
  // Eys' selection rules (post 2099817371372560521): "at least 10 SOL in
  // fees" — thin fees on busy volume is bought volume — plus self-consistency
  // with our own exit ladder: never enter a pool whose 30m fee yield is
  // already under the rotation floor (PAID pos#2: entered at ~2%/d, rotated
  // out in 47s for −1.1% because fees could never cover the round trip).
  const feesUsd24h = (candidate.pool.tvlUsd * candidate.pool.feeTvl24hPct) / 100;
  if (!(feesUsd24h >= cfg.min_pool_fees_usd)) return { accepted: false, reason: "pool_fees_below_min" };
  const feeYieldDailyPct = candidate.pool.feeTvl30mPct * 48;
  if (!(feeYieldDailyPct >= cfg.min_fee_yield_daily_pct)) return { accepted: false, reason: "fee_yield_below_floor" };
  if (stage !== "anchor") return { accepted: false, reason: "child_stage_unsupported" };
  return { accepted: true };
}

function buildSpotRange(input: StrategyPlanInput): StrategyPlan {
  const cfg = settings();
  const entry = config().entry;
  const safetyCap = Math.max(
    entry.min_down_pct,
    Math.abs(config().manage.safety_price_crash_pct) - 10,
  );
  const downPct = Math.max(
    entry.min_down_pct,
    Math.min(cfg.anchor_range_below_pct, entry.max_down_pct, safetyCap),
  );
  const maxBinId = priceToBinId(input.entryPrice, input.candidate.pool.binStep, input.candidate.pool.decimalsX);
  let minBinId = priceToBinId(
    input.entryPrice * (1 - downPct / 100),
    input.candidate.pool.binStep,
    input.candidate.pool.decimalsX,
  );
  const maxBins = 69 * entry.max_position_accounts;
  if (maxBinId - minBinId + 1 > maxBins) minBinId = maxBinId - maxBins + 1;
  const binCount = maxBinId - minBinId + 1;
  return {
    fundingSide: "sol",
    shape: "spot",
    range: {
      minBinId,
      maxBinId,
      binCount,
      positionAccounts: Math.ceil(binCount / 69),
      bottomPricePct: (binIdToPrice(minBinId, input.candidate.pool.binStep, input.candidate.pool.decimalsX) / input.entryPrice - 1) * 100,
      topPricePct: 0,
      shape: "spot",
      fibAnchor: null,
      estBinRentSol: binArraysSpanned(minBinId, maxBinId) * 0.075,
    },
  };
}

function buildTokenRange(input: StrategyPlanInput): StrategyPlan {
  const cfg = settings();
  const entry = config().entry;
  const minBinId = priceToBinId(input.entryPrice, input.candidate.pool.binStep, input.candidate.pool.decimalsX);
  // Eys' token-side stage is a Spot deposit above the active bin. Reuse the
  // configured Eys range width; do not invent a second breakout/persistence
  // threshold or change the existing max-account cap.
  const maxByPrice = priceToBinId(
    input.entryPrice * (1 + cfg.anchor_range_below_pct / 100),
    input.candidate.pool.binStep,
    input.candidate.pool.decimalsX,
  );
  const maxBins = 69 * entry.max_position_accounts;
  const maxBinId = Math.max(minBinId + 1, Math.min(maxByPrice, minBinId + maxBins - 1));
  const binCount = maxBinId - minBinId + 1;
  return {
    fundingSide: "token",
    shape: "spot",
    range: {
      minBinId,
      maxBinId,
      binCount,
      positionAccounts: Math.ceil(binCount / 69),
      bottomPricePct: 0,
      topPricePct: (binIdToPrice(maxBinId, input.candidate.pool.binStep, input.candidate.pool.decimalsX) / input.entryPrice - 1) * 100,
      shape: "spot",
      fibAnchor: null,
      estBinRentSol: binArraysSpanned(minBinId, maxBinId) * 0.075,
    },
  };
}

/**
 * Budget for the bounded direct-enrichment path, in distinct mints per cycle.
 *
 * Measured 2026-09-22: the scan cycle runs ~65s against the 60s 1m freshness
 * window, so most of a ~140-candidate board reaches evaluation with an
 * expired row, and a 5-mint budget covered about 3% of it. Eight mints fit
 * the GMGN spend window once the 1m trending intake is down to four bands
 * (18 weight/min against a 36 weight/min window).
 */
/** Widened 8 -> 12 (09-22) -> 30 (09-23): flow_unavailable was 86% of all
 * rejections (564/658 in 30m); ~19% of scanned pools clear the 5% yield gate
 * but never got a 1m reading under a 12-slot budget. Direct-info cache-miss
 * cap (MAX_DIRECT_INFO_CALLS) raised 8 -> 16 alongside; ~19 GMGN weight-1
 * calls/min stays inside the 36/min window. */
export const EYS_REFRESH_MAX_MINTS = 30;

/** Last known 1m volume at any age; 0 when the mint carries no 1m row. */
function lastKnownOneMinuteVolume(presence?: GmgnPresence): number {
  const volumeUsd = Number(presence?.tokenByInterval.get("1m")?.volumeUsd);
  return Number.isFinite(volumeUsd) && volumeUsd > 0 ? volumeUsd : 0;
}

interface EysRefreshRow {
  candidate: Candidate;
  mint: string;
  lastFlowUsd: number;
  observedAtMs: number;
}

/**
 * Which distinct mints receive the refresh budget this cycle, highest priority
 * first:
 *   1. qualifier — a stale 1m row whose last reading already cleared the flow
 *      floor: one refresh turns it into a proposal this cycle;
 *   2. observed — no presence this cycle but a session observation inside the
 *      freshness window: recent proof the token was trading;
 *   3. coverage — never seen at all: without a slot it stays
 *      `flow_unavailable` forever;
 *   4. known-low — present but sub-floor: refreshed last, only if slots remain.
 *
 * Sibling pools collapse to one mint so no slot is spent twice.
 */
export function selectEysRefreshMints(input: {
  candidates: readonly Candidate[];
  gmgnByMint: ReadonlyMap<string, GmgnPresence>;
  observedAtByPool: ReadonlyMap<string, number>;
  floorUsd: number;
  nowMs?: number;
  budget?: number;
}): string[] {
  const nowMs = input.nowMs ?? Date.now();
  const budget = input.budget ?? EYS_REFRESH_MAX_MINTS;
  const byMint = new Map<string, EysRefreshRow>();
  for (const candidate of input.candidates) {
    if (gmgnOneMinuteFlow(input.gmgnByMint.get(candidate.tokenMint), nowMs, GMGN_ONE_MINUTE_FRESHNESS_MS)) continue;
    const row: EysRefreshRow = {
      candidate,
      mint: candidate.tokenMint,
      lastFlowUsd: lastKnownOneMinuteVolume(input.gmgnByMint.get(candidate.tokenMint)),
      observedAtMs: input.observedAtByPool.get(candidate.pool.address) ?? 0,
    };
    const previous = byMint.get(row.mint);
    if (
      !previous
      || row.lastFlowUsd > previous.lastFlowUsd
      || (row.lastFlowUsd === previous.lastFlowUsd && row.observedAtMs > previous.observedAtMs)
    ) {
      byMint.set(row.mint, row);
    }
  }
  const distinct = [...byMint.values()];
  const qualifier = distinct.filter((row) => row.lastFlowUsd >= input.floorUsd)
    .sort((a, b) => b.lastFlowUsd - a.lastFlowUsd || b.observedAtMs - a.observedAtMs);
  const observed = distinct.filter((row) => row.lastFlowUsd === 0 && row.observedAtMs > 0)
    .sort((a, b) => b.observedAtMs - a.observedAtMs);
  const coverage = distinct.filter((row) => row.lastFlowUsd === 0 && row.observedAtMs === 0)
    .sort((a, b) => b.candidate.score - a.candidate.score);
  const knownLow = distinct.filter((row) => row.lastFlowUsd > 0 && row.lastFlowUsd < input.floorUsd)
    .sort((a, b) => b.observedAtMs - a.observedAtMs || b.candidate.score - a.candidate.score);
  return [...qualifier, ...observed, ...coverage, ...knownLow]
    .slice(0, budget)
    .map((row) => row.mint);
}

export const eysPlugin: StrategyPlugin = {
  id: "eys",
  admissionClass: "strategy",

  async discover(context: StrategyDiscoveryContext): Promise<StrategyProposal[]> {
    const cfg = settings();
    if (!cfg.enabled) return [];

    // Exact candidates may be absent from trending, or their 1m evidence may
    // have expired during scanner enrichment (a ~65s cycle outruns the 60s
    // freshness window). Refresh a budgeted, prioritised set of unique mints
    // through the existing provider path; never re-stamp an old row.
    const nowMs = Date.now();
    const recentObservedAtByPool = new Map<string, number>();
    const observationCutoff = nowMs - GMGN_ONE_MINUTE_FRESHNESS_MS;
    for (const row of loadRows()) {
      if (row.tsMs < observationCutoff || row.tsMs > nowMs) continue;
      const previous = recentObservedAtByPool.get(row.poolAddress) ?? 0;
      if (row.tsMs > previous) recentObservedAtByPool.set(row.poolAddress, row.tsMs);
    }
    const refreshMints = selectEysRefreshMints({
      candidates: context.candidates,
      gmgnByMint: context.gmgnByMint,
      observedAtByPool: recentObservedAtByPool,
      floorUsd: effectiveEysFlowFloorUsd(cfg.flow_floor_usd),
      nowMs,
    });
    let direct = new Map<string, import("../scanner/gmgn.js").GmgnPresence>();
    if (refreshMints.length > 0) {
      try {
        direct = await tokenInfoByMint(refreshMints);
      } catch {
        // Missing enrichment is not trusted; candidates without a 1m mark stay out.
      }
    }
    const gmgnByMint = mergeGmgnPresenceMaps(context.gmgnByMint, direct);
    const evaluated = await mapLimit(context.candidates, async (candidate): Promise<StrategyProposal | null> => {
      const presence = gmgnByMint.get(candidate.tokenMint);
      const flow = gmgnOneMinuteFlow(presence, Date.now(), GMGN_ONE_MINUTE_FRESHNESS_MS);
      if (!flow || !presence) {
        const observedAtMs = presence?.fetchedAtMsByInterval.get("1m");
        const row = presence?.tokenByInterval.get("1m");
        const stale = row != null && Number.isFinite(row.volumeUsd) && row.volumeUsd > 0 &&
          observedAtMs != null && Number.isFinite(observedAtMs) &&
          (observedAtMs > Date.now() || Date.now() - observedAtMs > GMGN_ONE_MINUTE_FRESHNESS_MS);
        recordEysRejection(candidate, stale ? "flow_stale" : "flow_unavailable", {
          exactPool: candidate.pool.address,
          flowObservedAtMs: observedAtMs ?? null,
          gmgnIntervals: [...(presence?.intervals ?? [])],
          refreshRequested: refreshMints.includes(candidate.tokenMint),
        });
        return null;
      }
      recordFlowObservation({
        poolAddress: candidate.pool.address,
        tokenMint: candidate.tokenMint,
        tsMs: flow.observedAtMs,
        flowUsdPerMin: flow.volumeUsd,
        source: flow.source,
        cadence: flow.cadence,
      });
      const priceRow = presence.tokenByInterval.get("1h") ?? presence.token;
      const priceChange = Number.isFinite(priceRow.priceChangePct1h) ? priceRow.priceChangePct1h : 0;
      // Single-position canary supports the first SOL anchor only. Hourly
      // return is evidence, never proof of an owned-anchor breakout.
      const stage: EysStage = "anchor";
      const evidence: StrategyEvidence = {
        exactPool: candidate.pool.address,
        flowUsdPerMin: flow.volumeUsd,
        flowObservedAtMs: flow.observedAtMs,
        flowSource: flow.source,
        flowCadence: flow.cadence,
        gmgnIntervals: [...presence.intervals],
        priceChangePct1h: priceChange,
      };
      const decision = evaluateEys(candidate, evidence, stage);
      if (!decision.accepted) {
        // Persist only official-flow crossings: recording every below-floor
        // candidate every minute would drown the decision ledger while still
        // leaving the important Eys bottleneck invisible.
        if (flow.volumeUsd >= cfg.flow_floor_usd) {
          recordEysRejection(candidate, decision.reason, evidence);
        }
        return null;
      }
      return {
        strategyId: "eys",
        candidate,
        stage,
        fundingSide: "sol",
        shape: "spot",
        requestedSizeSol: cfg.entry_sol,
        evidence,
      };
    }, 3);
    return evaluated.filter((proposal): proposal is StrategyProposal => proposal !== null);
  },

  evaluate(input): StrategyDecision {
    if (!input.proposal || input.proposal.strategyId !== "eys") return { accepted: false, reason: "not_eys" };
    return evaluateEys(input.candidate, input.proposal.evidence, input.proposal.stage as EysStage);
  },

  async modelGate(input: StrategyModelInput) {
    const mode = layaMode();
    if (mode === "off") return { accepted: true, reason: "laya_disabled" };

    const snapshot = modelSnapshot(input);
    const evaluation = await requestLaya(snapshot);
    const gate = decideLayaGate(mode, evaluation.result, config().laya.min_approval_probability);
    const expectedStage = input.proposal.stage === "token" ? "breakout" : input.proposal.stage;
    const stageMismatch = evaluation.result.stage != null && evaluation.result.stage !== expectedStage;
    const detail = {
      mode,
      attempted: evaluation.attempted,
      latencyMs: evaluation.latencyMs,
      model: evaluation.result.model ?? null,
      approved: evaluation.result.approved,
      approvalProbability: evaluation.result.approvalProbability ?? null,
      stage: evaluation.result.stage ?? null,
      confidence: evaluation.result.confidence ?? null,
      reason: evaluation.result.reason ?? null,
      error: evaluation.error ?? null,
      expectedStage,
      stageMismatch,
      // Domain-training label payload: the exact snapshot + questions Laya
      // saw. Persisted by the manager only for entries that actually open;
      // finalized with gold at close (laya_labels).
      state: snapshot,
      questions: buildLayaRequest(snapshot).questions,
    };
    if (!gate.accepted) return { accepted: false, reason: gate.reason, detail };
    if (mode === "gate" && stageMismatch) {
      return { accepted: false, reason: "laya_stage_mismatch", detail };
    }
    return { accepted: true, reason: mode === "shadow" ? "laya_shadow" : "laya_approved", detail };
  },

  plan(input): StrategyPlan | null {
    if (input.proposal.strategyId !== "eys" || input.proposal.stage !== "anchor" ||
        input.proposal.fundingSide !== "sol" || input.proposal.shape !== "spot") return null;
    return buildSpotRange(input);
  },

  manage(_input: StrategyMarkInput): null {
    return null;
  },
};

export function _resetEysRuntimeForTests(): void {
  resetEysObservationStoreForTests();
}
