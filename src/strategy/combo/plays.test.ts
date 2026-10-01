import { describe, expect, it } from "vitest";
import { classifyPlay, detectDipBounce, detectDump, type ComboConfigLike, type PlayCandidateFeatures } from "./plays.js";
import type { Candle } from "../../scanner/meteora.js";

const CFG: ComboConfigLike = {
  molu_mcap_min_usd: 1_000_000,
  molu_age_max_h: 48,
  molu_dip_min_pct: 20,
  molu_bounce_min_pct: 5,
  eys_mcap_min_usd: 100_000,
  eys_fees_earned_min_sol: 10,
  eys_flow_usd_per_min_min: 100_000,
  eys_reject_mcap_lo_usd: 500_000,
  eys_reject_mcap_hi_usd: 1_000_000,
  danko_mcap_min_usd: 1_000_000,
  danko_age_min_h: 48,
  danko_dump_min_pct: 30,
  danko_flow_ratio_min: 0.05,
};

/** A danko-eligible feature set otherwise — dump/flow/buyers all present. */
const DANKO_OK = { dumpPct: 40, flowRatio: 0.1, buyersPresent: true };

function baseFeatures(overrides: Partial<PlayCandidateFeatures> = {}): PlayCandidateFeatures {
  return {
    mcapUsd: 0,
    tokenAgeMinutes: null,
    tvlUsd: 100_000,
    vol30mUsd: 0,
    vol1hUsd: 0,
    feeTvl24hPct: 10,
    feesEarnedPoolSol: null,
    devFeesKnownZero: false,
    flowUsdPerMin: 0,
    dipBounce: null,
    oneSidedFeasible: true,
    dumpPct: null,
    flowRatio: null,
    buyersPresent: false,
    ...overrides,
  };
}

describe("detectDipBounce", () => {
  const candle = (high: number, low: number): Candle => ({ timestamp: 0, open: high, high, low, close: low, volume: 1 });

  it("null with too few candles or no real swing", () => {
    expect(detectDipBounce([], 1)).toBeNull();
    expect(detectDipBounce([candle(1, 1), candle(1, 1)], 1)).toBeNull();
  });

  it("computes dip/bounce from swing high/low vs current price", () => {
    // swing high=1, low=0.7 -> dip = 30%; current=0.77 -> bounce off low = 10%
    // swing() needs >= 6 candles.
    const candles = [
      candle(1, 0.9), candle(0.95, 0.8), candle(0.9, 0.75), candle(0.85, 0.7),
      candle(0.8, 0.72), candle(0.78, 0.73),
    ];
    const r = detectDipBounce(candles, 0.77);
    expect(r).not.toBeNull();
    expect(r!.dipPct).toBeCloseTo(30, 0);
    expect(r!.bouncePct).toBeCloseTo(10, 0);
  });
});

describe("detectDump", () => {
  const candle = (high: number, low: number): Candle => ({ timestamp: 0, open: high, high, low, close: low, volume: 1 });
  const candles = [
    candle(1, 0.9), candle(0.95, 0.8), candle(0.9, 0.75), candle(0.85, 0.7),
    candle(0.8, 0.72), candle(0.78, 0.73),
  ];

  it("measures how far CURRENT price sits below the swing high, not the dip's full extent", () => {
    // swing high = 1; current = 0.6 -> 40% below the high, even with no bounce yet.
    const d = detectDump(candles, 0.6);
    expect(d).not.toBeNull();
    expect(d!.dumpPct).toBeCloseTo(40, 0);
  });

  it("null when price is AT or above the recent high (no dump)", () => {
    expect(detectDump(candles, 1)).toBeNull();
    expect(detectDump(candles, 1.1)).toBeNull();
  });

  it("null with too few candles for a swing", () => {
    expect(detectDump([], 0.5)).toBeNull();
  });
});

describe("classifyPlay — danko_trap", () => {
  it("accepts mcap>=1M, age>=48h, dump>=30%, flow_ratio>=0.05, buyers present", () => {
    const f = baseFeatures({ mcapUsd: 1_000_000, tokenAgeMinutes: 48 * 60, ...DANKO_OK });
    expect(classifyPlay(f, CFG)?.play).toBe("danko_trap");
  });

  it("rejects just under the mcap floor", () => {
    const f = baseFeatures({ mcapUsd: 999_999, tokenAgeMinutes: 48 * 60, ...DANKO_OK });
    expect(classifyPlay(f, CFG)?.play).not.toBe("danko_trap");
  });

  it("rejects just under the age floor (falls through to eys_seat at this mcap)", () => {
    const f = baseFeatures({
      mcapUsd: 1_000_000, tokenAgeMinutes: 48 * 60 - 1, ...DANKO_OK,
      feesEarnedPoolSol: 10, flowUsdPerMin: 100_000,
    });
    const c = classifyPlay(f, CFG);
    expect(c?.play).not.toBe("danko_trap");
  });

  it("fails closed on unknown age", () => {
    const f = baseFeatures({ mcapUsd: 5_000_000, tokenAgeMinutes: null, ...DANKO_OK });
    expect(classifyPlay(f, CFG)?.play).not.toBe("danko_trap");
  });

  it("rejects when a one-sided range can't be built", () => {
    const f = baseFeatures({ mcapUsd: 2_000_000, tokenAgeMinutes: 60 * 60, oneSidedFeasible: false, ...DANKO_OK });
    expect(classifyPlay(f, CFG)?.play).not.toBe("danko_trap");
  });

  it("fails closed when dumpPct is unknown (no candles)", () => {
    const f = baseFeatures({ mcapUsd: 2_000_000, tokenAgeMinutes: 60 * 60, ...DANKO_OK, dumpPct: null });
    expect(classifyPlay(f, CFG)?.play).not.toBe("danko_trap");
  });

  it("rejects a dump under the 30% floor (price hasn't fallen enough)", () => {
    const f = baseFeatures({ mcapUsd: 2_000_000, tokenAgeMinutes: 60 * 60, ...DANKO_OK, dumpPct: 29.9 });
    expect(classifyPlay(f, CFG)?.play).not.toBe("danko_trap");
  });

  it("fails closed when flowRatio is unknown", () => {
    const f = baseFeatures({ mcapUsd: 2_000_000, tokenAgeMinutes: 60 * 60, ...DANKO_OK, flowRatio: null });
    expect(classifyPlay(f, CFG)?.play).not.toBe("danko_trap");
  });

  it("rejects flow_ratio under the floor — a dumped pool with no live flow ('volume relative to active liquidity')", () => {
    const f = baseFeatures({ mcapUsd: 2_000_000, tokenAgeMinutes: 60 * 60, ...DANKO_OK, flowRatio: 0.049 });
    expect(classifyPlay(f, CFG)?.play).not.toBe("danko_trap");
  });

  it("rejects when buyers are not present (no bounce off the post-dump low)", () => {
    const f = baseFeatures({ mcapUsd: 2_000_000, tokenAgeMinutes: 60 * 60, ...DANKO_OK, buyersPresent: false });
    expect(classifyPlay(f, CFG)?.play).not.toBe("danko_trap");
  });
});

describe("classifyPlay — molu_ladder", () => {
  const dip = { dipPct: 25, bouncePct: 6 };

  it("accepts mcap>=1M, age<48h, dip>=20% then bounce>=5%", () => {
    const f = baseFeatures({ mcapUsd: 1_500_000, tokenAgeMinutes: 60, dipBounce: dip });
    expect(classifyPlay(f, CFG)?.play).toBe("molu_ladder");
  });

  it("rejects without a dip+bounce (never enter on the initial vertical)", () => {
    const f = baseFeatures({ mcapUsd: 1_500_000, tokenAgeMinutes: 60, dipBounce: null });
    expect(classifyPlay(f, CFG)?.play).not.toBe("molu_ladder");
  });

  it("rejects a dip under the 20% floor", () => {
    const f = baseFeatures({ mcapUsd: 1_500_000, tokenAgeMinutes: 60, dipBounce: { dipPct: 19.9, bouncePct: 10 } });
    expect(classifyPlay(f, CFG)?.play).not.toBe("molu_ladder");
  });

  it("rejects a bounce under the 5% floor", () => {
    const f = baseFeatures({ mcapUsd: 1_500_000, tokenAgeMinutes: 60, dipBounce: { dipPct: 30, bouncePct: 4.9 } });
    expect(classifyPlay(f, CFG)?.play).not.toBe("molu_ladder");
  });

  it("rejects age >= 48h (goes to danko_trap territory instead, when danko's own gates also clear)", () => {
    const f = baseFeatures({ mcapUsd: 1_500_000, tokenAgeMinutes: 48 * 60, dipBounce: dip, ...DANKO_OK });
    expect(classifyPlay(f, CFG)?.play).toBe("danko_trap");
  });
});

describe("classifyPlay — eys_seat", () => {
  it("accepts mcap>=100k, fees earned>=10 SOL, flow>=100k usd/min", () => {
    const f = baseFeatures({ mcapUsd: 150_000, feesEarnedPoolSol: 10, flowUsdPerMin: 100_000 });
    expect(classifyPlay(f, CFG)?.play).toBe("eys_seat");
  });

  it("fails closed when fees-earned is unknown", () => {
    const f = baseFeatures({ mcapUsd: 150_000, feesEarnedPoolSol: null, flowUsdPerMin: 200_000 });
    expect(classifyPlay(f, CFG)).toBeNull();
  });

  it("rejects below the fee-earned floor", () => {
    const f = baseFeatures({ mcapUsd: 150_000, feesEarnedPoolSol: 9.99, flowUsdPerMin: 200_000 });
    expect(classifyPlay(f, CFG)).toBeNull();
  });

  it("rejects below the flow floor", () => {
    const f = baseFeatures({ mcapUsd: 150_000, feesEarnedPoolSol: 20, flowUsdPerMin: 99_999 });
    expect(classifyPlay(f, CFG)).toBeNull();
  });

  it("rejects the 500k-1M fake-volume band when fees earned is under floor", () => {
    const f = baseFeatures({ mcapUsd: 700_000, feesEarnedPoolSol: 5, flowUsdPerMin: 500_000 });
    expect(classifyPlay(f, CFG)).toBeNull();
  });

  it("accepts the 500k-1M band when fees genuinely clear the floor", () => {
    const f = baseFeatures({ mcapUsd: 700_000, feesEarnedPoolSol: 15, flowUsdPerMin: 500_000 });
    expect(classifyPlay(f, CFG)?.play).toBe("eys_seat");
  });

  it("does not require dev fees to be known (never a blocking gate)", () => {
    const f = baseFeatures({ mcapUsd: 150_000, feesEarnedPoolSol: 10, flowUsdPerMin: 100_000, devFeesKnownZero: false });
    expect(classifyPlay(f, CFG)?.play).toBe("eys_seat");
  });
});

describe("classifyPlay — none fits", () => {
  it("returns null below every play's mcap floor", () => {
    const f = baseFeatures({ mcapUsd: 50_000 });
    expect(classifyPlay(f, CFG)).toBeNull();
  });
});
