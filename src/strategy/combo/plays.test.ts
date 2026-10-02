/**
 * Eys-only play classification (owner, 2026-10-03). Each trigger, the dynamic
 * volume bar math, the fake-volume ratio, priority resolution, legacy labels.
 */
import { describe, expect, it } from "vitest";
import type { Candle } from "../../scanner/meteora.js";
import {
  classifyAllPlays, classifyPlay, pickByPriority, dynamicVolFloor, eysVolTier, feePerMusd,
  lastCandleSpikePct, hasMajorDump, recentRangePct, volumePeakDropPct, belowAthPct,
  isKnownPlay, isTokenSidedPlay, DEFAULT_PLAY_PRIORITY,
  type ComboConfigLike, type PlayCandidateFeatures,
} from "./plays.js";

const CFG: ComboConfigLike = {
  eys_mcap_min_usd: 100_000,
  eys_fees_earned_min_sol: 10,
  eys_flow_usd_per_min_min: 100_000,
  eys_vol_hard_usd_per_min: 100_000,
  eys_vol_accel_min: 2,
  eys_fee_per_musd_min: 10,
  eys_breakout_mult: 3,
  eys_breakout_spike_pct: 10,
  eys_tight_observe_min: 2,
  eys_dump_peak_drop_pct: 50,
  eys_dump_ath_within_pct: 20,
};

function feats(over: Partial<PlayCandidateFeatures> = {}): PlayCandidateFeatures {
  return {
    mcapUsd: 400_000, tokenAgeMinutes: 60, tvlUsd: 100_000, vol30mUsd: 0, vol1hUsd: 0, feeTvl24hPct: 10,
    feesEarnedPoolSol: 30, devFeesKnownZero: false, flowUsdPerMin: 150_000, volAccel: 3,
    dynamicVolFloor: null, oneSidedFeasible: true, openPlaysOnToken: [], seat: null, price: 1,
    spike5mPct: 0, observedMin: 0, noMajorDump: true, choppy: false, volPeakDropPct: null, athBelowPct: null,
    ...over,
  };
}
const playsOf = (f: PlayCandidateFeatures, c = CFG) => classifyAllPlays(f, c).map((x) => x.play);
const candle = (open: number, high: number, low: number, close: number, volume = 1): Candle =>
  ({ timestamp: 0, open, high, low, close, volume });

describe("plays: labels and sidedness", () => {
  it("retired plays are NOT known (they load as read-only labels, never drive behaviour)", () => {
    expect(isKnownPlay("molu_ladder")).toBe(false);
    expect(isKnownPlay("danko_trap")).toBe(false);
    expect(isKnownPlay(null)).toBe(false);
    for (const p of DEFAULT_PLAY_PRIORITY) expect(isKnownPlay(p)).toBe(true);
  });
  it("breakout and ape are token-sided; the rest are SOL-side", () => {
    expect(isTokenSidedPlay("eys_breakout")).toBe(true);
    expect(isTokenSidedPlay("eys_ape")).toBe(true);
    for (const p of ["eys_seat", "eys_tight", "eys_dump_bonus"] as const) expect(isTokenSidedPlay(p)).toBe(false);
  });
});

describe("dynamicVolFloor — max(static floor, market percentile), soft tier closed when blind", () => {
  const opts = { staticFloor: 15_000, hard: 100_000, percentile: 0.8, minSamples: 5 };

  it("uses the 80th percentile when it exceeds the static floor", () => {
    const r = dynamicVolFloor([10_000, 20_000, 30_000, 40_000, 50_000, 60_000], opts);
    // sorted idx (n-1)*0.8 = 4 -> exactly 50k
    expect(r.percentileValue).toBeCloseTo(50_000, 6);
    expect(r.floor).toBeCloseTo(50_000, 6);
    expect(r.samples).toBe(6);
  });
  it("interpolates between ranks", () => {
    const r = dynamicVolFloor([0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000], opts);
    // idx 6*0.8 = 4.8 -> 40k + 0.8*(50k-40k) = 48k
    expect(r.percentileValue).toBeCloseTo(48_000, 6);
  });
  it("never goes below the static floor", () => {
    const r = dynamicVolFloor([100, 200, 300, 400, 500], opts);
    expect(r.floor).toBe(15_000);
  });
  it("is OFF (null) when the floor reaches the hard tier", () => {
    const r = dynamicVolFloor([90_000, 100_000, 110_000, 120_000, 130_000], opts);
    expect(r.percentileValue).toBeGreaterThanOrEqual(100_000);
    expect(r.floor).toBeNull();
  });
  it("is OFF with fewer than minSamples trending tokens (blind market read)", () => {
    expect(dynamicVolFloor([50_000, 60_000, 70_000], opts)).toEqual({ floor: null, percentileValue: null, samples: 3 });
  });
  it("ignores non-finite and negative samples", () => {
    const r = dynamicVolFloor([NaN, -5, Infinity, 10_000, 20_000, 30_000, 40_000, 50_000], opts);
    expect(r.samples).toBe(5);
  });
});

describe("eysVolTier", () => {
  it("hard tier at the literal 100k/min bar", () => {
    expect(eysVolTier(feats({ flowUsdPerMin: 100_000 }), CFG)).toEqual({ tier: "hard", threshold: 100_000 });
  });
  it("soft tier: between the dynamic floor and the hard tier AND vol_accel >= 2", () => {
    expect(eysVolTier(feats({ flowUsdPerMin: 60_000, dynamicVolFloor: 40_000, volAccel: 2 }), CFG))
      .toEqual({ tier: "soft", threshold: 40_000 });
  });
  it("soft tier needs acceleration: accel just under 2.0 (or unknown) is not offered", () => {
    expect(eysVolTier(feats({ flowUsdPerMin: 60_000, dynamicVolFloor: 40_000, volAccel: 1.99 }), CFG)).toBeNull();
    expect(eysVolTier(feats({ flowUsdPerMin: 60_000, dynamicVolFloor: 40_000, volAccel: null }), CFG)).toBeNull();
  });
  it("below the floor, or with the soft tier off, is no tier", () => {
    expect(eysVolTier(feats({ flowUsdPerMin: 30_000, dynamicVolFloor: 40_000, volAccel: 5 }), CFG)).toBeNull();
    expect(eysVolTier(feats({ flowUsdPerMin: 60_000, dynamicVolFloor: null, volAccel: 5 }), CFG)).toBeNull();
  });
});

describe("eys_seat — hard gates", () => {
  it("accepts mcap>=100k, fees>=10 SOL, flow>=100k/min (hard tier, threshold recorded)", () => {
    const c = classifyPlay(feats(), CFG);
    expect(c?.play).toBe("eys_seat");
    expect(c?.volTier).toBe("hard");
    expect(c?.volThreshold).toBe(100_000);
  });
  it("records the soft tier and its floor as the threshold the seat entered under", () => {
    const c = classifyPlay(feats({ flowUsdPerMin: 60_000, dynamicVolFloor: 40_000, volAccel: 2.5 }), CFG);
    expect(c?.volTier).toBe("soft");
    expect(c?.volThreshold).toBe(40_000);
  });
  it("mcap floor, fee floor (unknown fees fail closed)", () => {
    expect(playsOf(feats({ mcapUsd: 99_999 }))).toEqual([]);
    expect(playsOf(feats({ feesEarnedPoolSol: 9.99 }))).toEqual([]);
    expect(playsOf(feats({ feesEarnedPoolSol: null }))).toEqual([]);
  });
  it("fake volume, per Eys: 500K-1M mcap with only 8-10 SOL of fees is a red flag", () => {
    // Inside the band: <= 10 SOL is fake, above 10 is fine.
    expect(playsOf(feats({ mcapUsd: 500_000, feesEarnedPoolSol: 10 }))).toEqual([]);
    expect(playsOf(feats({ mcapUsd: 700_000, feesEarnedPoolSol: 9 }))).toEqual([]);
    expect(playsOf(feats({ mcapUsd: 1_000_000, feesEarnedPoolSol: 10 }))).toEqual([]);
    expect(playsOf(feats({ mcapUsd: 700_000, feesEarnedPoolSol: 12 }))).toContain("eys_seat");
    // Above the band: fees per $1M mcap must reach 10 (the flag's lower edge at $1M).
    expect(playsOf(feats({ mcapUsd: 2_900_000, feesEarnedPoolSol: 36.5 }))).toContain("eys_seat"); // 12.6/M, real token
    expect(playsOf(feats({ mcapUsd: 5_000_000, feesEarnedPoolSol: 40 }))).toEqual([]);             // 8/M, too thin
    // Below the band, the plain 10 SOL floor rules.
    expect(playsOf(feats({ mcapUsd: 300_000, feesEarnedPoolSol: 10 }))).toContain("eys_seat");
  });
  it("feePerMusd math", () => {
    expect(feePerMusd(10, 500_000)).toBeCloseTo(20, 9);
    expect(feePerMusd(null, 500_000)).toBeNull();
    expect(feePerMusd(10, 0)).toBeNull();
  });
  it("one seat per token", () => {
    expect(playsOf(feats({ openPlaysOnToken: ["eys_seat"] }))).not.toContain("eys_seat");
  });
  it("below the volume bar nothing qualifies", () => {
    expect(playsOf(feats({ flowUsdPerMin: 99_999 }))).toEqual([]);
  });
});

describe("eys_tight — Spot SOL-side tight range", () => {
  const tightOk = { observedMin: 2.5, noMajorDump: true, choppy: true };
  it("qualifies when volume clears the seat bar, watched >= 2 min, no major dump, chopping", () => {
    expect(playsOf(feats(tightOk))).toEqual(expect.arrayContaining(["eys_seat", "eys_tight"]));
  });
  it("not before 2 minutes of observation (or unknown)", () => {
    expect(playsOf(feats({ ...tightOk, observedMin: 1.9 }))).not.toContain("eys_tight");
    expect(playsOf(feats({ ...tightOk, observedMin: null }))).not.toContain("eys_tight");
  });
  it("a major dump or a chart that is not chopping rejects it", () => {
    expect(playsOf(feats({ ...tightOk, noMajorDump: false }))).not.toContain("eys_tight");
    expect(playsOf(feats({ ...tightOk, choppy: false }))).not.toContain("eys_tight");
  });
  it("seat wins by priority on a fresh token; with the seat already open the tight entry is next", () => {
    expect(classifyPlay(feats(tightOk), CFG)?.play).toBe("eys_seat");
    expect(classifyPlay(feats({ ...tightOk, openPlaysOnToken: ["eys_seat"] }), CFG)?.play).toBe("eys_tight");
  });
  it("one tight per token", () => {
    expect(playsOf(feats({ ...tightOk, openPlaysOnToken: ["eys_tight"] }))).not.toContain("eys_tight");
  });
});

describe("eys_breakout — token-sided second position on an open seat", () => {
  const seat = { topPrice: 1.0, volThreshold: 100_000 };
  const base = { seat, openPlaysOnToken: ["eys_seat" as const], price: 1.05, flowUsdPerMin: 300_000, spike5mPct: 12 };

  it("fires when price is above the seat's top, volume >= 3x the seat's threshold, and a strong spike", () => {
    const c = classifyPlay(feats(base), CFG);
    expect(c?.play).toBe("eys_breakout");
    expect(c?.volThreshold).toBe(300_000);
  });
  it("needs an open seat at all", () => {
    expect(playsOf(feats({ ...base, seat: null, openPlaysOnToken: [] }))).not.toContain("eys_breakout");
  });
  it("needs price strictly above the seat's top", () => {
    expect(playsOf(feats({ ...base, price: 1.0 }))).not.toContain("eys_breakout");
    expect(playsOf(feats({ ...base, price: 0.99 }))).not.toContain("eys_breakout");
  });
  it("'If the volume isn't above 300K per minute, I won't use the token-sided strategy'", () => {
    expect(playsOf(feats({ ...base, flowUsdPerMin: 299_999 }))).not.toContain("eys_breakout");
  });
  it("needs a strong spike (last 5m candle >= 10%)", () => {
    expect(playsOf(feats({ ...base, spike5mPct: 9.9 }))).not.toContain("eys_breakout");
    expect(playsOf(feats({ ...base, spike5mPct: null }))).not.toContain("eys_breakout");
  });
  it("the bar is 3x whichever threshold the seat entered under (soft-tier seat at 40k -> 120k)", () => {
    const softSeat = { topPrice: 1.0, volThreshold: 40_000 };
    expect(playsOf(feats({ ...base, seat: softSeat, flowUsdPerMin: 120_000 }))).toContain("eys_breakout");
    expect(playsOf(feats({ ...base, seat: softSeat, flowUsdPerMin: 119_999 }))).not.toContain("eys_breakout");
  });
  it("outranks the seat/tight re-entry for the single remaining slot", () => {
    expect(classifyPlay(feats({ ...base, observedMin: 5, choppy: true }), CFG)?.play).toBe("eys_breakout");
  });
  it("one breakout per token", () => {
    expect(playsOf(feats({ ...base, openPlaysOnToken: ["eys_seat", "eys_breakout"] }))).not.toContain("eys_breakout");
  });
});

describe("eys_dump_bonus — wide Bid-Ask as volume fades near the ATH", () => {
  const ok = { openPlaysOnToken: ["eys_seat" as const], volPeakDropPct: 60, athBelowPct: 10 };
  it("fires on an Eys token when volume fell >= 50% off its peak while price is within 20% of the ATH", () => {
    expect(classifyPlay(feats({ ...ok, seat: null, flowUsdPerMin: 10 }), CFG)?.play).toBe("eys_dump_bonus");
  });
  it("needs an open Eys position on the token", () => {
    expect(playsOf(feats({ ...ok, openPlaysOnToken: [], flowUsdPerMin: 10 }))).not.toContain("eys_dump_bonus");
  });
  it("boundaries: peak drop 50, ATH within 20", () => {
    expect(playsOf(feats({ ...ok, volPeakDropPct: 49.9, flowUsdPerMin: 10 }))).not.toContain("eys_dump_bonus");
    expect(playsOf(feats({ ...ok, volPeakDropPct: 50, flowUsdPerMin: 10 }))).toContain("eys_dump_bonus");
    expect(playsOf(feats({ ...ok, athBelowPct: 20.1, flowUsdPerMin: 10 }))).not.toContain("eys_dump_bonus");
    expect(playsOf(feats({ ...ok, athBelowPct: 20, flowUsdPerMin: 10 }))).toContain("eys_dump_bonus");
  });
  it("unknown volume/ATH reads fail closed; one bonus per token", () => {
    expect(playsOf(feats({ ...ok, volPeakDropPct: null, flowUsdPerMin: 10 }))).not.toContain("eys_dump_bonus");
    expect(playsOf(feats({ ...ok, athBelowPct: null, flowUsdPerMin: 10 }))).not.toContain("eys_dump_bonus");
    expect(playsOf(feats({ ...ok, openPlaysOnToken: ["eys_seat", "eys_dump_bonus"], flowUsdPerMin: 10 }))).not.toContain("eys_dump_bonus");
  });
  it("ranks last behind a tight re-entry (breakout > seat > tight > ape > dump bonus)", () => {
    const f = feats({ ...ok, observedMin: 5, choppy: true });
    expect(playsOf(f)).toEqual(expect.arrayContaining(["eys_tight", "eys_dump_bonus"]));
    expect(classifyPlay(f, CFG)?.play).toBe("eys_tight");
  });
});

describe("priority resolution", () => {
  it("default order is breakout > seat > tight > ape > dump bonus", () => {
    expect(DEFAULT_PLAY_PRIORITY).toEqual(["eys_breakout", "eys_seat", "eys_tight", "eys_ape", "eys_dump_bonus"]);
  });
  it("pickByPriority honours a custom list; plays missing from it rank last", () => {
    const q = [{ play: "eys_ape" as const }, { play: "eys_seat" as const }];
    expect(pickByPriority(q)?.play).toBe("eys_seat");
    expect(pickByPriority(q, ["eys_ape", "eys_seat"])?.play).toBe("eys_ape");
    expect(pickByPriority(q, ["eys_tight"])?.play).toBe("eys_ape");
    expect(pickByPriority([])).toBeNull();
  });
});

describe("candle helpers", () => {
  it("lastCandleSpikePct = close vs open of the freshest candle", () => {
    expect(lastCandleSpikePct([candle(1, 1.2, 1, 1.15)])).toBeCloseTo(15, 9);
    expect(lastCandleSpikePct([])).toBeNull();
  });
  it("hasMajorDump looks only at the last n candles", () => {
    const cs = [candle(1, 1, 0.8, 0.8), candle(1, 1.01, 1, 1.01), candle(1, 1.01, 1, 1.0)];
    expect(hasMajorDump(cs, 3, 15)).toBe(true);
    expect(hasMajorDump(cs, 2, 15)).toBe(false);
    expect(hasMajorDump(cs, 3, 25)).toBe(false);
  });
  it("recentRangePct is high-to-low of the window over the low", () => {
    expect(recentRangePct([candle(1, 1.1, 1, 1.05), candle(1.05, 1.2, 1.04, 1.1)], 2)).toBeCloseTo(20, 9);
    expect(recentRangePct([], 3)).toBeNull();
  });
  it("volumePeakDropPct: freshest volume vs the window peak (needs >= 3 candles)", () => {
    const mk = (v: number) => candle(1, 1, 1, 1, v);
    expect(volumePeakDropPct([mk(100), mk(300), mk(120)], 3)).toBeCloseTo(60, 9);
    expect(volumePeakDropPct([mk(100), mk(300)], 3)).toBeNull();
  });
  it("belowAthPct: how far price is under the window's highest high", () => {
    expect(belowAthPct([candle(1, 2, 1, 1), candle(1, 1.5, 1, 1.4)], 2, 1.6)).toBeCloseTo(20, 9);
    expect(belowAthPct([], 2, 1)).toBeNull();
  });
});
