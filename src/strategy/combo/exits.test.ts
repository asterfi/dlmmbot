import { describe, expect, it } from "vitest";
import { comboExitCheck, type ComboExitConfig, type ComboExitInput } from "./exits.js";

const CFG: ComboExitConfig = { eys_tp_pct: 2 };

function input(over: Partial<ComboExitInput>): ComboExitInput {
  return { play: "eys_seat", entrySol: 0.1, pnlFrac: 0, flowDead: false, everFilled: true, aboveRange: false, ...over };
}

describe("eys_seat / eys_tight — green or flow death, never a stop-loss", () => {
  for (const play of ["eys_seat", "eys_tight"] as const) {
    it(`${play}: holds below the target`, () => {
      expect(comboExitCheck(input({ play, pnlFrac: 0.019 }), CFG).shouldExit).toBe(false);
    });
    it(`${play}: exits once green by the target (+2%)`, () => {
      const d = comboExitCheck(input({ play, pnlFrac: 0.02 }), CFG);
      expect(d.shouldExit).toBe(true);
      expect(d.reason).toMatch(/target/);
    });
    it(`${play}: exits on confirmed flow death regardless of PnL`, () => {
      expect(comboExitCheck(input({ play, pnlFrac: -0.3, flowDead: true }), CFG).shouldExit).toBe(true);
    });
    it(`${play}: a deep loss with flow alive just holds (no stop-loss)`, () => {
      expect(comboExitCheck(input({ play, pnlFrac: -0.6 }), CFG).shouldExit).toBe(false);
    });
  }
  it("the target is configurable (1-3%)", () => {
    expect(comboExitCheck(input({ pnlFrac: 0.012 }), { eys_tp_pct: 1 }).shouldExit).toBe(true);
    expect(comboExitCheck(input({ pnlFrac: 0.029 }), { eys_tp_pct: 3 }).shouldExit).toBe(false);
  });
});

describe("eys_breakout — range fully converted, green, or flow death", () => {
  it("exits when price ran through the top (range fully converted to SOL)", () => {
    const d = comboExitCheck(input({ play: "eys_breakout", aboveRange: true, pnlFrac: -0.05 }), CFG);
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toMatch(/fully converted/);
  });
  it("exits green at the target", () => {
    expect(comboExitCheck(input({ play: "eys_breakout", pnlFrac: 0.025 }), CFG).shouldExit).toBe(true);
  });
  it("exits on flow death", () => {
    expect(comboExitCheck(input({ play: "eys_breakout", flowDead: true, pnlFrac: -0.2 }), CFG).shouldExit).toBe(true);
  });
  it("otherwise holds, even deep underwater (token-sided money is 'okay to lose')", () => {
    expect(comboExitCheck(input({ play: "eys_breakout", pnlFrac: -0.7 }), CFG).shouldExit).toBe(false);
  });
});

describe("eys_ape — unchanged: range fully converted or flow death", () => {
  it("exits when converted; holds otherwise (no profit target, no stop)", () => {
    expect(comboExitCheck(input({ play: "eys_ape", aboveRange: true }), CFG).shouldExit).toBe(true);
    expect(comboExitCheck(input({ play: "eys_ape", pnlFrac: 0.5 }), CFG).shouldExit).toBe(false);
    expect(comboExitCheck(input({ play: "eys_ape", pnlFrac: -0.99 }), CFG).shouldExit).toBe(false);
    expect(comboExitCheck(input({ play: "eys_ape", flowDead: true }), CFG).shouldExit).toBe(true);
  });
});

describe("eys_dump_bonus — waits for a real fill and a green bounce; flow death is its premise", () => {
  it("exits green only on a ladder that actually filled", () => {
    expect(comboExitCheck(input({ play: "eys_dump_bonus", pnlFrac: 0.03, everFilled: true }), CFG).shouldExit).toBe(true);
    expect(comboExitCheck(input({ play: "eys_dump_bonus", pnlFrac: 0.03, everFilled: false }), CFG).shouldExit).toBe(false);
  });
  it("flow death does NOT exit it (volume fading is why it was placed)", () => {
    expect(comboExitCheck(input({ play: "eys_dump_bonus", flowDead: true, pnlFrac: -0.4, everFilled: true }), CFG).shouldExit).toBe(false);
  });
  it("holds below the target", () => {
    expect(comboExitCheck(input({ play: "eys_dump_bonus", pnlFrac: 0.01 }), CFG).shouldExit).toBe(false);
  });
});
