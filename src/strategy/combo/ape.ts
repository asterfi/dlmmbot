/**
 * eys_ape — fourth combo play (owner addition, 2026-10-01 scope expansion).
 * Source: Eys's "0.1->10 SOL" $CTO article (x.com/Eyyyys/status/2095105638691115164).
 *
 * Discovery: Stonks Launchpad "graduated" tokens (src/scanner/stonkfun.ts,
 * ported read-only from hermes-projects/dlmmbot). Pool selection is NOT
 * re-derived here: a Stonks mint is only considered when it ALSO appears in
 * our own Meteora DLMM scanner sweep (scanner/scan.ts), which already picks
 * the deepest/best-fee pool per token (STRATEGY.md §1 step 3) — reusing that
 * machinery instead of building a second mint->pool resolver. A Stonks token
 * whose only venue is a DAMM v2 pool (no DLMM pool) never reaches this
 * classifier, since the bot only trades DLMM; this is a deliberate scoping
 * choice, documented rather than silently narrowing the Stonks universe.
 *
 * "Fees paid in SOL": Meteora DLMM pools expose this directly as
 * `collect_fee_mode` (our own PoolInfo.feesBothTokens = false means
 * quote-only/SOL fees) — the SAME field STRATEGY.md §2.1's `fee_collection`
 * gate already reads. It is always knowable for a DLMM pool our own scanner
 * has already fetched, so the "if detectable, require it" branch is the one
 * that always fires for real candidates; the fallback (fee-flow floor,
 * `fee_mode_unknown`) exists for completeness / defensive callers only.
 */

export interface ApeCandidateFeatures {
  /** Can we tell this pool's fee-collection mode? Always true for a DLMM pool fetched via our own scanner. */
  feeModeKnown: boolean;
  /** True = fees are paid out quote-only (SOL) — Eys's "even if it rugs I still earn SOL fees". */
  quoteOnlyFee: boolean;
  /** Fallback signal when feeModeKnown is false: lifetime fees earned in the pool, SOL. */
  feesEarnedPoolSol: number | null;
  /** Can a token-sided range be built above current price within bin/rent caps? */
  oneSidedFeasible: boolean;
}

export interface ApeConfigLike {
  ape_fee_min_sol: number;
}

export interface ApeClassification {
  play: "eys_ape";
  reasons: string[];
  /** True when this candidate was accepted via the fallback (fee mode not detectable), not the direct SOL-fee-mode check. */
  feeModeUnknown: boolean;
}

export function classifyApe(f: ApeCandidateFeatures, c: ApeConfigLike): ApeClassification | null {
  if (!f.oneSidedFeasible) return null;
  if (f.feeModeKnown) {
    if (!f.quoteOnlyFee) return null; // required when detectable (owner's instruction)
    return { play: "eys_ape", reasons: ["pool fee-collection mode is quote-only (SOL fees)"], feeModeUnknown: false };
  }
  if (f.feesEarnedPoolSol === null || f.feesEarnedPoolSol < c.ape_fee_min_sol) return null;
  return {
    play: "eys_ape",
    feeModeUnknown: true,
    reasons: [`fee_mode_unknown — fallback: fees earned ${f.feesEarnedPoolSol.toFixed(2)} SOL >= ${c.ape_fee_min_sol} SOL floor`],
  };
}
