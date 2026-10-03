/**
 * Play classification — the combo is Eys-only (owner decision, 2026-10-03,
 * re-read from Eys's "1 -> 100 SOL in 12 Days" and "0.1 -> 10 SOL ($CTO)"
 * articles; molu_ladder and danko_trap were removed outright). Pure functions:
 * given the metrics the scanner/candles already measure, decide which plays a
 * candidate qualifies for, and pick one per config play_priority.
 *
 * Plays (each recorded as positions.play):
 *  - eys_seat       Spot, SOL-side, default range, FIRST entry on a qualifying token.
 *  - eys_breakout   token-sided SECOND position on the same token while its
 *                   seat is open: price broke above the seat's top, per-minute
 *                   volume >= breakout_mult x the seat's entry threshold
 *                   (Eys: 100k -> 300k) and a strong spike.
 *  - eys_tight      Spot SOL-side tight range (10-20 bins): token watched >= 2
 *                   min, no major dump, chart still chopping in a small range.
 *  - eys_ape        token-sided fixed ticket into a SOL-fee (quote-only) pool.
 *                   Classified in ape.ts and merged in by the entry pipeline.
 *  - eys_dump_bonus wide Bid-Ask SOL-side (-85..-90%) once volume peaked/slows
 *                   while price is still near its ATH.
 */
import type { Candle } from "../../scanner/meteora.js";

export type Play = "eys_seat" | "eys_breakout" | "eys_tight" | "eys_ape" | "eys_dump_bonus";

export const KNOWN_PLAYS: readonly Play[] = ["eys_seat", "eys_breakout", "eys_tight", "eys_ape", "eys_dump_bonus"];

/**
 * Historical rows may carry retired plays ('molu_ladder', 'danko_trap'); those
 * are read-only labels. Anything that drives behaviour must go through this.
 */
export function isKnownPlay(p: unknown): p is Play {
  return typeof p === "string" && (KNOWN_PLAYS as readonly string[]).includes(p);
}

/** Token-sided plays deposit the token above price (swap SOL -> token first). */
export function isTokenSidedPlay(p: Play): boolean {
  return p === "eys_ape" || p === "eys_breakout";
}

/** Owner's slot priority: breakout (for an open seat) > seat > tight > ape > dump bonus. */
export const DEFAULT_PLAY_PRIORITY: Play[] = ["eys_breakout", "eys_seat", "eys_tight", "eys_ape", "eys_dump_bonus"];

/** hard = Eys's literal 100k/min; fee = pool paying >= eys_fee_entry_pct_per_h of TVL per hour; soft = dynamic volume floor. */
export type VolTier = "hard" | "fee" | "soft";

// ------------------------------------------------------------------ candle helpers (pure)

/** Last 5m candle's % change (close vs open) — the "strong upward spike" read. null without candles. */
export function lastCandleSpikePct(candles: Candle[]): number | null {
  const c = candles[candles.length - 1];
  if (!c || !(c.open > 0)) return null;
  return ((c.close - c.open) / c.open) * 100;
}

/** True when any of the last `n` candles fell >= pctDrop% (close vs open) — a "major dump". */
export function hasMajorDump(candles: Candle[], n: number, pctDrop: number): boolean {
  return candles.slice(-n).some((c) => c.open > 0 && ((c.close - c.open) / c.open) * 100 <= -pctDrop);
}

/** High-to-low range of the last `n` candles in % of the low — "chopping in a small range". null if unknowable. */
export function recentRangePct(candles: Candle[], n: number): number | null {
  const w = candles.slice(-n);
  if (w.length === 0) return null;
  const hi = Math.max(...w.map((c) => c.high));
  const lo = Math.min(...w.map((c) => c.low));
  return lo > 0 ? ((hi - lo) / lo) * 100 : null;
}

/**
 * Volume peak vs now over the last `n` candles: how far the freshest candle's
 * volume sits below the window's peak (%). null with too few candles.
 */
export function volumePeakDropPct(candles: Candle[], n: number): number | null {
  const w = candles.slice(-n);
  if (w.length < 3) return null;
  const peak = Math.max(...w.map((c) => c.volume));
  if (!(peak > 0)) return null;
  return (1 - w[w.length - 1]!.volume / peak) * 100;
}

/** How far `price` sits below the highest high of the last `n` candles (%). null without candles. */
export function belowAthPct(candles: Candle[], n: number, price: number): number | null {
  const w = candles.slice(-n);
  if (w.length === 0 || !(price > 0)) return null;
  const ath = Math.max(...w.map((c) => c.high));
  return ath > 0 ? Math.max(0, ((ath - price) / ath) * 100) : null;
}

// ------------------------------------------------------------------ dynamic volume bar

export interface DynamicVolFloor {
  /** Soft-tier floor in USD/min, or null when the soft tier is off (too few samples / floor >= hard tier). */
  floor: number | null;
  /** The market percentile value itself (null with too few samples). */
  percentileValue: number | null;
  samples: number;
}

/**
 * Owner's "sweet spot... make it dynamic": soft floor = max(static floor, the
 * `percentile` of per-minute volume among current GMGN 5m trending tokens with
 * mcap >= $100k). Soft tier is OFF when the market read is blind (fewer than
 * `minSamples` tokens) or the resulting floor is not below the hard tier.
 */
export function dynamicVolFloor(
  perMinVols: number[],
  opts: { staticFloor: number; hard: number; percentile?: number; minSamples?: number },
): DynamicVolFloor {
  const p = opts.percentile ?? 0.8;
  const minSamples = opts.minSamples ?? 5;
  const v = perMinVols.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (v.length < minSamples) return { floor: null, percentileValue: null, samples: v.length };
  const pos = (v.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const pv = v[lo]! + (v[hi]! - v[lo]!) * (pos - lo);
  const floor = Math.max(opts.staticFloor, pv);
  return { floor: floor < opts.hard ? floor : null, percentileValue: pv, samples: v.length };
}

// ------------------------------------------------------------------ features / config

export interface SeatContext {
  /** Price just above the seat's top bin (one bin above its entry price). */
  topPrice: number;
  /** The per-minute volume threshold the seat entered under (hard tier, or the soft floor at the time). */
  volThreshold: number;
}

export interface PlayCandidateFeatures {
  mcapUsd: number;
  /** Mint age in minutes; null = unknown. */
  tokenAgeMinutes: number | null;
  tvlUsd: number;
  vol30mUsd: number;
  vol1hUsd: number;
  feeTvl24hPct: number;
  /** Lifetime fees the pool has earned, in SOL (approximation, see loop.ts); null = unknown, fails closed. */
  feesEarnedPoolSol: number | null;
  /** True only when the dev's fee share is known to be exactly zero. */
  devFeesKnownZero: boolean;
  /** Freshest per-minute volume in USD (GMGN 1m/5m, else the freshest datapi 5m candle, else the 30m average). */
  flowUsdPerMin: number;
  /** flowUsdPerMin over the pool's trailing per-minute average (4h, else 1h). null = unknown. */
  volAccel?: number | null;
  /** Pool fees over the last 30m as % of TVL (datapi). x2 = per hour: can it pay our target soon? */
  feeTvl30mPct?: number | null;
  /** Current dynamic soft floor (null = soft tier off). */
  dynamicVolFloor?: number | null;
  /** Can a one-sided bid-ask/spot range actually be built within the bin/rent caps? */
  oneSidedFeasible: boolean;
  /** Plays already OPEN on this token (any play). */
  openPlaysOnToken?: Play[];
  /** The token's open eys_seat, if any (eys_breakout needs it). */
  seat?: SeatContext | null;
  /** Current price (entry price) for the breakout trigger. */
  price?: number;
  /** Last 5m candle % change. */
  spike5mPct?: number | null;
  /** Minutes our own DB has been seeing this token (eys_tight). */
  observedMin?: number | null;
  /** No 5m candle <= -eys_tight_dump_pct inside the observation window. */
  noMajorDump?: boolean;
  /** Last candles chopping inside eys_tight_range_max_pct. */
  choppy?: boolean;
  /** eys_dump_bonus: how far the freshest candle's volume is below its window peak (%). */
  volPeakDropPct?: number | null;
  /** eys_dump_bonus: how far price sits below the window's ATH (%). */
  athBelowPct?: number | null;
}

export interface ComboConfigLike {
  eys_mcap_min_usd: number;
  eys_fees_earned_min_sol: number;
  /** Literal "ape immediately" tier (Eys: 100k/min). */
  eys_flow_usd_per_min_min: number;
  eys_vol_hard_usd_per_min?: number;
  eys_vol_accel_min?: number;
  /** Soft tier also needs the pool to be paying >= this % of its TVL per hour (fee/TVL 30m x 2). */
  eys_soft_fee_tvl_per_hour_min?: number;
  /** Fee tier: a pool paying >= this % of its TVL per hour qualifies whatever its volume (0/unset = off). */
  eys_fee_entry_pct_per_h?: number;
  /** Fake-volume rule: lifetime fees (SOL) per $1M of mcap must reach this. */
  eys_fee_per_musd_min?: number;
  /** Eys's red-flag band: inside [lo, hi] mcap, fees must be strictly above 10 SOL. */
  eys_reject_mcap_lo_usd?: number;
  eys_reject_mcap_hi_usd?: number;
  eys_breakout_mult?: number;
  eys_breakout_spike_pct?: number;
  eys_tight_observe_min?: number;
  eys_dump_peak_drop_pct?: number;
  eys_dump_ath_within_pct?: number;
  play_priority?: Play[];
}

export interface PlayClassification {
  play: Play;
  reasons: string[];
  /** SOL-side entry tier the volume qualified under (eys_seat / eys_tight). */
  volTier?: VolTier;
  /** The per-minute threshold the candidate cleared (stored so a later breakout can demand 3x it). */
  volThreshold?: number;
}

const hardTier = (c: ComboConfigLike) => c.eys_vol_hard_usd_per_min ?? c.eys_flow_usd_per_min_min;

/** Fees (SOL) per $1M of mcap — null when mcap or fees are unknown. */
export function feePerMusd(feesEarnedPoolSol: number | null, mcapUsd: number): number | null {
  if (feesEarnedPoolSol === null || !(mcapUsd > 0)) return null;
  return feesEarnedPoolSol / (mcapUsd / 1_000_000);
}

/**
 * Entry tier: hard (>= literal volume bar), fee (pool paying >= eys_fee_entry_pct_per_h
 * of TVL per hour, any volume), soft (>= dynamic volume floor AND fee floor), else null.
 */
export function eysVolTier(
  f: PlayCandidateFeatures, c: ComboConfigLike,
): { tier: VolTier; threshold: number } | null {
  const hard = hardTier(c);
  if (f.flowUsdPerMin >= hard) return { tier: "hard", threshold: hard };
  const feePerHour = f.feeTvl30mPct != null ? f.feeTvl30mPct * 2 : null;
  // Fee tier (owner, 2026-10-03): what pays an LP is fees relative to the pool, not
  // raw volume. Backtest over 46h of pool snapshots (69-bin seat): pools paying
  // >= 5%/h won ~83% of seats; below 3%/h fees did not cover dumps + costs.
  // Threshold stays the hard bar so a later breakout still needs Eys's 300k/min.
  const feeEntry = c.eys_fee_entry_pct_per_h ?? 0;
  if (feeEntry > 0 && feePerHour != null && feePerHour >= feeEntry) return { tier: "fee", threshold: hard };
  const floor = f.dynamicVolFloor;
  // Soft tier (owner, 2026-10-03: "find a sweet spot… make it dynamic"): volume above the
  // market-relative floor AND the pool actually paying LPs fast enough to reach our target
  // (fee/TVL per hour). Acceleration is optional (eys_vol_accel_min, 0 = off).
  const feeOk = (c.eys_soft_fee_tvl_per_hour_min ?? 0) <= 0 || (feePerHour != null && feePerHour >= (c.eys_soft_fee_tvl_per_hour_min ?? 0));
  if (floor != null && floor < hard && f.flowUsdPerMin >= floor && feeOk && (f.volAccel ?? 0) >= (c.eys_vol_accel_min ?? 2)) {
    return { tier: "soft", threshold: floor };
  }
  return null;
}

function tierReason(f: PlayCandidateFeatures, tier: { tier: VolTier; threshold: number }, c: ComboConfigLike): string {
  if (tier.tier === "fee") {
    const perHour = (f.feeTvl30mPct ?? 0) * 2;
    return `pool paying ${perHour.toFixed(1)}%/h of TVL >= ${c.eys_fee_entry_pct_per_h}%/h (fee tier; flow $${f.flowUsdPerMin.toFixed(0)}/min)`;
  }
  return `flow $${f.flowUsdPerMin.toFixed(0)}/min >= $${tier.threshold.toFixed(0)}/min (${tier.tier} tier)`;
}

/** Eys's hard gates shared by every SOL-side entry: mcap, fees earned, and the fake-volume ratio. */
function eysBaseOk(f: PlayCandidateFeatures, c: ComboConfigLike): string[] | null {
  if (!(f.mcapUsd >= c.eys_mcap_min_usd)) return null;
  if (f.feesEarnedPoolSol === null) return null; // fail closed: can't verify the fee floor
  if (f.feesEarnedPoolSol < c.eys_fees_earned_min_sol) return null;
  const ratio = feePerMusd(f.feesEarnedPoolSol, f.mcapUsd);
  // "500K-1M MCAP but only around 8-10 SOL in fees... red flag" -> fees per $1M of
  // mcap must clear the ratio implied by that flag (config eys_fee_per_musd_min).
  if (c.eys_fee_per_musd_min !== undefined && (ratio === null || ratio < c.eys_fee_per_musd_min)) return null;
  // The flag itself names a band: 500K-1M mcap with 8-10 SOL is fake. Inside that
  // band, fees must be strictly above 10 SOL (the 10 SOL floor alone would admit 10.0).
  const lo = c.eys_reject_mcap_lo_usd ?? 500_000, hi = c.eys_reject_mcap_hi_usd ?? 1_000_000;
  if (f.mcapUsd >= lo && f.mcapUsd <= hi && f.feesEarnedPoolSol <= 10) return null;
  return [
    `mcap $${f.mcapUsd.toFixed(0)} >= $${c.eys_mcap_min_usd}`,
    `fees earned ${f.feesEarnedPoolSol.toFixed(2)} SOL >= ${c.eys_fees_earned_min_sol} SOL`,
    ...(ratio !== null ? [`fees ${ratio.toFixed(1)} SOL per $1M mcap`] : []),
  ];
}

function classifySeat(f: PlayCandidateFeatures, c: ComboConfigLike): PlayClassification | null {
  if (f.openPlaysOnToken?.includes("eys_seat")) return null; // one seat per token
  const base = eysBaseOk(f, c);
  if (!base) return null;
  const tier = eysVolTier(f, c);
  if (!tier) return null;
  return {
    play: "eys_seat",
    volTier: tier.tier,
    volThreshold: tier.threshold,
    reasons: [
      ...base,
      tierReason(f, tier, c),
      f.devFeesKnownZero ? "dev fees known zero" : "dev fees unknown (not a blocking gate)",
    ],
  };
}

function classifyTight(f: PlayCandidateFeatures, c: ComboConfigLike): PlayClassification | null {
  if (f.openPlaysOnToken?.includes("eys_tight")) return null;
  if (!f.oneSidedFeasible) return null;
  const base = eysBaseOk(f, c);
  if (!base) return null;
  const tier = eysVolTier(f, c);
  if (!tier) return null;
  const minObserved = c.eys_tight_observe_min ?? 2;
  if (f.observedMin == null || f.observedMin < minObserved) return null;
  if (!f.noMajorDump || !f.choppy) return null;
  return {
    play: "eys_tight",
    volTier: tier.tier,
    volThreshold: tier.threshold,
    reasons: [
      ...base,
      tierReason(f, tier, c),
      `watched ${f.observedMin.toFixed(1)}m >= ${minObserved}m, no major dump, chopping in a small range`,
    ],
  };
}

function classifyBreakout(f: PlayCandidateFeatures, c: ComboConfigLike): PlayClassification | null {
  const seat = f.seat;
  if (!seat) return null; // only ever a SECOND position on a token whose seat is open
  if (f.openPlaysOnToken?.includes("eys_breakout")) return null;
  if (!f.oneSidedFeasible) return null;
  if (f.price == null || !(f.price > seat.topPrice)) return null;
  const threshold = (c.eys_breakout_mult ?? 3) * seat.volThreshold;
  if (f.flowUsdPerMin < threshold) return null; // "If the volume isn't above 300K per minute, I won't use the token-sided strategy"
  const spikeMin = c.eys_breakout_spike_pct ?? 10;
  if (f.spike5mPct == null || f.spike5mPct < spikeMin) return null;
  return {
    play: "eys_breakout",
    volThreshold: threshold,
    reasons: [
      `price broke above the seat's top (${seat.topPrice.toPrecision(4)})`,
      `flow $${f.flowUsdPerMin.toFixed(0)}/min >= $${threshold.toFixed(0)}/min (${c.eys_breakout_mult ?? 3}x the seat's ${seat.volThreshold.toFixed(0)})`,
      `strong spike: last 5m candle +${f.spike5mPct.toFixed(1)}% >= ${spikeMin}%`,
    ],
  };
}

function classifyDumpBonus(f: PlayCandidateFeatures, c: ComboConfigLike): PlayClassification | null {
  const open = f.openPlaysOnToken ?? [];
  if (open.length === 0) return null; // a bonus ON an eys position's token
  if (open.includes("eys_dump_bonus")) return null;
  if (!f.oneSidedFeasible) return null;
  const drop = c.eys_dump_peak_drop_pct ?? 50;
  const within = c.eys_dump_ath_within_pct ?? 20;
  if (f.volPeakDropPct == null || f.volPeakDropPct < drop) return null;
  if (f.athBelowPct == null || f.athBelowPct > within) return null;
  return {
    play: "eys_dump_bonus",
    reasons: [
      `volume ${f.volPeakDropPct.toFixed(0)}% below its recent peak (>= ${drop}%)`,
      `price within ${f.athBelowPct.toFixed(0)}% of the window ATH (<= ${within}%)`,
      "bonus play: wide Bid-Ask SOL-side near the top",
    ],
  };
}

/**
 * Every SOL-side or stateful Eys play this candidate qualifies for (eys_ape is
 * classified separately in ape.ts and merged in by the entry pipeline).
 */
export function classifyAllPlays(f: PlayCandidateFeatures, c: ComboConfigLike): PlayClassification[] {
  return [classifySeat(f, c), classifyTight(f, c), classifyBreakout(f, c), classifyDumpBonus(f, c)]
    .filter((x): x is PlayClassification => x !== null);
}

/** Highest-priority entry of `qualifying` per `priority` (plays missing from the list rank last). */
export function pickByPriority<T extends { play: Play }>(qualifying: T[], priority: Play[] = DEFAULT_PLAY_PRIORITY): T | null {
  if (qualifying.length === 0) return null;
  const rank = (p: Play) => { const i = priority.indexOf(p); return i < 0 ? priority.length : i; };
  return [...qualifying].sort((a, b) => rank(a.play) - rank(b.play))[0]!;
}

/** Classify a candidate into its highest-priority qualifying play, or null if it fits none. */
export function classifyPlay(f: PlayCandidateFeatures, c: ComboConfigLike): PlayClassification | null {
  return pickByPriority(classifyAllPlays(f, c), c.play_priority);
}
