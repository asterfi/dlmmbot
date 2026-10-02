/**
 * Eys SOL-side Spot range builders (always Spot per Eys: "I always enter first
 * with Spot SOL-side using the default range... safest").
 *
 *  - planSeatRange: the DEFAULT range — `rangeBelowPct` below price (config
 *    combo.eys_seat_range_below_pct, 12, mirroring the Spot majors range), top
 *    bin = the active bin. A SOL-only deposit can only fund bins at/below the
 *    active bin, so nothing is planned above it.
 *  - planTightRange: the tight 10-20 bin variant (config combo.eys_tight_bins, 15).
 *
 * Both reuse the main planner's bin-math helpers.
 */
import { binArraysSpanned, binIdToPrice, priceToBinId } from "../../ranges/planner.js";
import type { RangePlan } from "../../types.js";

const BINS_PER_POSITION = 69;
const BIN_ARRAY_RENT_SOL = 0.075;

function build(
  minBinId: number, maxBinId: number, centerPrice: number, binStep: number, decimalsX: number,
): RangePlan {
  const binCount = maxBinId - minBinId + 1;
  return {
    minBinId,
    maxBinId,
    binCount,
    positionAccounts: Math.ceil(binCount / BINS_PER_POSITION),
    bottomPricePct: (binIdToPrice(minBinId, binStep, decimalsX) / centerPrice - 1) * 100,
    shape: "spot",
    fibAnchor: null,
    estBinRentSol: binArraysSpanned(minBinId, maxBinId) * BIN_ARRAY_RENT_SOL,
  };
}

export function planSeatRange(
  currentPrice: number, binStep: number, decimalsX: number, rangeBelowPct: number, maxPositionAccounts: number,
): RangePlan {
  const activeBin = priceToBinId(currentPrice, binStep, decimalsX);
  const belowBins = Math.max(1, Math.round(rangeBelowPct / (binStep / 100)));
  let minBinId = activeBin - belowBins;
  const maxBins = BINS_PER_POSITION * maxPositionAccounts;
  if (activeBin - minBinId + 1 > maxBins) minBinId = activeBin - maxBins + 1;
  return build(minBinId, activeBin, currentPrice, binStep, decimalsX);
}

export function planTightRange(
  currentPrice: number, binStep: number, decimalsX: number, bins: number, maxPositionAccounts: number,
): RangePlan {
  const activeBin = priceToBinId(currentPrice, binStep, decimalsX);
  const n = Math.max(2, Math.min(bins, BINS_PER_POSITION * maxPositionAccounts));
  return build(activeBin - n + 1, activeBin, currentPrice, binStep, decimalsX);
}
