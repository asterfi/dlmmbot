/**
 * eys_ape range builder — token-sided, ABOVE current price (sells into the
 * pump, earning SOL fees as it does). Bottom = current price, top = current
 * price * (1 + ape_range_up_pct%) — or, when `bins` is given, Meteora's
 * default range of that many bins above price (combo.ape_bins) — capped by the
 * usual bin-account ceiling. Spot per Eys ("For pumping tokens, I always use
 * Spot"). Reuses the main planner's bin-math helpers, same pattern as
 * deepBidAskRange.ts.
 */
import { binArraysSpanned, binIdToPrice, priceToBinId } from "../../ranges/planner.js";
import type { RangePlan } from "../../types.js";

const BINS_PER_POSITION = 69;
const BIN_ARRAY_RENT_SOL = 0.075;

export function planApeRange(
  currentPrice: number,
  binStep: number,
  decimalsX: number,
  upPct: number,
  maxPositionAccounts: number,
  bins?: number,
): RangePlan {
  const minBinId = priceToBinId(currentPrice, binStep, decimalsX);
  let maxBinId = bins !== undefined && bins > 0
    ? minBinId + bins - 1
    : priceToBinId(currentPrice * (1 + upPct / 100), binStep, decimalsX);

  const maxBins = BINS_PER_POSITION * maxPositionAccounts;
  if (maxBinId - minBinId + 1 > maxBins) maxBinId = minBinId + maxBins - 1;

  const binCount = maxBinId - minBinId + 1;
  return {
    minBinId,
    maxBinId,
    binCount,
    positionAccounts: Math.ceil(binCount / BINS_PER_POSITION),
    bottomPricePct: 0, // range bottom = current price (token side starts selling immediately on any uptick)
    topPricePct: (binIdToPrice(maxBinId, binStep, decimalsX) / currentPrice - 1) * 100,
    shape: "spot",
    fibAnchor: null,
    estBinRentSol: binArraysSpanned(minBinId, maxBinId) * BIN_ARRAY_RENT_SOL,
  };
}
