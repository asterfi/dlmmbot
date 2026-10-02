import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  canaryPositionSize, comboPositionSize, sizeComboPlay, checkAffordability, eysCostSkip, totalOpen,
  type ComboOpenCounts, type ComboSizingConfig, type CanarySizingConfig, type EysCostConfig,
} from "./sizing.js";
import type { Bankroll } from "../../risk/limits.js";
import { installConfig, restoreConfig } from "../../test/config.js";

const CFG: ComboSizingConfig = {
  active_budget_pct: 30,
  eys_share_pct: 100 / 3,
  max_concurrent: 3,
  min_floor_sol: 0.05,
  fee_reserve_sol: 0.05,
};
const CANARY: CanarySizingConfig = {
  canary_mode: true, canary_position_sol: 0.1, canary_max_concurrent: 2,
  ape_sol: 0.1, fee_reserve_sol: 0.05, position_rent_est_sol: 0.065,
};

function bankroll(equitySol: number, deployableSol = equitySol, deployedSol = 0): Bankroll {
  return { walletSol: equitySol, bankedSol: 0, deployedSol, deployableSol, effectiveSlots: 10 };
}
const open = (over: Partial<ComboOpenCounts> = {}): ComboOpenCounts =>
  ({ eysSeat: 0, eysBreakout: 0, eysTight: 0, eysApe: 0, eysDumpBonus: 0, ...over });

beforeEach(() => installConfig((c) => {
  c.sizing.min_position_sol = 0.3;
  c.sizing.min_position_pct = 1.0;
  c.sizing.min_position_floor_sol = 0.05;
}));
afterEach(() => restoreConfig());

describe("totalOpen", () => {
  it("sums every play", () => {
    expect(totalOpen(open({ eysSeat: 1, eysBreakout: 1, eysTight: 1, eysApe: 1, eysDumpBonus: 1 }))).toBe(5);
  });
});

describe("comboPositionSize — Eys 30/70 (normal mode)", () => {
  it("sizes a SOL-side position at 1/3 of 30% of equity", () => {
    expect(comboPositionSize(bankroll(100), open(), CFG)).toBeCloseTo(10, 4);
  });
  it("clamps to FREE SOL (equity - deployed) minus the fee reserve", () => {
    // 97 already deployed -> 3 free -> 2.95 after the 0.05 buffer; upstream's reserve is not stacked on top
    expect(comboPositionSize(bankroll(100, 100, 97), open(), CFG)).toBeCloseTo(2.95, 4);
  });
  it("skips (0) when the clamped size falls under the floor", () => {
    expect(comboPositionSize(bankroll(100, 100, 99.92), open(), CFG)).toBe(0);
  });
  it("ignores upstream's deployableSol (its reserve) — only the combo buffer applies", () => {
    expect(comboPositionSize(bankroll(100, 0.08), open(), CFG)).toBeCloseTo(10, 4);
  });
  it("caps total concurrent combo positions", () => {
    expect(comboPositionSize(bankroll(100), open({ eysSeat: 2, eysTight: 1 }), CFG)).toBe(0);
  });
});

describe("sizeComboPlay — canary mode: 2 slots, 0.1 SOL tickets", () => {
  const rich = bankroll(5);

  it("a SOL-side play takes the flat canary size", () => {
    expect(sizeComboPlay(rich, "eys_seat", open(), CFG, CANARY)).toEqual({ sizeSol: 0.1, skipReason: null });
    expect(sizeComboPlay(rich, "eys_dump_bonus", open({ eysSeat: 1 }), CFG, CANARY).sizeSol).toBe(0.1);
  });
  it("token-sided plays (breakout, ape) take the fixed ape ticket (capped at the SOL-side size)", () => {
    const c = { ...CANARY, canary_position_sol: 0.15, ape_sol: 0.12 };
    expect(sizeComboPlay(rich, "eys_breakout", open({ eysSeat: 1 }), CFG, c).sizeSol).toBe(0.12);
    expect(sizeComboPlay(rich, "eys_ape", open(), CFG, c).sizeSol).toBe(0.12);
  });
  it("an open seat plus its breakout fills both slots: a third is canary_max_concurrent", () => {
    const r = sizeComboPlay(rich, "eys_tight", open({ eysSeat: 1, eysBreakout: 1 }), CFG, CANARY);
    expect(r).toEqual({ sizeSol: 0, skipReason: "canary_max_concurrent" });
  });
  it("one open position leaves the second slot free (breakout for an open seat)", () => {
    expect(sizeComboPlay(rich, "eys_breakout", open({ eysSeat: 1 }), CFG, CANARY).skipReason).toBeNull();
  });
  it("canary_max_concurrent defaults to 2 when unset", () => {
    const { canary_max_concurrent: _drop, ...noMax } = CANARY;
    expect(sizeComboPlay(rich, "eys_seat", open({ eysSeat: 1 }), CFG, noMax).skipReason).toBeNull();
    expect(sizeComboPlay(rich, "eys_seat", open({ eysSeat: 1, eysTight: 1 }), CFG, noMax).skipReason).toBe("canary_max_concurrent");
  });
  it("at most one eys_ape at a time", () => {
    expect(sizeComboPlay(rich, "eys_ape", open({ eysApe: 1 }), CFG, CANARY).skipReason).toBe("ape_max_concurrent");
  });
});

describe("affordability — skip, never oversize", () => {
  it("equity must cover size + fee reserve + rent", () => {
    // needs 0.1 + 0.05 + 0.065 = 0.215
    expect(checkAffordability(bankroll(0.214), 0.1, CANARY).ok).toBe(false);
    expect(checkAffordability(bankroll(0.2151), 0.1, CANARY).ok).toBe(true);
  });
  it("FREE SOL (equity - deployed) must cover size + rent + reserve (0.215)", () => {
    const r = checkAffordability(bankroll(1, 1, 0.8), 0.1, CANARY); // 0.2 free
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/free/);
    expect(checkAffordability(bankroll(1, 1, 0.784), 0.1, CANARY).ok).toBe(true); // 0.216 free
  });
  it("second position: what the first one deployed is no longer free", () => {
    // 0.3347 equity, first seat deployed 0.1 (rent already left the free balance in live) -> 0.2347 free
    expect(checkAffordability(bankroll(0.3347, 0.3347, 0.1), 0.1, { fee_reserve_sol: 0.04, position_rent_est_sol: 0.045 }).ok).toBe(true);
  });
  it("rent scales with the REAL position-account count: a 2-account range needs 0.1 + 2x0.065 + 0.05", () => {
    const two = { fee_reserve_sol: 0.05, position_rent_est_sol: 0.065 * 2 };
    expect(checkAffordability(bankroll(1, 1, 0.78), 0.1, { fee_reserve_sol: 0.05, position_rent_est_sol: 0.065 }).ok).toBe(true); // 0.22 free
    expect(checkAffordability(bankroll(1, 1, 0.78), 0.1, two).ok).toBe(false);
    expect(checkAffordability(bankroll(1, 1, 0.72), 0.1, two).ok).toBe(true); // 0.28 free
  });
  it("sizeComboPlay returns skip_affordability instead of a smaller size", () => {
    const r = sizeComboPlay(bankroll(0.2), "eys_seat", open(), CFG, CANARY);
    expect(r.sizeSol).toBe(0);
    expect(r.skipReason).toMatch(/^skip_affordability/);
  });
});

describe("normal mode token-sided and SOL-side", () => {
  const normal: CanarySizingConfig = { ...CANARY, canary_mode: false };
  it("token-sided uses the fixed ticket and honours max_concurrent", () => {
    expect(sizeComboPlay(bankroll(100), "eys_breakout", open({ eysSeat: 1 }), CFG, normal).sizeSol).toBe(0.1);
    expect(sizeComboPlay(bankroll(100), "eys_breakout", open({ eysSeat: 2, eysTight: 1 }), CFG, normal).skipReason).toBe("combo_size_zero");
  });
  it("SOL-side is Eys 30/70 sized", () => {
    expect(sizeComboPlay(bankroll(100), "eys_seat", open(), CFG, normal).sizeSol).toBeCloseTo(10, 4);
  });
});

describe("eysCostSkip — take-profit plays must clear the round-trip cost", () => {
  const COST: EysCostConfig = { eys_tp_pct: 2, eys_cost_tx_count: 4, eys_cost_tx_sol: 0.0003, eys_cost_slippage_bps: 50 };
  it("a 0.1 SOL seat at a 2% target clears the 0.0003/tx estimate (expected win 0.002 > cost 0.0017)", () => {
    expect(eysCostSkip(0.1, COST)).toBe(false);
  });
  it("the old 0.0006/tx estimate skipped every 0.1 SOL seat (expected win 0.002 <= cost 0.0029)", () => {
    expect(eysCostSkip(0.1, { ...COST, eys_cost_tx_sol: 0.0006 })).toBe(true);
  });
  it("a tiny position never clears it", () => {
    expect(eysCostSkip(0.02, COST)).toBe(true);
  });
});

describe("canaryPositionSize — autocompound", () => {
  const cfg = { canary_position_sol: 0.05, canary_position_pct: 24, ape_sol: 0.1 };
  it("SOL-side size is 24% of equity: 0.08 at 0.335 SOL, grows with the account", () => {
    expect(canaryPositionSize(bankroll(0.335), cfg, false)).toBeCloseTo(0.0804, 4);
    expect(canaryPositionSize(bankroll(1), cfg, false)).toBeCloseTo(0.24, 6);
  });
  it("never below the floor", () => {
    expect(canaryPositionSize(bankroll(0.1), cfg, false)).toBe(0.05);
  });
  it("token-sided legs cap at Eys's fixed 0.1 ticket, and never exceed the SOL-side size", () => {
    expect(canaryPositionSize(bankroll(1), cfg, true)).toBe(0.1);
    expect(canaryPositionSize(bankroll(0.335), cfg, true)).toBeCloseTo(0.0804, 4);
  });
  it("without canary_position_pct it is the flat canary_position_sol", () => {
    expect(canaryPositionSize(bankroll(5), { canary_position_sol: 0.1, ape_sol: 0.1 }, false)).toBe(0.1);
  });
});
describe("eysCostSkip at 0.08 SOL", () => {
  const COST: EysCostConfig = { eys_tp_pct: 3, eys_cost_tx_count: 4, eys_cost_tx_sol: 0.0003, eys_cost_slippage_bps: 50 };
  it("3% clears the cost estimate (0.0024 > 0.0016); 2% would not", () => {
    expect(eysCostSkip(0.08, COST)).toBe(false);
    expect(eysCostSkip(0.07, { ...COST, eys_tp_pct: 2 })).toBe(true); // 0.0014 < 0.00155
  });
});
