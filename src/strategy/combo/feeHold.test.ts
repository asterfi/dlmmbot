import { describe, expect, it } from "vitest";
import { comboExitCheck, dumpBonusIdleAbove, seatIdleCooldownH, type ComboExitConfig, type ComboExitInput } from "./exits.js";
import { eysVolTier, estimateLifetimePoolFeesSol, type ComboConfigLike, type PlayCandidateFeatures } from "./plays.js";

// Owner, 2026-10-03: seats hold while the pool pays (fee_hold) and a pool paying
// >= eys_fee_entry_pct_per_h of TVL per hour qualifies whatever its volume.

const HOLD: ComboExitConfig = { eys_tp_pct: 3, eys_seat_exit: "fee_hold", eys_hold_min_minutes: 10 };

function input(over: Partial<ComboExitInput>): ComboExitInput {
  return { play: "eys_seat", entrySol: 0.08, pnlFrac: 0, flowDead: false, everFilled: true, aboveRange: false, holdMin: 30, ...over };
}

describe("eys_seat fee_hold exit", () => {
  it("does NOT take profit at +3% while the pool keeps paying", () => {
    expect(comboExitCheck(input({ pnlFrac: 0.25 }), HOLD).shouldExit).toBe(false);
  });
  it("exits when fees fade", () => {
    const d = comboExitCheck(input({ feeFaded: true }), HOLD);
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toMatch(/fees faded/);
  });
  it("exits when price falls below the range", () => {
    const d = comboExitCheck(input({ belowRange: true, pnlFrac: -0.1 }), HOLD);
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toMatch(/below the range/);
  });
  it("waits the minimum hold before fee/range exits", () => {
    expect(comboExitCheck(input({ holdMin: 5, feeFaded: true, belowRange: true }), HOLD).shouldExit).toBe(false);
  });
  it("still exits on confirmed flow death at any time", () => {
    expect(comboExitCheck(input({ holdMin: 2, flowDead: true }), HOLD).shouldExit).toBe(true);
  });
  it("eys_tight keeps the take-profit", () => {
    expect(comboExitCheck(input({ play: "eys_tight", pnlFrac: 0.03 }), HOLD).shouldExit).toBe(true);
  });
  it("tp mode (default) is unchanged", () => {
    expect(comboExitCheck(input({ pnlFrac: 0.03 }), { eys_tp_pct: 3 }).shouldExit).toBe(true);
  });
});

describe("fee entry tier", () => {
  const CFG: ComboConfigLike = {
    eys_mcap_min_usd: 100_000, eys_fees_earned_min_sol: 10, eys_flow_usd_per_min_min: 100_000,
    eys_vol_accel_min: 0, eys_soft_fee_tvl_per_hour_min: 5, eys_fee_entry_pct_per_h: 5,
  };
  const f = (over: Partial<PlayCandidateFeatures>) => ({ mcapUsd: 500_000, feesEarnedPoolSol: 50, flowUsdPerMin: 2_000, ...over }) as PlayCandidateFeatures;

  it("a pool paying >= 5%/h qualifies at low volume; the threshold stays the hard bar for a later breakout", () => {
    expect(eysVolTier(f({ feeTvl30mPct: 2.5 }), CFG)).toEqual({ tier: "fee", threshold: 100_000 });
  });
  it("below 5%/h with no volume tier is no tier", () => {
    expect(eysVolTier(f({ feeTvl30mPct: 2.4, dynamicVolFloor: 1_000 }), CFG)).toBeNull();
  });
  it("hard volume still wins first", () => {
    expect(eysVolTier(f({ flowUsdPerMin: 150_000, feeTvl30mPct: 3 }), CFG)?.tier).toBe("hard");
  });
  it("off when eys_fee_entry_pct_per_h is unset", () => {
    expect(eysVolTier(f({ feeTvl30mPct: 10 }), { ...CFG, eys_fee_entry_pct_per_h: undefined, eys_soft_fee_tvl_per_hour_min: 0 })).toBeNull();
  });
});

describe("estimateLifetimePoolFeesSol", () => {
  it("a pool younger than a day counts its whole 24h fees (Encyclopedia: 36 min old, $3.6k fees)", () => {
    expect(estimateLifetimePoolFeesSol(3_636, 0.025, 72)).toBeCloseTo(50.5, 1);
  });
  it("an older pool holds the 24h figure flat over its age", () => {
    expect(estimateLifetimePoolFeesSol(720, 3, 72)).toBeCloseTo(30, 6);
  });
  it("unknown age or SOL price is null (fails the fee gate closed)", () => {
    expect(estimateLifetimePoolFeesSol(1000, null, 72)).toBeNull();
    expect(estimateLifetimePoolFeesSol(1000, 1, null)).toBeNull();
  });
});

describe("seatIdleCooldownH (re-seat after the token runs above the seat)", () => {
  const cfg = { reentry_cooldown_h: 3, eys_reseat_on_idle: true, eys_fee_entry_pct_per_h: 5 };
  it("no cooldown while the pool still pays the fee-tier rate", () => {
    expect(seatIdleCooldownH(cfg, 7)).toBe(0);
  });
  it("normal cooldown once the pool pays less", () => {
    expect(seatIdleCooldownH(cfg, 4.9)).toBe(3);
  });
  it("normal cooldown when re-seat is off", () => {
    expect(seatIdleCooldownH({ ...cfg, eys_reseat_on_idle: false }, 9)).toBe(3);
  });
});

describe("dumpBonusIdleAbove (filled ladder, price back above it)", () => {
  const cfg = { eys_dump_idle_above_min: 30 };
  it("closes a filled ladder that has been above its range for 30 min", () => {
    expect(dumpBonusIdleAbove(true, true, 31, cfg)).toBe(true);
  });
  it("waits while it has been above for less than 30 min", () => {
    expect(dumpBonusIdleAbove(true, true, 10, cfg)).toBe(false);
  });
  it("keeps a filled ladder that is in or below its range (waiting for the bounce)", () => {
    expect(dumpBonusIdleAbove(true, false, 999, cfg)).toBe(false);
  });
  it("never-filled ladders are left to the eys_dump_idle_max_h timeout", () => {
    expect(dumpBonusIdleAbove(false, true, 999, cfg)).toBe(false);
  });
});
