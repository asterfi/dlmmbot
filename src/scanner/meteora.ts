import { config, SOL_MINT } from "../config.js";
import { mapLimit } from "../concurrent.js";
import { logError } from "../db/db.js";
import type { PoolInfo } from "../types.js";

// Client for the Meteora DLMM data API (verified live 2026-08-07):
//   GET /pools?page=1&page_size=100&sort_by=fee_tvl_ratio_30m:desc&filter_by=tvl>5000
//   GET /pools/{address}/ohlcv?timeframe=5m
// Notes: pagination is 1-based; volume/fees/fee_tvl_ratio are objects keyed
// "30m"|"1h"|"2h"|"4h"|"12h"|"24h"; fee_tvl_ratio values are already percent.

interface RawPool {
  address: string;
  name: string;
  token_x: { address: string; symbol: string; decimals: number; holders: number; freeze_authority_disabled: boolean; price: number; market_cap: number };
  token_y: { address: string; symbol: string };
  created_at: number | null; // ms epoch
  pool_config: { bin_step: number; base_fee_pct: number; collect_fee_mode: number };
  dynamic_fee_pct: number;
  tvl: number;
  current_price: number;
  volume: Record<string, number>;
  fees: Record<string, number>;
  fee_tvl_ratio: Record<string, number>;
  is_blacklisted: boolean;
  launchpad: string;
}

export interface RawPoolExtras {
  holders: number;
  marketCapUsd: number;
  freezeAuthorityDisabled: boolean;
  launchpad: string;
  collectFeeMode: number;
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Statuses worth one more try; 404 is an answer, not a failure. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRY_BACKOFF_MS = 400;

/**
 * The datapi is the one dependency the whole bot leans on — the sweep, every
 * position mark, and the pre-open re-quote all come through here — and it had
 * no retry at all, so a single blip cost a whole sweep or a position its mark.
 * One retry on a transient status or a network throw. Deliberately one: this
 * is called on the manage tick's critical path, and a retry storm against a
 * struggling API is how the bot rate-limits itself out of seeing its own
 * positions.
 */
async function getJson<T>(path: string): Promise<T> {
  const url = `${config().apis.meteora_datapi}${path}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) return (await res.json()) as T;
      if (attempt === 0 && RETRYABLE.has(res.status)) {
        void res.body?.cancel().catch(() => {});
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }
      throw new Error(`datapi ${path} -> HTTP ${res.status}`);
    } catch (e) {
      // A thrown Error we built above is a decided failure, not a transport one.
      if (attempt > 0 || (e as Error).message?.startsWith("datapi ")) throw e;
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    }
  }
}

/**
 * Pages 2..N of a sweep do not depend on each other, but they were fetched in
 * a `for` loop, so a sweep paid the SUM of every page's latency before it
 * could score anything: 3 pages on every meme sweep, and 8 on majors
 * discovery whenever a majors slot is actually free.
 *
 * Correction worth keeping: this was first blamed for the 71.8s mean gap
 * measured between `[majors]` log lines against `interval_s = 60`. It is not
 * the cause. Those lines were `already parked` bails, which return BEFORE
 * scanMajors and issue no requests at all — so the 8-page path was not even
 * running in the window that was measured. The gap is whole-tick overrun and
 * still unexplained; do not treat it as closed.
 *
 * Page 1 still goes first — its `pages` field is what tells us how many of the
 * rest exist, so fetching it alone also stops us requesting pages that are
 * not there.
 */
async function sweepPaged(
  url: (page: number) => string,
  maxPages: number,
): Promise<Array<PoolInfo & { extras: RawPoolExtras }>> {
  const first = await getJson<{ data: RawPool[]; pages: number }>(url(1));
  const out = first.data.map(normalize);
  const last = Math.min(maxPages, first.pages || 1);
  if (last < 2) return out;
  const rest = Array.from({ length: last - 1 }, (_, i) => i + 2);
  const bodies = await mapLimit(
    rest,
    (page) => getJson<{ data: RawPool[]; pages: number }>(url(page)),
    config().scanner.datapi_concurrency ?? DEFAULT_DATAPI_CONCURRENCY,
  );
  for (const body of bodies) out.push(...body.data.map(normalize));
  return out;
}

/**
 * How many datapi requests may be in flight at once. The API publishes no
 * limit, so this is deliberately modest: the win is turning 8 round-trips into
 * 2 waves, and going wider buys little while raising the odds of the 429 the
 * bot has no budget to absorb mid-tick.
 */
export const DEFAULT_DATAPI_CONCURRENCY = 4;

function normalize(p: RawPool): PoolInfo & { extras: RawPoolExtras } {
  return {
    address: p.address,
    name: p.name,
    mintX: p.token_x.address,
    mintY: p.token_y.address,
    binStep: p.pool_config.bin_step,
    baseFeePct: p.pool_config.base_fee_pct,
    dynamicFeePct: p.dynamic_fee_pct ?? null,
    tvlUsd: p.tvl,
    price: p.current_price,
    decimalsX: p.token_x.decimals,
    marketCapUsd: p.token_x.market_cap ?? 0,
    vol30mUsd: p.volume?.["30m"] ?? 0,
    vol1hUsd: p.volume?.["1h"] ?? 0,
    vol24hUsd: p.volume?.["24h"] ?? 0,
    feeTvl30mPct: p.fee_tvl_ratio?.["30m"] ?? 0,
    feeTvl1hPct: p.fee_tvl_ratio?.["1h"] ?? 0,
    feeTvl4hPct: p.fee_tvl_ratio?.["4h"] ?? 0,
    feeTvl24hPct: p.fee_tvl_ratio?.["24h"] ?? 0,
    // collect_fee_mode: 0 = both tokens, 1 = quote only (verified on-chain 2026-08-07).
    feesBothTokens: p.pool_config.collect_fee_mode === 0,
    isBlacklisted: p.is_blacklisted !== false,
    createdAt: p.created_at ? new Date(p.created_at).toISOString() : null,
    extras: {
      holders: p.token_x.holders,
      marketCapUsd: p.token_x.market_cap,
      freezeAuthorityDisabled: p.token_x.freeze_authority_disabled,
      launchpad: p.launchpad,
      collectFeeMode: p.pool_config.collect_fee_mode,
    },
  };
}

/** Sweep high-TVL pools for majors discovery (sorted by TVL, not meme fee/TVL). */
export async function sweepMajorsPools(): Promise<Array<PoolInfo & { extras: RawPoolExtras }>> {
  const mj = config().majors;
  const filter = encodeURIComponent(`is_blacklisted=false&&tvl>${mj.tvl_min_usd}`);
  return sweepPaged(
    (page) => `/pools?page=${page}&page_size=100&sort_by=tvl:desc&filter_by=${filter}`,
    mj.discovery_pages,
  );
}

/** Sweep the top pools by 30m fee/TVL, pre-filtered by TVL floor server-side. */
export async function sweepPools(): Promise<Array<PoolInfo & { extras: RawPoolExtras }>> {
  const c = config();
  const filter = encodeURIComponent(`is_blacklisted=false&&tvl>${c.gates.tvl_min_usd}`);
  return sweepPaged(
    (page) => `/pools?page=${page}&page_size=100&sort_by=fee_tvl_ratio_30m:desc&filter_by=${filter}`,
    c.scanner.pages,
  );
}

/** Direct single-pool fetch — used by position marking; never rank-dependent. */
export async function fetchPool(address: string): Promise<(PoolInfo & { extras: RawPoolExtras }) | null> {
  try {
    const raw = await getJson<RawPool>(`/pools/${address}`);
    return normalize(raw);
  } catch (e) {
    if ((e as Error).message.includes("HTTP 404")) return null; // pool truly gone
    throw e; // transient failure — caller must NOT treat as pool death
  }
}

/** Result metadata keeps provider failures and partial page coverage visible. */
export interface TokenMintPoolResolution {
  pools: Array<PoolInfo & { extras: RawPoolExtras }>;
  attemptedMints: number;
  providerSuccessMints: number;
  emptyMints: number;
  failedMints: number;
  partialMints: number;
}

const MAX_DIRECT_POOL_PAGES = 3;
const MAX_DIRECT_POOLS_PER_MINT = 8;
const MAX_DIRECT_DATAPI_CONCURRENCY = 8;

function directDatapiConcurrency(): number {
  const configured = Number(config().scanner.datapi_concurrency ?? DEFAULT_DATAPI_CONCURRENCY);
  return Number.isInteger(configured) && configured > 0
    ? Math.min(configured, MAX_DIRECT_DATAPI_CONCURRENCY)
    : DEFAULT_DATAPI_CONCURRENCY;
}

/**
 * Resolve a bounded set of GMGN-hot token mints into exact Meteora SOL pools.
 *
 * This is supplemental Eys intake only. The result is still passed through
 * eysDiscoveryGates, exact-pool selection, vetting, quote, rent, sizing, and
 * executor checks before any mutation. Invalid, non-SOL, blacklisted, or failed
 * provider rows are omitted so one malformed response cannot widen admission.
 */
export async function fetchPoolsByTokenMints(
  mints: readonly string[],
): Promise<TokenMintPoolResolution> {
  const unique = [...new Set(mints)].filter((mint) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint));
  if (unique.length === 0) {
    return { pools: [], attemptedMints: 0, providerSuccessMints: 0, emptyMints: 0, failedMints: 0, partialMints: 0 };
  }
  const resolved = await mapLimit(
    unique,
    async (mint) => {
      try {
        const filter = encodeURIComponent(`is_blacklisted=false&&token_x=${mint}&&token_y=${SOL_MINT}`);
        const first = await getJson<{ data?: RawPool[]; pages?: number }>(
          `/pools?page=1&page_size=100&sort_by=fee_tvl_ratio_30m:desc&filter_by=${filter}`,
        );
        if (!Array.isArray(first.data)) throw new Error("datapi exact-pool response has no data array");
        const reportedPages: unknown = first.pages === undefined ? 1 : first.pages;
        if (typeof reportedPages !== "number" || !Number.isInteger(reportedPages) || reportedPages < 0) {
          throw new Error("datapi exact-pool response has invalid pages");
        }
        if (reportedPages === 0) {
          if (first.data.length !== 0) throw new Error("datapi exact-pool response has rows with zero pages");
          return { status: "ok" as const, pools: [] };
        }
        const pageCount = Math.min(reportedPages, MAX_DIRECT_POOL_PAGES);
        const rows = [...first.data];
        let partial = reportedPages > pageCount;
        for (let page = 2; page <= pageCount; page++) {
          try {
            const body = await getJson<{ data?: RawPool[] }>(
              `/pools?page=${page}&page_size=100&sort_by=fee_tvl_ratio_30m:desc&filter_by=${filter}`,
            );
            if (!Array.isArray(body.data)) throw new Error(`datapi exact-pool page ${page} has no data array`);
            rows.push(...body.data);
          } catch (error) {
            partial = true;
            logError({
              source: "scanner",
              code: "eys_pool_resolution_partial",
              level: "warn",
              message: `Eys exact-pool pagination stopped for a GMGN mint: ${(error as Error).message}`.slice(0, 800),
              detail: { mint, page },
              dedupeSec: 300,
            });
            break;
          }
        }
        const pools = rows
          .filter((pool) =>
            pool?.token_x?.address === mint &&
            pool?.token_y?.address === SOL_MINT &&
            pool?.is_blacklisted === false,
          )
          .slice(0, MAX_DIRECT_POOLS_PER_MINT)
          .map(normalize);
        const capped = rows.filter((pool) => pool?.token_x?.address === mint && pool?.token_y?.address === SOL_MINT).length > MAX_DIRECT_POOLS_PER_MINT;
        return { status: partial || capped ? "partial" as const : "ok" as const, pools };
      } catch (error) {
        logError({
          source: "scanner",
          code: "eys_pool_resolution",
          level: "warn",
          message: `Eys exact-pool resolution failed for a GMGN mint: ${(error as Error).message}`.slice(0, 800),
          detail: { mint },
          dedupeSec: 300,
        });
        return { status: "failed" as const, pools: [] };
      }
    },
    directDatapiConcurrency(),
  );
  return {
    pools: resolved.flatMap((result) => result.pools),
    attemptedMints: unique.length,
    providerSuccessMints: resolved.filter((result) => result.status !== "failed").length,
    emptyMints: resolved.filter((result) => result.status !== "failed" && result.pools.length === 0).length,
    failedMints: resolved.filter((result) => result.status === "failed").length,
    partialMints: resolved.filter((result) => result.status === "partial").length,
  };
}

export async function fetchCandles(
  poolAddress: string,
  timeframe: "1m" | "5m" | "15m" | "1h" = "5m"
): Promise<Candle[]> {
  const body = await getJson<{ data: Candle[] }>(
    `/pools/${poolAddress}/ohlcv?timeframe=${timeframe}`
  );
  return body.data ?? [];
}
