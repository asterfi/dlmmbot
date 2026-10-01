import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  comboPositionSize, sizeComboPlay, checkAffordability, eysCostSkip,
  type ComboOpenCounts, type ComboSizingConfig, type CanarySizingConfig, type EysCostConfig,
} from "./sizing.js";
import type { Bankroll } from "../../risk/limits.js";

// minPositionSol reads config() (risk/limits.ts) — install a config so the
// equity-scaled floor behaves predictably across the test matrix.
import { installConfig, restoreConfig } from "../../test/config.js";

const CFG: ComboSizingConfig = {
  active_budget_pct: 30,
  molu_share_pct: 100 / 3,
  eys_share_pct: 100 / 3,
  danko_share_pct: 100 / 3,
  max_concurrent: 3,
  min_floor_sol: 0.05,
  fee_reserve_sol: 0.05,
};

function bankroll(equitySol: number, deployableSol = equitySol): Bankroll {
  return { walletSol: equitySol, bankedSol: 0, deployedSol: 0, deployableSol, effectiveSlots: 10 };
}

const NO_OPEN: ComboOpenCounts = { moluLadder: 0, eysSeat: 0, dankoTrap: 0, eysApe: 0 };

beforeEach(() => installConfig((c) => {
  c.sizing.min_position_sol = 0.3;
  c.sizing.min_position_pct = 1.0;
  c.sizing.min_position_floor_sol = 0.05;
}));
afterEach(() => restoreConfig());

describe("comboPositionSize — Eys 30/70", () => {
  it("sizes molu/eys at ~1/3 of 30% of equity", () => {
    const b = bankroll(100);
    const size = comboPositionSize(b, "molu_ladder", NO_OPEN, CFG);
    // active budget = 30, share = 1/3 -> 10 SOL
    expect(size).toBeCloseTo(10, 4);
  });

  it("danko_trap sizes the same per-position share as molu/eys", () => {
    const b = bankroll(100);
    const size = comboPositionSize(b, "danko_trap", NO_OPEN, CFG);
    expect(size).toBeCloseTo(10, 4);
  });

  it("70% of equity is never touched (deployable clamp)", () => {
    // deployable is tiny relative to equity — combo size must clamp to it,
    // never reach into the untouched 70%.
    const b = bankroll(100, 1);
    const size = comboPositionSize(b, "molu_ladder", NO_OPEN, CFG);
    expect(size).toBeLessThanOrEqual(1 - CFG.fee_reserve_sol + 1e-9);
  });

  it("grows automatically with equity", () => {
    const small = comboPositionSize(bankroll(10), "eys_seat", NO_OPEN, CFG);
    const big = comboPositionSize(bankroll(1000), "eys_seat", NO_OPEN, CFG);
    expect(big).toBeGreaterThan(small);
  });
});

describe("comboPositionSize — minimums", () => {
  it("skips (returns 0) rather than oversizing when equity is too small", () => {
    // equity=1 -> active budget 0.3, share/3 = 0.1 SOL; floor (min_position_sol
    // scaled) at equity=1 is max(min(0.05,0.3), min(0.3, 1*1%)) = 0.01 -> but
    // min_floor_sol=0.05 still applies as the combo-specific floor.
    const b = bankroll(0.1);
    const size = comboPositionSize(b, "eys_seat", NO_OPEN, CFG);
    expect(size).toBe(0);
  });

  it("never sizes below min_floor_sol", () => {
    const b = bankroll(100);
    const size = comboPositionSize(b, "molu_ladder", NO_OPEN, CFG);
    expect(size).toBeGreaterThanOrEqual(CFG.min_floor_sol);
  });
});

describe("comboPositionSize — max concurrent", () => {
  it("refuses a 4th combo position when 3 are already open", () => {
    const b = bankroll(100);
    const full: ComboOpenCounts = { moluLadder: 1, eysSeat: 1, dankoTrap: 1, eysApe: 0 };
    expect(comboPositionSize(b, "molu_ladder", full, CFG)).toBe(0);
  });

  it("refuses a 2nd danko_trap even with concurrent slots free", () => {
    const b = bankroll(100);
    const oneDanko: ComboOpenCounts = { moluLadder: 0, eysSeat: 0, dankoTrap: 1, eysApe: 0 };
    expect(comboPositionSize(b, "danko_trap", oneDanko, CFG)).toBe(0);
  });

  it("allows molu/eys to fill remaining slots while danko_trap is held", () => {
    const b = bankroll(100);
    const oneDanko: ComboOpenCounts = { moluLadder: 0, eysSeat: 0, dankoTrap: 1, eysApe: 0 };
    expect(comboPositionSize(b, "molu_ladder", oneDanko, CFG)).toBeGreaterThan(0);
  });

  it("allows exactly 3 total combo positions", () => {
    const b = bankroll(100);
    const two: ComboOpenCounts = { moluLadder: 1, eysSeat: 1, dankoTrap: 0, eysApe: 0 };
    expect(comboPositionSize(b, "danko_trap", two, CFG)).toBeGreaterThan(0);
  });
});

const CANARY: CanarySizingConfig = {
  canary_mode: true,
  canary_position_sol: 0.1,
  ape_sol: 0.1,
  fee_reserve_sol: 0.05,
  position_rent_est_sol: 0.065,
};

describe("checkAffordability", () => {
  it("ok when equity and deployable both clear size+reserve+rent", () => {
    const b = bankroll(1, 1);
    expect(checkAffordability(b, 0.1, CANARY).ok).toBe(true);
  });

  it("fails on equity when size+reserve+rent exceeds total equity", () => {
    const b = bankroll(0.2, 0.2);
    const r = checkAffordability(b, 0.1, CANARY);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/equity/);
  });

  it("fails on deployable even when equity is sufficient", () => {
    const b = bankroll(1, 0.1); // plenty of equity, but little deployable (already committed)
    const r = checkAffordability(b, 0.1, CANARY);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/deployable/);
  });
});

describe("sizeComboPlay — canary mode (~0.3 SOL account)", () => {
  it("sizes a SOL-side play at the flat canary_position_sol", () => {
    const b = bankroll(0.3, 0.3);
    const r = sizeComboPlay(b, "eys_seat", NO_OPEN, CFG, CANARY);
    expect(r.sizeSol).toBeCloseTo(0.1, 6);
    expect(r.skipReason).toBeNull();
  });

  it("sizes eys_ape at ape_sol even in canary mode", () => {
    const b = bankroll(0.3, 0.3);
    const r = sizeComboPlay(b, "eys_ape", NO_OPEN, CFG, CANARY);
    expect(r.sizeSol).toBeCloseTo(0.1, 6);
  });

  it("allows only 1 total combo position regardless of play mix", () => {
    const b = bankroll(0.3, 0.3);
    const oneOpen: ComboOpenCounts = { moluLadder: 1, eysSeat: 0, dankoTrap: 0, eysApe: 0 };
    const r = sizeComboPlay(b, "eys_seat", oneOpen, CFG, CANARY);
    expect(r.sizeSol).toBe(0);
    expect(r.skipReason).toBe("canary_max_concurrent");
  });

  it("skips on affordability when equity is too thin for size+reserve+rent", () => {
    const b = bankroll(0.1, 0.1); // 0.1 < 0.1 + 0.05 + 0.065
    const r = sizeComboPlay(b, "eys_seat", NO_OPEN, CFG, CANARY);
    expect(r.sizeSol).toBe(0);
    expect(r.skipReason).toMatch(/^skip_affordability/);
  });

  it("falls back to normal 30/70 sizing when canary_mode is false", () => {
    const b = bankroll(100, 100);
    const normalCfg: CanarySizingConfig = { ...CANARY, canary_mode: false };
    const r = sizeComboPlay(b, "molu_ladder", NO_OPEN, CFG, normalCfg);
    expect(r.sizeSol).toBeCloseTo(10, 4); // same math as comboPositionSize
  });
});

describe("sizeComboPlay — eys_ape max 1 concurrent (both modes)", () => {
  it("refuses a 2nd ape even outside canary mode", () => {
    const b = bankroll(100, 100);
    const normalCfg: CanarySizingConfig = { ...CANARY, canary_mode: false };
    const oneApe: ComboOpenCounts = { moluLadder: 0, eysSeat: 0, dankoTrap: 0, eysApe: 1 };
    const r = sizeComboPlay(b, "eys_ape", oneApe, CFG, normalCfg);
    expect(r.sizeSol).toBe(0);
    expect(r.skipReason).toBe("ape_max_concurrent");
  });
});

describe("eysCostSkip", () => {
  const COST: EysCostConfig = {
    eys_tp_pct: 2, eys_cost_tx_count: 4, eys_cost_tx_sol: 0.0006, eys_cost_slippage_bps: 50,
  };

  it("skips a position too small for its expected win to clear round-trip costs", () => {
    // size=0.05: win=0.001, cost=4*0.0006 + 0.05*0.005=0.0024+0.00025=0.00265 -> skip
    expect(eysCostSkip(0.05, COST)).toBe(true);
  });

  it("does not skip once size is large enough for the win to clear costs", () => {
    // size=1: win=0.02, cost=0.0024+0.005=0.0074 -> win > cost, do not skip
    expect(eysCostSkip(1, COST)).toBe(false);
  });

  it("boundary: skip is inclusive of equality (expected win <= cost)", () => {
    // win = size*0.02; cost = 0.0024 + size*0.005 -> equal at size=0.16 (up to
    // float rounding). Compute both sides with the function's own formula and
    // assert the <= policy directly, so the test isn't hostage to which way a
    // 1-ulp float rounding error falls.
    const size = 0.16;
    const expectedWin = size * (COST.eys_tp_pct / 100);
    const estCost = COST.eys_cost_tx_count * COST.eys_cost_tx_sol + size * (COST.eys_cost_slippage_bps / 10_000);
    expect(expectedWin).toBeCloseTo(estCost, 10);
    expect(eysCostSkip(size, COST)).toBe(expectedWin <= estCost);
  });
});
