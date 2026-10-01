/**
 * Play classification — combo of Eys (fast), molu (core), and Danko (deep),
 * per the owner's decisions. Pure functions: given the metrics the scanner
 * already measures (STRATEGY.md §1-§2), decide which play (if any) a
 * candidate qualifies for. Reuses upstream's own field names/units
 * (PoolInfo, Candle, vetting facts) rather than inventing a parallel feature
 * set.
 *
 * Priority when more than one play's hard gates pass: danko_trap (strictest,
 * deepest, max 1 concurrent) > molu_ladder (core) > eys_seat (fast, widest
 * net). Checked in that order below.
 */
import type { Candle } from "../../scanner/meteora.js";
import { swing } from "../../ranges/planner.js";

export type Play = "molu_ladder" | "eys_seat" | "danko_trap" | "eys_ape";

export interface DipBounce {
  /** % the price fell from its local high within the lookback (positive number). */
  dipPct: number;
  /** % the price has bounced off its local low since (positive number). */
  bouncePct: number;
}

/**
 * dip = price fell >= dipMinPct off the local high, then bounce = price has
 * recovered >= bounceMinPct off the resulting low. Reuses planner.swing()
 * (upstream's own 5m-candle high/low reader) rather than a new indicator.
 */
export function detectDipBounce(candles: Candle[], currentPrice: number): DipBounce | null {
  const sw = swing(candles);
  if (!sw || sw.high <= 0 || sw.low <= 0 || sw.high <= sw.low) return null;
  const dipPct = ((sw.high - sw.low) / sw.high) * 100;
  const bouncePct = ((currentPrice - sw.low) / sw.low) * 100;
  if (dipPct <= 0 || bouncePct <= 0) return null;
  return { dipPct, bouncePct };
}

export interface PlayCandidateFeatures {
  mcapUsd: number;
  /** Mint age in minutes; null = unknown (treated conservatively, see each play). */
  tokenAgeMinutes: number | null;
  tvlUsd: number;
  vol30mUsd: number;
  vol1hUsd: number;
  feeTvl24hPct: number;
  /**
   * Fees the pool has earned, lifetime, in SOL. Computed in manager/loop.ts
   * from tvlUsd * feeTvl24hPct/100 (24h fee run-rate) scaled by the pool's
   * observed age in days and converted at the live SOL/USD price, clamped to
   * the pool's actual age when younger than 24h; null = unknown, which fails
   * eys_seat's fee-floor closed rather than guessing.
   */
  feesEarnedPoolSol: number | null;
  /** True only when the dev's fee share is known to be exactly zero. */
  devFeesKnownZero: boolean;
  /**
   * Flow strength in USD/min — the strongest available volume-rate signal
   * (GMGN smart-flow when present, else vol30mUsd/30 as the scanner's own
   * proxy). Compared against the configured `eys_flow_usd_per_min_min`
   * (owner's Eys threshold, default 100k USD/min) — see config.toml [combo]
   * for the documented mapping.
   */
  flowUsdPerMin: number;
  dipBounce: DipBounce | null;
  /** Can a one-sided SOL bid-ask actually be built within the bin/rent caps? */
  oneSidedFeasible: boolean;
}

export interface ComboConfigLike {
  molu_mcap_min_usd: number;
  molu_age_max_h: number;
  molu_dip_min_pct: number;
  molu_bounce_min_pct: number;
  eys_mcap_min_usd: number;
  eys_fees_earned_min_sol: number;
  eys_flow_usd_per_min_min: number;
  eys_reject_mcap_lo_usd: number;
  eys_reject_mcap_hi_usd: number;
  danko_mcap_min_usd: number;
  danko_age_min_h: number;
}

export interface PlayClassification {
  play: Play;
  reasons: string[];
}

function classifyDanko(f: PlayCandidateFeatures, c: ComboConfigLike): PlayClassification | null {
  if (!(f.mcapUsd >= c.danko_mcap_min_usd)) return null;
  if (f.tokenAgeMinutes === null || f.tokenAgeMinutes < c.danko_age_min_h * 60) return null; // unknown age fails closed
  if (!f.oneSidedFeasible) return null;
  return {
    play: "danko_trap",
    reasons: [
      `mcap $${f.mcapUsd.toFixed(0)} >= $${c.danko_mcap_min_usd}`,
      `age ${(f.tokenAgeMinutes / 60).toFixed(1)}h >= ${c.danko_age_min_h}h (proven floor)`,
    ],
  };
}

function classifyMolu(f: PlayCandidateFeatures, c: ComboConfigLike): PlayClassification | null {
  if (!(f.mcapUsd >= c.molu_mcap_min_usd)) return null;
  // Age < 48h is the molu window; unknown age is treated as young (passes this
  // gate) since the risk here is entering on the initial vertical, which the
  // dip+bounce requirement below already guards against independent of age.
  if (f.tokenAgeMinutes !== null && f.tokenAgeMinutes >= c.molu_age_max_h * 60) return null;
  if (!f.dipBounce) return null; // never enter on the initial vertical
  if (f.dipBounce.dipPct < c.molu_dip_min_pct) return null;
  if (f.dipBounce.bouncePct < c.molu_bounce_min_pct) return null;
  if (!f.oneSidedFeasible) return null;
  return {
    play: "molu_ladder",
    reasons: [
      `mcap $${f.mcapUsd.toFixed(0)} >= $${c.molu_mcap_min_usd}`,
      `dip ${f.dipBounce.dipPct.toFixed(1)}% >= ${c.molu_dip_min_pct}%`,
      `bounce ${f.dipBounce.bouncePct.toFixed(1)}% >= ${c.molu_bounce_min_pct}%`,
    ],
  };
}

function classifyEys(f: PlayCandidateFeatures, c: ComboConfigLike): PlayClassification | null {
  if (!(f.mcapUsd >= c.eys_mcap_min_usd)) return null;
  const feesKnown = f.feesEarnedPoolSol !== null;
  if (!feesKnown) return null; // fail closed: can't verify the fee floor
  if (f.feesEarnedPoolSol! < c.eys_fees_earned_min_sol) return null;
  if (f.flowUsdPerMin < c.eys_flow_usd_per_min_min) return null;
  // Reject the fake-volume band: 500k-1M mcap with less than the fee floor in
  // earned fees. feesEarnedPoolSol already cleared the floor above, so this
  // only ever rejects a candidate inside the band whose fees are STILL below
  // floor via a different unit basis — kept as an explicit, auditable check
  // rather than relying on the floor check alone to carry the intent.
  if (f.mcapUsd >= c.eys_reject_mcap_lo_usd && f.mcapUsd < c.eys_reject_mcap_hi_usd
    && f.feesEarnedPoolSol! < c.eys_fees_earned_min_sol) {
    return null;
  }
  return {
    play: "eys_seat",
    reasons: [
      `mcap $${f.mcapUsd.toFixed(0)} >= $${c.eys_mcap_min_usd}`,
      `fees earned ${f.feesEarnedPoolSol!.toFixed(2)} SOL >= ${c.eys_fees_earned_min_sol} SOL`,
      `flow $${f.flowUsdPerMin.toFixed(0)}/min >= $${c.eys_flow_usd_per_min_min}/min`,
      f.devFeesKnownZero ? "dev fees known zero" : "dev fees unknown (not a blocking gate)",
    ],
  };
}

/** Classify a candidate into a play, or null if it fits none. */
export function classifyPlay(f: PlayCandidateFeatures, c: ComboConfigLike): PlayClassification | null {
  return classifyDanko(f, c) ?? classifyMolu(f, c) ?? classifyEys(f, c);
}
