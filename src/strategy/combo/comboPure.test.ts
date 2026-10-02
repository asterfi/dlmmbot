/**
 * Pure pieces of the 2026-10-03 strategy-fidelity round: play_priority
 * resolution, molu range builder, molu pool choice, Jev play-menu narrowing.
 */
import { describe, it, expect } from "vitest";
import {
  classifyAllPlays, classifyPlay, pickByPriority, DEFAULT_PLAY_PRIORITY,
  type ComboConfigLike, type PlayCandidateFeatures,
} from "./plays.js";
import { planMoluRange } from "./moluRange.js";
import { chooseMoluPool } from "./moluPool.js";
import { questionsFor } from "../jev/questions.js";
import type { PoolInfo } from "../../types.js";

// molu's age window deliberately overlaps danko's here (molu < 100h, danko >= 48h) so one
// candidate can fit both; at production values (48/48) they are mutually exclusive by age.
const CFG: ComboConfigLike = {
  molu_mcap_min_usd: 1_000_000, molu_age_max_h: 100, molu_dip_min_pct: 20, molu_bounce_min_pct: 5,
  eys_mcap_min_usd: 100_000, eys_fees_earned_min_sol: 10, eys_flow_usd_per_min_min: 100_000,
  eys_reject_mcap_lo_usd: 500_000, eys_reject_mcap_hi_usd: 1_000_000,
  danko_mcap_min_usd: 1_000_000, danko_age_min_h: 48, danko_dump_min_pct: 30, danko_flow_ratio_min: 0.05,
};

function feats(over: Partial<PlayCandidateFeatures> = {}): PlayCandidateFeatures {
  return {
    mcapUsd: 2_000_000, tokenAgeMinutes: 60 * 60, tvlUsd: 100_000, vol30mUsd: 0, vol1hUsd: 0, feeTvl24hPct: 10,
    feesEarnedPoolSol: null, devFeesKnownZero: false, flowUsdPerMin: 0,
    dipBounce: { dipPct: 30, bouncePct: 10 }, oneSidedFeasible: true,
    dumpPct: 40, flowRatio: 0.1, buyersPresent: true, ...over,
  };
}

describe("play_priority resolution", () => {
  it("default order is eys_seat > eys_ape > molu_ladder > danko_trap", () => {
    expect(DEFAULT_PLAY_PRIORITY).toEqual(["eys_seat", "eys_ape", "molu_ladder", "danko_trap"]);
  });

  it("a candidate fitting BOTH molu_ladder and eys_seat resolves to eys_seat", () => {
    const f = feats({ tokenAgeMinutes: 600, feesEarnedPoolSol: 20, flowUsdPerMin: 150_000 });
    const all = classifyAllPlays(f, CFG).map((c) => c.play);
    expect(all).toEqual(expect.arrayContaining(["molu_ladder", "eys_seat"]));
    expect(classifyPlay(f, CFG)?.play).toBe("eys_seat");
  });

  it("a candidate fitting danko_trap and molu_ladder (not eys) resolves to molu_ladder", () => {
    const f = feats({ tokenAgeMinutes: 60 * 60 }); // 60h: >= danko 48h floor AND < molu 100h window; no eys fees/flow
    const all = classifyAllPlays(f, CFG).map((c) => c.play);
    expect(all).toEqual(expect.arrayContaining(["danko_trap", "molu_ladder"]));
    expect(all).not.toContain("eys_seat");
    expect(classifyPlay(f, CFG)?.play).toBe("molu_ladder");
  });

  it("config play_priority overrides the default", () => {
    const f = feats({ tokenAgeMinutes: 600, feesEarnedPoolSol: 20, flowUsdPerMin: 150_000 });
    expect(classifyPlay(f, { ...CFG, play_priority: ["molu_ladder", "eys_seat", "eys_ape", "danko_trap"] })?.play).toBe("molu_ladder");
  });

  it("pickByPriority ranks plays missing from the list last and returns null for none", () => {
    expect(pickByPriority([{ play: "danko_trap" as const }, { play: "eys_ape" as const }], ["eys_seat", "eys_ape"])?.play).toBe("eys_ape");
    expect(pickByPriority([{ play: "danko_trap" as const }, { play: "molu_ladder" as const }], ["eys_seat"])?.play).toBe("danko_trap");
    expect(pickByPriority([])).toBeNull();
  });
});

describe("planMoluRange", () => {
  it("builds 110 bins ending at the active bin, over 2 position accounts", () => {
    const r = planMoluRange(0.77, 100, 6, 110, 100, 125, 2);
    expect(r.binCount).toBe(110);
    expect(r.positionAccounts).toBe(2);
    expect(r.maxBinId - r.minBinId + 1).toBe(110);
    expect(r.shape).toBe("bidask");
  });

  it("clamps the target into [min, max]", () => {
    expect(planMoluRange(0.77, 100, 6, 60, 100, 125, 2).binCount).toBe(100);
    expect(planMoluRange(0.77, 100, 6, 500, 100, 125, 2).binCount).toBe(125);
  });

  it("caps at -90% when a coarse bin step makes the target run deeper (count falls below min)", () => {
    // 4% bins: 110 of them would reach ~-98.7%
    const r = planMoluRange(0.77, 400, 6, 110, 100, 125, 2);
    expect(r.bottomPricePct).toBeGreaterThanOrEqual(-90.5);
    expect(r.binCount).toBeLessThan(100);
  });

  it("caps at the position-account ceiling", () => {
    const r = planMoluRange(0.77, 100, 6, 125, 100, 125, 1);
    expect(r.binCount).toBe(69);
    expect(r.positionAccounts).toBe(1);
  });
});

describe("chooseMoluPool", () => {
  const pool = (address: string, baseFeePct: number, vol30mUsd: number, tvlUsd = 100_000): PoolInfo =>
    ({ address, baseFeePct, vol30mUsd, tvlUsd } as unknown as PoolInfo);
  const cfg = { molu_fee_pool_min_vol30m_usd: 10_000 };

  it("prefers a 5-10% fee pool with >= min volume, even over a bigger-volume low-fee pool", () => {
    const a = pool("A", 1, 200_000), b = pool("B", 5, 15_000);
    const c = chooseMoluPool([a, b], cfg, a);
    expect(c.pool.address).toBe("B");
    expect(c.reason).toBe("fee_tier_5_10");
  });

  it("among several fee-tier pools takes the highest volume; boundaries 5 and 10 inclusive", () => {
    const a = pool("A", 1, 1), b = pool("B", 5, 20_000), c = pool("C", 10, 30_000), d = pool("D", 10.5, 99_000);
    expect(chooseMoluPool([a, b, c, d], cfg, a).pool.address).toBe("C");
  });

  it("a fee-tier pool under the volume floor is ignored: highest 30m volume wins (not deepest TVL)", () => {
    const a = pool("A", 1, 50_000, 900_000), b = pool("B", 5, 9_999), c = pool("C", 2, 120_000, 40_000);
    const r = chooseMoluPool([a, b, c], cfg, a);
    expect(r.pool.address).toBe("C");
    expect(r.reason).toBe("highest_vol30m");
  });

  it("single pool -> unchanged; ties keep the current pool", () => {
    const a = pool("A", 1, 5);
    expect(chooseMoluPool([a], cfg, a)).toEqual({ pool: a, reason: "single_pool" });
    const b = pool("B", 1, 5);
    expect(chooseMoluPool([a, b], cfg, b).pool.address).toBe("B");
  });
});

describe("Jev play menu is narrowed to qualifying plays + none", () => {
  it("lists only the qualifying plays and none", () => {
    const q = questionsFor("enter", ["eys_seat", "molu_ladder"]);
    const play = q["play"] as { criteria: Record<string, string> };
    expect(Object.keys(play.criteria).sort()).toEqual(["eys_seat", "molu_ladder", "none"]);
  });
  it("no qualifying list -> the full menu; exit lane untouched", () => {
    const full = questionsFor("enter")["play"] as { criteria: Record<string, string> };
    expect(Object.keys(full.criteria)).toEqual(expect.arrayContaining(["molu_ladder", "danko_trap", "eys_seat", "eys_ape", "none"]));
    expect(questionsFor("exit", ["eys_seat"])).toBe(questionsFor("exit"));
  });
});
