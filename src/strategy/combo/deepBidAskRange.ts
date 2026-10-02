/**
 * Deep Bid-Ask range builder — one-sided SOL bid-ask from current price down
 * to -85%/-90%. Used by eys_dump_bonus (Eys's "wide-range Bid-Ask SOL-side
 * position... around the ATH or close to the ATH... -85% to -90%... bonus
 * play"). Deliberately bypasses the generic planner's P0-safety-margin depth
 * cap (ranges/planner.ts clamps `maxDownPct` to `|safety_price_crash_pct| -
 * 10`): this play is meant to go deeper than that cap allows. The owner's rule
 * is no stop-loss, and the P0 price-crash trigger no longer applies to combo
 * positions; the other P0 triggers (pool death, TVL drain, rugcheck flip,
 * holder watch) remain active regardless of how deep the range reaches.
 *
 * Reuses the main planner's own bin-math helpers (priceToBinId/binIdToPrice/
 * binArraysSpanned) rather than re-deriving them.
 */
import { binArraysSpanned, binIdToPrice, priceToBinId } from "../../ranges/planner.js";
import type { RangePlan } from "../../types.js";

const BINS_PER_POSITION = 69;
const BIN_ARRAY_RENT_SOL = 0.075;

export function planDeepBidAskRange(
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
  // range edges).
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
