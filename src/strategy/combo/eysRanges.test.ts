import { describe, expect, it } from "vitest";
import { planSeatRange, planTightRange } from "./eysRanges.js";
import { planDeepBidAskRange } from "./deepBidAskRange.js";
import { planApeRange } from "./apeRange.js";

describe("planSeatRange — Spot SOL-side default range", () => {
  it("is Spot, top bin = the active bin, ~range_below_pct deep, one position account", () => {
    const r = planSeatRange(0.77, 100, 6, 12, 2); // 1%-per-bin pool: 12 bins
    expect(r.shape).toBe("spot");
    expect(r.binCount).toBe(13);
    expect(r.positionAccounts).toBe(1);
    expect(r.bottomPricePct).toBeLessThan(-10);
    expect(r.bottomPricePct).toBeGreaterThan(-14);
  });
  it("a fine bin step needs more bins for the same depth", () => {
    expect(planSeatRange(0.77, 20, 6, 12, 2).binCount).toBeGreaterThan(planSeatRange(0.77, 100, 6, 12, 2).binCount);
  });
  it("is capped at the position-account ceiling", () => {
    expect(planSeatRange(0.77, 10, 6, 12, 1).binCount).toBe(69);
  });
});

describe("planTightRange — 10-20 bins", () => {
  it("builds exactly `bins` bins ending at the active bin, Spot", () => {
    const r = planTightRange(0.77, 100, 6, 15, 2);
    expect(r.binCount).toBe(15);
    expect(r.shape).toBe("spot");
    expect(r.maxBinId - r.minBinId + 1).toBe(15);
    expect(r.positionAccounts).toBe(1);
  });
  it("has the same top bin as the seat's range on the same price", () => {
    expect(planTightRange(0.77, 100, 6, 15, 2).maxBinId).toBe(planSeatRange(0.77, 100, 6, 12, 2).maxBinId);
  });
});

describe("planDeepBidAskRange — eys_dump_bonus -85..-90%", () => {
  it("is Bid-Ask and reaches about -90% on a 1%-step pool (two position accounts)", () => {
    const r = planDeepBidAskRange(0.77, 100, 6, 85, 90, 4);
    expect(r.shape).toBe("bidask");
    expect(r.bottomPricePct).toBeLessThanOrEqual(-88);
    expect(r.bottomPricePct).toBeGreaterThanOrEqual(-91);
    expect(r.positionAccounts).toBeGreaterThanOrEqual(2);
  });
  it("is capped by the account ceiling (shallower than the target)", () => {
    const r = planDeepBidAskRange(0.77, 100, 6, 85, 90, 1);
    expect(r.binCount).toBe(69);
    expect(r.bottomPricePct).toBeGreaterThan(-60);
  });
});

describe("planApeRange — token-sided above price (breakout and ape)", () => {
  it("sits above the active bin", () => {
    const r = planApeRange(0.77, 100, 6, 50, 2);
    expect(r.minBinId).toBeGreaterThanOrEqual(planSeatRange(0.77, 100, 6, 12, 2).maxBinId);
  });
});
