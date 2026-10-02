/**
 * eys_ape — fourth combo play (owner addition, 2026-10-01; widened 2026-10-02
 * per a re-read of Eys's $CTO article: he found candidates watching GMGN +
 * Meteora directly, clicking every coin posted in a DLMM Discord channel —
 * Stonks was a bonus ("fees can get huge there"), never a requirement).
 *
 * Discovery (2026-10-02): ANY candidate from the main Meteora sweep that
 * already cleared upstream's pool gates + vetting + the exclude_mints
 * stablecoin/majors filter is eligible, not just Stonks mints. Stonks-sourced
 * mints get a ranking boost (config ape_stonks_priority) since Eys called out
 * their fee flow specifically, but they are no longer the only source.
 *
 * "Fees paid in SOL": Meteora DLMM pools expose this directly as
 * `collect_fee_mode` (our own PoolInfo.feesBothTokens = false means
 * quote-only/SOL fees) — the SAME field STRATEGY.md §2.1's `fee_collection`
 * gate already reads. It is always knowable for a DLMM pool our own scanner
 * has already fetched, so the "if detectable, require it" branch is the one
 * that always fires for real candidates; the fallback (fees-earned floor +
 * `fee_mode_unknown`) exists for completeness / defensive callers only.
 */

import { feePerMusd } from "./plays.js";

export type ApeSource = "stonks" | "meteora";

export interface ApeCandidateFeatures {
  mcapUsd: number;
  /** Mint age in minutes; null (unknown) fails closed — this is a token-sided, no-stop-loss play. */
  tokenAgeMinutes: number | null;
  /** Can we tell this pool's fee-collection mode? Always true for a DLMM pool fetched via our own scanner. */
  feeModeKnown: boolean;
  /** True = fees are paid out quote-only (SOL) — Eys's "even if it rugs I still earn SOL fees". */
  quoteOnlyFee: boolean;
  /** Lifetime fees earned in the pool, SOL. Always required now (not just the fee_mode_unknown fallback). */
  feesEarnedPoolSol: number | null;
  /** Strongest available volume-rate signal, USD/min — reuses eys_seat's own flow floor. */
  flowUsdPerMin: number;
  /** Can a token-sided range be built above current price within bin/rent caps? */
  oneSidedFeasible: boolean;
  source: ApeSource;
}

export interface ApeConfigLike {
  ape_fee_min_sol: number;
  ape_age_max_h: number;
  ape_mcap_min_usd: number;
  ape_stonks_priority?: boolean;
  /** Reused: eys_seat's own high-volume floor is the ape flow requirement too. */
  eys_flow_usd_per_min_min: number;
  /** Fake-volume rule shared with the seat (fees per $1M of mcap); skipped when undefined. */
  eys_fee_per_musd_min?: number;
}

export interface ApeClassification {
  play: "eys_ape";
  reasons: string[];
  /** True when the fee-mode check used the fallback (fee mode not detectable), not the direct SOL-fee-mode check. */
  feeModeUnknown: boolean;
  source: ApeSource;
  /** Ranking boost for choosing among multiple ape-eligible candidates in the same tick (Stonks > Meteora when ape_stonks_priority). */
  priority: number;
}

export function classifyApe(f: ApeCandidateFeatures, c: ApeConfigLike): ApeClassification | null {
  if (!f.oneSidedFeasible) return null;
  if (!(f.mcapUsd >= c.ape_mcap_min_usd)) return null;
  if (f.tokenAgeMinutes === null || f.tokenAgeMinutes > c.ape_age_max_h * 60) return null;
  if (f.flowUsdPerMin < c.eys_flow_usd_per_min_min) return null;
  if (f.feesEarnedPoolSol === null || f.feesEarnedPoolSol < c.ape_fee_min_sol) return null;
  if (c.eys_fee_per_musd_min !== undefined) {
    // Eys's fake-volume red flag applies to the ape too: lots of volume, few fees for the mcap.
    const ratio = feePerMusd(f.feesEarnedPoolSol, f.mcapUsd);
    if (ratio === null || ratio < c.eys_fee_per_musd_min) return null;
  }
  if (f.feeModeKnown && !f.quoteOnlyFee) return null;

  const feeModeUnknown = !f.feeModeKnown;
  const reasons = [
    `mcap $${f.mcapUsd.toFixed(0)} >= $${c.ape_mcap_min_usd}`,
    `age ${(f.tokenAgeMinutes / 60).toFixed(1)}h <= ${c.ape_age_max_h}h`,
    `fees earned ${f.feesEarnedPoolSol.toFixed(2)} SOL >= ${c.ape_fee_min_sol} SOL`,
    `flow $${f.flowUsdPerMin.toFixed(0)}/min >= $${c.eys_flow_usd_per_min_min}/min`,
    feeModeUnknown
      ? "fee_mode_unknown — fallback: fees-earned floor already cleared above"
      : "pool fee-collection mode is quote-only (SOL fees)",
  ];
  const priority = f.source === "stonks" && c.ape_stonks_priority !== false ? 1 : 0;
  return { play: "eys_ape", reasons, feeModeUnknown, source: f.source, priority };
}

/**
 * Pure ranking for choosing among multiple ape-eligible candidates found in
 * the same tick (ape is capped at 1 concurrent, so only one can be taken).
 * Stonks-sourced candidates rank first when `ape_stonks_priority`, breaking
 * ties by the rule engine's own opportunity score. Exported for tests and for
 * the entry pipeline to sort its ape-eligible shortlist before sizing/Jev.
 */
export function compareApeCandidates(
  a: { priority: number; score: number },
  b: { priority: number; score: number },
): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return b.score - a.score;
}
