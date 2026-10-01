import { describe, expect, it } from "vitest";
import { comboExitCheck, type ComboExitConfig } from "./exits.js";

const CFG: ComboExitConfig = {
  molu_tp_pct: 15,
  molu_tp_pct_top_tier: 5,
  molu_top_tier_sol: 0.5,
  eys_tp_pct: 2,
  danko_tp_pct: 17.5,
  danko_flow_death_ratio: 0.3,
};

describe("comboExitCheck — flow death", () => {
  it("exits molu/eys/ape immediately on flow death, regardless of PnL", () => {
    for (const play of ["molu_ladder", "eys_seat", "eys_ape"] as const) {
      const d = comboExitCheck({ play, entrySol: 1, pnlFrac: -0.5, flowDead: true, everDrawn: false, everFilled: true }, CFG);
      expect(d.shouldExit).toBe(true);
    }
  });

  it("does NOT force-exit danko_trap on the generic flowDead signal — it never stop-losses (owner's strategy-fidelity fix, 2026-10-02)", () => {
    const d = comboExitCheck({ play: "danko_trap", entrySol: 1, pnlFrac: -0.5, flowDead: true, everDrawn: false, everFilled: true }, CFG);
    expect(d.shouldExit).toBe(false);
  });
});

describe("comboExitCheck — danko_trap flow-death (relative, 5m-volume-collapse)", () => {
  it("exits at break-even-or-better once flow has collapsed, even without a prior drawdown bounce", () => {
    const d = comboExitCheck({
      play: "danko_trap", entrySol: 1, pnlFrac: 0.01, flowDead: false,
      everDrawn: false, everFilled: true, flowCollapsed: true,
    }, CFG);
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toMatch(/flow collapsed/);
  });

  it("holds (no stop-loss) when flow has collapsed but PnL is still negative", () => {
    const d = comboExitCheck({
      play: "danko_trap", entrySol: 1, pnlFrac: -0.2, flowDead: false,
      everDrawn: false, everFilled: true, flowCollapsed: true,
    }, CFG);
    expect(d.shouldExit).toBe(false);
  });

  it("does not require flowCollapsed when the position already bounced (everDrawn)", () => {
    const d = comboExitCheck({
      play: "danko_trap", entrySol: 1, pnlFrac: 0, flowDead: false,
      everDrawn: true, everFilled: true, flowCollapsed: false,
    }, CFG);
    expect(d.shouldExit).toBe(true);
  });
});

describe("comboExitCheck — eys_ape", () => {
  it("holds while below the range top", () => {
    const d = comboExitCheck({ play: "eys_ape", entrySol: 0.1, pnlFrac: 0.3, flowDead: false, everDrawn: false, everFilled: true, aboveRange: false }, CFG);
    expect(d.shouldExit).toBe(false);
  });

  it("exits once price runs through the top (fully converted to SOL)", () => {
    const d = comboExitCheck({ play: "eys_ape", entrySol: 0.1, pnlFrac: 0.3, flowDead: false, everDrawn: false, everFilled: true, aboveRange: true }, CFG);
    expect(d.shouldExit).toBe(true);
  });

  it("accepts going to zero without a stop-loss trigger", () => {
    const d = comboExitCheck({ play: "eys_ape", entrySol: 0.1, pnlFrac: -0.99, flowDead: false, everDrawn: false, everFilled: true, aboveRange: false }, CFG);
    expect(d.shouldExit).toBe(false);
  });
});

describe("comboExitCheck — molu_ladder", () => {
  it("holds below +15%", () => {
    const d = comboExitCheck({ play: "molu_ladder", entrySol: 0.2, pnlFrac: 0.14, flowDead: false, everDrawn: false, everFilled: true }, CFG);
    expect(d.shouldExit).toBe(false);
  });

  it("exits at +15% for a normal-tier position", () => {
    const d = comboExitCheck({ play: "molu_ladder", entrySol: 0.2, pnlFrac: 0.15, flowDead: false, everDrawn: false, everFilled: true }, CFG);
    expect(d.shouldExit).toBe(true);
  });

  it("exits at +5% (not +15%) for a top-tier position", () => {
    const below = comboExitCheck({ play: "molu_ladder", entrySol: 0.6, pnlFrac: 0.049, flowDead: false, everDrawn: false, everFilled: true }, CFG);
    expect(below.shouldExit).toBe(false);
    const at = comboExitCheck({ play: "molu_ladder", entrySol: 0.6, pnlFrac: 0.05, flowDead: false, everDrawn: false, everFilled: true }, CFG);
    expect(at.shouldExit).toBe(true);
  });

  it("top-tier boundary is exact at molu_top_tier_sol", () => {
    const d = comboExitCheck({ play: "molu_ladder", entrySol: 0.5, pnlFrac: 0.05, flowDead: false, everDrawn: false, everFilled: true }, CFG);
    expect(d.shouldExit).toBe(true); // at the boundary counts as top tier
  });
});

describe("comboExitCheck — eys_seat", () => {
  it("holds below the configured target (default 2%)", () => {
    const d = comboExitCheck({ play: "eys_seat", entrySol: 0.2, pnlFrac: 0.019, flowDead: false, everDrawn: false, everFilled: true }, CFG);
    expect(d.shouldExit).toBe(false);
  });

  it("exits at the configured target", () => {
    const d = comboExitCheck({ play: "eys_seat", entrySol: 0.2, pnlFrac: 0.02, flowDead: false, everDrawn: false, everFilled: true }, CFG);
    expect(d.shouldExit).toBe(true);
  });
});

describe("comboExitCheck — danko_trap", () => {
  it("holds while still negative and never drawn (no bounce yet)", () => {
    const d = comboExitCheck({ play: "danko_trap", entrySol: 1, pnlFrac: -0.1, flowDead: false, everDrawn: false, everFilled: true }, CFG);
    expect(d.shouldExit).toBe(false);
  });

  it("exits at break-even-or-better after having been drawn down", () => {
    const d = comboExitCheck({ play: "danko_trap", entrySol: 1, pnlFrac: 0, flowDead: false, everDrawn: true, everFilled: true }, CFG);
    expect(d.shouldExit).toBe(true);
  });

  it("does NOT exit on break-even-or-better if the ladder never actually filled (owner's live-churn fix, 2026-10-02)", () => {
    // everDrawn can be true from upstream's fell_deep tracking even when
    // nothing ever converted; a ladder that never filled has no real trade to
    // call break-even on. It must time out instead (combo.danko_idle_max_h).
    const d = comboExitCheck({ play: "danko_trap", entrySol: 1, pnlFrac: 0, flowDead: false, everDrawn: true, everFilled: false }, CFG);
    expect(d.shouldExit).toBe(false);
  });

  it("does not exit on a positive mark that was never drawn down (no bounce condition met)", () => {
    const d = comboExitCheck({ play: "danko_trap", entrySol: 1, pnlFrac: 0.05, flowDead: false, everDrawn: false, everFilled: true }, CFG);
    expect(d.shouldExit).toBe(false);
  });

  it("exits on the runner target regardless of the drawdown history", () => {
    const d = comboExitCheck({ play: "danko_trap", entrySol: 1, pnlFrac: 0.175, flowDead: false, everDrawn: false, everFilled: true }, CFG);
    expect(d.shouldExit).toBe(true);
  });
});
