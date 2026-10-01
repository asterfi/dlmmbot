import { getDb, logError, now } from "../db/db.js";

// StonkFun public token list — the discovery funnel for the overnight lane
// (Eys play 7, PLAY7_RESEARCH §4.1). Open API, no key, ~300 reads/min/IP, so the
// whole budget question is how OFTEN we read it, not whether we may.
//
//   "Stonks top 15 by volume" is a raw funnel input, not a trade list — the
//   research measured the live top-15 and found hollow microcaps (ZARVIS
//   mc $10.9k) and Token-2022 reward tokens carrying a transfer fee. The filters
//   below do the selection work, and the lanes downstream do the rest.
//
// Three properties this module is built around:
//
//   poll budget  one read an hour, plus one inside the pre-open window so the
//                list the lane opens from is minutes old rather than up to an
//                hour old. The caller drives the second read (only it knows the
//                window); this module enforces "at most one forced read per UTC
//                day" so a lane that ticks every 60s inside that window still
//                spends exactly one extra request.
//   durability   a restart is not a cold start: the last good list lives in
//                `meta`, and the in-memory cache is only a fast path over it.
//   fail-open    a failed, empty or malformed read returns the last known list
//                and warns — never throws, never widens admission, never stops
//                the loop. With no list at all the lane simply idles.
//
// The envelope was verified live 2026-09-29: `{data:{tokens:[...]}, meta:{...}}`.
// Four wrappers are accepted — a bare array, the live `{data:{tokens:[...]}}`,
// `{data:[...]}` (the Meteora datapi's own) and `{tokens:[...]}` — and anything
// else parses to an empty list, which idles the lane loudly instead of guessing
// at a shape.

/** Verified live 2026-09-29 (PLAY7_RESEARCH §1). `sort=volume24h` is silently invalid. */
export const STONK_TOKENS_URL =
  "https://www.stonkfun.xyz/api/public/v1/tokens?sort=volume&pageSize=15";

/** `meta` key holding the last good list, so a restart is not a cold start. */
export const STONK_CACHE_KEY = "stonkfun_last_list";

/** Response deadline. This is a background sweep, never a tick's critical path. */
const TIMEOUT_MS = 10_000;

/** Candidacy floors (PLAY7_RESEARCH §4.2) — the code defaults; `[overnight]` may override. */
export const DEFAULT_MC_MIN_USD = 100_000;
export const DEFAULT_LIQ_MIN_USD = 25_000;
/** Default cache TTL in minutes ([overnight] poll_min). */
export const DEFAULT_POLL_MIN = 60;

/** Mints must be base58 and plausibly sized before they reach a pool lookup. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface StonkRow {
  mint: string;
  symbol: string;
  status: string;
  mode: string;
  /** Token-2022 transfer fee in bps; 0 when the field is absent. */
  transferFeeBps: number;
  marketCapUsd: number;
  /** Market liquidity in USD; `null` = the API did not provide it (≠ zero — the attempt-time pool gates decide). */
  liquidityUsd: number | null;
  volume24hUsd: number;
}

export interface StonkFloors {
  mcMinUsd: number;
  liqMinUsd: number;
}

const DEFAULT_FLOORS: StonkFloors = { mcMinUsd: DEFAULT_MC_MIN_USD, liqMinUsd: DEFAULT_LIQ_MIN_USD };

/** Finite number or a fallback. Anything else (absent, string, NaN) is not coerced. */
function numOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A finite number, or null when the field is absent/unreadable ("unknown", not zero). */
function liqOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The rows, whatever wrapper the API used. Unrecognised shapes parse to empty. */
function rowList(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const wrapped = body as { data?: unknown; tokens?: unknown } | null;
  if (Array.isArray(wrapped?.data)) return wrapped.data;
  // Live envelope 2026-09-29: { data: { tokens: [...], pagination, network }, meta }.
  const data = wrapped?.data as { tokens?: unknown } | undefined;
  if (data && Array.isArray(data.tokens)) return data.tokens;
  if (Array.isArray(wrapped?.tokens)) return wrapped.tokens;
  return [];
}

/**
 * The token-2022 transfer fee in bps. Absent means 0 (the ordinary case);
 * a present-but-malformed object is NOT read as 0 — an unreadable fee is treated
 * as one we cannot clear, so the row fails the filter below rather than passing
 * on the strength of a field we could not parse.
 */
function transferFeeBps(value: unknown): number {
  if (value == null) return 0;
  if (typeof value !== "object") return Number.NaN;
  return numOr((value as { bps?: unknown }).bps, Number.NaN);
}

/**
 * Parse and structurally filter one response. Pure — no cache, no network — so
 * every filter arm is testable on its own. Structural filters only:
 *   status     must be the literal "graduated" — a bonding-curve token has no
 *              pool on our venue yet.
 *   mode       the literal "standard". The launchpad also mints Token-2022
 *              "reward" tokens, which are a different instrument.
 *   transferFee absent or 0 bps. A taxed token bleeds on entry, on exit and on
 *              every claim; there is no size at which it is worth it.
 * Numeric floors are applied by `fetchStonkTokens`, not here, so one cached read
 * serves every floor setting (they are hot-reloadable).
 */
export function parseStonkRows(body: unknown): StonkRow[] {
  const out: StonkRow[] = [];
  for (const raw of rowList(body)) {
    if (raw == null || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const mint = typeof row.mint === "string" ? row.mint : "";
    if (!MINT_RE.test(mint)) continue;
    if (row.status !== "graduated") continue;
    if (row.mode !== "standard") continue;
    const feeBps = transferFeeBps(row.transferFee);
    if (!(feeBps === 0)) continue;
    const market = (row.market ?? {}) as Record<string, unknown>;
    out.push({
      mint,
      symbol: typeof row.symbol === "string" ? row.symbol : "",
      status: row.status,
      mode: row.mode,
      transferFeeBps: feeBps,
      // mc/volume missing -> 0, which can never clear a positive floor. Liquidity
      // is the one exception: the live API leaves it null on some rows (verified
      // 2026-09-29 — the $186M flagship among them) and null means "unknown",
      // not "zero": the row passes the API-side floor and the pool's OWN venue
      // gates decide at attempt time (poolGates + the rent gate + the vet).
      marketCapUsd: numOr(market.marketCapUsd, 0),
      liquidityUsd: liqOrNull(market.liquidityUsd),
      volume24hUsd: numOr(market.volume24hUsd, 0),
    });
  }
  return out;
}

/** The numeric floors, in the order the research states them. An unknown (null) liquidity passes — see `parseStonkRows`. */
export function passesFloors(row: StonkRow, floors: StonkFloors): boolean {
  return row.marketCapUsd >= floors.mcMinUsd
    && (row.liquidityUsd == null || row.liquidityUsd >= floors.liqMinUsd);
}

interface CacheEntry {
  /** Unix seconds the list was fetched. */
  at: number;
  rows: StonkRow[];
}

/** In-memory fast path over the `meta` row; null until loaded or filled. */
let cache: CacheEntry | null = null;
/**
 * UTC day (unix-seconds / 86400) of the last forced read. The pre-open refresh
 * is one per day by construction: the caller forces on every tick inside the
 * window, and only the first of them gets past this guard.
 */
let forcedDay: number | null = null;
/** Warn at most once per process — a failing source must not flood the log. */
let warned = false;
/** Same, for the distinct condition "the read worked and the answer was empty". */
let emptyWarned = false;

/** Clear module state for tests (the `meta` row is dropped too). */
export function resetStonkfunStateForTests(): void {
  cache = null;
  forcedDay = null;
  warned = false;
  emptyWarned = false;
  try {
    getDb().prepare("DELETE FROM meta WHERE key = ?").run(STONK_CACHE_KEY);
  } catch { /* no DB open yet — nothing to clear */ }
}

/** The persisted list, loaded once per process. A malformed row is not a list. */
function persisted(): CacheEntry | null {
  if (cache) return cache;
  try {
    const row = getDb().prepare("SELECT value FROM meta WHERE key = ?").get(STONK_CACHE_KEY) as
      | { value: string }
      | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.value) as { at?: unknown; rows?: unknown };
    if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at) || !Array.isArray(parsed.rows)) return null;
    if (parsed.rows.length === 0) return null;
    cache = { at: parsed.at, rows: parsed.rows as StonkRow[] };
    return cache;
  } catch {
    return null;
  }
}

function store(entry: CacheEntry): void {
  cache = entry;
  try {
    getDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(STONK_CACHE_KEY, JSON.stringify(entry));
  } catch { /* a cache that cannot persist is still a cache for this process */ }
}

export interface StonkFetchOpts {
  /** Ask for a read regardless of TTL. Honoured at most once per UTC day. */
  force?: boolean;
  /** Cache TTL in minutes; garbage or ≤ 0 degrades to the default. */
  pollMin?: number;
  floors?: StonkFloors;
}

/**
 * The lane's only read path. Returns the filtered candidate list, or the last
 * known list when the READ FAILS. An empty answer — a successful read with
 * nothing worth trading — idles the lane for the night; it does NOT resurrect
 * yesterday's universe, because a stale top-15 is not a candidate list, and the
 * one-entry-per-token-per-day rule would otherwise re-offer yesterday's names.
 * `[]` is a valid, quiet answer. Never throws.
 */
export async function fetchStonkTokens(opts: StonkFetchOpts = {}): Promise<StonkRow[]> {
  const floors = opts.floors ?? DEFAULT_FLOORS;
  const pollMin = typeof opts.pollMin === "number" && Number.isFinite(opts.pollMin) && opts.pollMin > 0
    ? opts.pollMin
    : DEFAULT_POLL_MIN;
  const t = now();
  const cached = persisted();
  const day = Math.floor(t / 86_400);
  const due = !cached || t - cached.at >= pollMin * 60;
  const forced = opts.force === true && due === false && forcedDay !== day;

  if (!due && !forced) return (cached?.rows ?? []).filter((r) => passesFloors(r, floors));
  if (forced) forcedDay = day;

  let rows: StonkRow[] | null = null;
  try {
    const res = await fetch(STONK_TOKENS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`stonkfun tokens -> HTTP ${res.status}`);
    rows = parseStonkRows(await res.json());
  } catch (e) {
    // Fail-open: the previous list is a better answer than none, and the lane's
    // own pool gates re-check every candidate live at open.
    if (!warned) {
      warned = true;
      console.warn(`[overnight] StonkFun list unavailable — lane falls back to the last known list: ${(e as Error).message}`);
    }
    logError({
      source: "overnight",
      code: "stonkfun_fetch",
      level: "warn",
      message: `StonkFun token list fetch failed: ${(e as Error).message}`.slice(0, 800),
      err: e,
      dedupeSec: 3_600,
    });
    return (cached?.rows ?? []).filter((r) => passesFloors(r, floors));
  }

  if (rows.length > 0) {
    store({ at: t, rows });
  } else {
    // A successful read with no candidates. Stamp the read and empty the
    // universe — but never PERSIST an empty list, so a restart cannot mistake
    // "a quiet night" for "the last list we ever saw".
    cache = { at: t, rows: [] };
    if (!emptyWarned) {
      emptyWarned = true;
      console.warn("[overnight] StonkFun returned no graduated, untaxed tokens — lane idles this sweep");
    }
  }

  return rows.filter((r) => passesFloors(r, floors));
}
