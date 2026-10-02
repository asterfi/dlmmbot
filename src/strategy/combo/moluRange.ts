/**
 * molu_ladder range builder (owner, 2026-10-03; re-read of molu's "Be the
 * House" Book 1 setup: "Deposit SOL only, range set below current price /
 * Bid-Ask shape, ~100-125 bins on a new coin"). A bin COUNT target below the
 * active bin (top bin = active bin, as before) replaces upstream's
 * min_down_pct/max_down_pct depth band, whose depth varies with bin step.
 *
 * Capped at -90% when a coarse bin step makes the target count run deeper than
 * that (the count then falls under molu_bins_min — that is the cap, not a bug),
 * and at BINS_PER_POSITION * maxPositionAccounts. 110 bins span two position
 * accounts (69 bins each); positionAccounts reports the real count so the
 * caller's affordability check prices both.
 */
import { binArraysSpanned, binIdToPrice, priceToBinId } from "../../ranges/planner.js";
import type { RangePlan } from "../../types.js";

const BINS_PER_POSITION = 69;
const BIN_ARRAY_RENT_SOL = 0.075;
const MAX_DOWN_FRAC = 0.9;

export function planMoluRange(
  currentPrice: number,
  binStep: number,
  decimalsX: number,
  binsTarget: number,
  binsMin: number,
  binsMax: number,
  maxPositionAccounts: number,
): RangePlan {
  const bins = Math.max(binsMin, Math.min(binsMax, binsTarget));
  const maxBinId = priceToBinId(currentPrice, binStep, decimalsX);
  let minBinId = maxBinId - bins + 1;

  const floor90 = priceToBinId(currentPrice * (1 - MAX_DOWN_FRAC), binStep, decimalsX);
  if (minBinId < floor90) minBinId = floor90;

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
