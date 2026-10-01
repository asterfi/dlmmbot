/**
 * danko_trap range builder — one-sided SOL bid-ask from current price down to
 * -85%/-90% (owner's decision). Deliberately bypasses the generic planner's
 * P0-safety-margin depth cap (ranges/planner.ts clamps `maxDownPct` to
 * `|safety_price_crash_pct| - 10`, ~50% at defaults): danko_trap is meant to
 * go deeper than that. P0's rug-safety exits (pool death, price crash, TVL
 * drain, rugcheck flip, holder watch) are untouched and still fire regardless
 * of how deep the LP range itself reaches — a price crash through -60% closes
 * the position before it can trade the deeper bins, which is a legitimate
 * safety behaviour, not a contradiction of the -85/-90% range intent.
 *
 * Reuses the main planner's own bin-math helpers (priceToBinId/binIdToPrice/
 * binArraysSpanned) rather than re-deriving them.
 */
import { binArraysSpanned, binIdToPrice, priceToBinId } from "../../ranges/planner.js";
import type { RangePlan } from "../../types.js";

const BINS_PER_POSITION = 69;
const BIN_ARRAY_RENT_SOL = 0.075;

export function planDankoRange(
  currentPrice: number,
  binStep: number,
  decimalsX: number,
  downMinPct: number,
  downMaxPct: number,
  maxPositionAccounts: number,
): RangePlan {
  const maxBinId = priceToBinId(currentPrice, binStep, decimalsX);
  // Bottom-weighted toward the deep end of the band; the position itself is
  // bottom-weighted by DLMM's BidAsk strategy curve (more liquidity at the
  // range edges), which every combo play already uses.
  const targetDownPct = Math.max(downMinPct, Math.min(downMaxPct, downMaxPct));
  let minBinId = priceToBinId(currentPrice * (1 - targetDownPct / 100), binStep, decimalsX);

  const maxBins = BINS_PER_POSITION * maxPositionAccounts;
  if (maxBinId - minBinId + 1 > maxBins) minBinId = maxBinId - maxBins + 1;

  const binCount = maxBinId - minBinId + 1;
  return {
    minBinId,
    maxBinId,
    binCount,
    positionAccounts: Math.ceil(binCount / BINS_PER_POSITION),
    bottomPricePct: (binIdToPrice(minBinId, binStep, decimalsX) / currentPrice - 1) * 100,
    shape: "bidask",
    fibAnchor: null,
    estBinRentSol: binArraysSpanned(minBinId, maxBinId) * BIN_ARRAY_RENT_SOL,
  };
}
