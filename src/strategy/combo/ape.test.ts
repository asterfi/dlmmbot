import { describe, expect, it } from "vitest";
import { classifyApe, compareApeCandidates, type ApeCandidateFeatures, type ApeConfigLike } from "./ape.js";

const CFG: ApeConfigLike = {
  ape_fee_min_sol: 10,
  ape_age_max_h: 48,
  ape_mcap_min_usd: 100_000,
  ape_stonks_priority: true,
  eys_flow_usd_per_min_min: 100_000,
};

function base(overrides: Partial<ApeCandidateFeatures> = {}): ApeCandidateFeatures {
  return {
    mcapUsd: 250_000,
    tokenAgeMinutes: 60, // 1h — fresh
    feeModeKnown: true,
    quoteOnlyFee: true,
    feesEarnedPoolSol: 15,
    flowUsdPerMin: 150_000,
    oneSidedFeasible: true,
    source: "meteora",
    ...overrides,
  };
}

describe("classifyApe — widened discovery (2026-10-02): any main-sweep candidate, not just Stonks", () => {
  it("accepts a fresh, non-Stonks (source=meteora) SOL-fee pool that clears every floor", () => {
    const c = classifyApe(base({ source: "meteora" }), CFG);
    expect(c?.play).toBe("eys_ape");
    expect(c?.source).toBe("meteora");
    expect(c?.feeModeUnknown).toBe(false);
  });

  it("accepts a Stonks-sourced candidate the same way, tagged source=stonks", () => {
    const c = classifyApe(base({ source: "stonks" }), CFG);
    expect(c?.play).toBe("eys_ape");
    expect(c?.source).toBe("stonks");
  });
});

describe("classifyApe — age floor (new coin only)", () => {
  it("rejects a token older than ape_age_max_h", () => {
    const c = classifyApe(base({ tokenAgeMinutes: 49 * 60 }), CFG); // 49h > 48h
    expect(c).toBeNull();
  });

  it("accepts right at the age boundary", () => {
    const c = classifyApe(base({ tokenAgeMinutes: 48 * 60 }), CFG);
    expect(c?.play).toBe("eys_ape");
  });

  it("fails closed when age is unknown — this is a no-stop-loss, token-sided play", () => {
    const c = classifyApe(base({ tokenAgeMinutes: null }), CFG);
    expect(c).toBeNull();
  });
});

describe("classifyApe — mcap and flow floors", () => {
  it("rejects below the mcap floor", () => {
    expect(classifyApe(base({ mcapUsd: 99_999 }), CFG)).toBeNull();
  });

  it("rejects below the flow floor (reused from eys_seat)", () => {
    expect(classifyApe(base({ flowUsdPerMin: 99_999 }), CFG)).toBeNull();
  });
});

describe("classifyApe — fee requirement (always required now, not just the fallback)", () => {
  it("rejects below the fee-earned floor even when the fee mode is known and quote-only", () => {
    const c = classifyApe(base({ feeModeKnown: true, quoteOnlyFee: true, feesEarnedPoolSol: 5 }), CFG);
    expect(c).toBeNull();
  });

  it("fails closed when fees-earned is itself unknown", () => {
    expect(classifyApe(base({ feesEarnedPoolSol: null }), CFG)).toBeNull();
  });
});

describe("classifyApe — fee mode detectable vs fallback", () => {
  it("rejects a both-tokens fee pool when the mode is known, regardless of fees earned", () => {
    const c = classifyApe(base({ feeModeKnown: true, quoteOnlyFee: false, feesEarnedPoolSol: 1000 }), CFG);
    expect(c).toBeNull();
  });

  it("logs fee_mode_unknown and relies on the (already-required) fee-earned floor when mode is undetectable", () => {
    const c = classifyApe(base({ feeModeKnown: false, feesEarnedPoolSol: 15 }), CFG);
    expect(c?.play).toBe("eys_ape");
    expect(c?.feeModeUnknown).toBe(true);
  });
});

describe("classifyApe — range feasibility", () => {
  it("rejects when a token-sided range above price can't be built", () => {
    expect(classifyApe(base({ oneSidedFeasible: false }), CFG)).toBeNull();
  });
});

describe("classifyApe — priority field", () => {
  it("gives Stonks candidates priority=1 and Meteora candidates priority=0 when ape_stonks_priority is on", () => {
    expect(classifyApe(base({ source: "stonks" }), CFG)?.priority).toBe(1);
    expect(classifyApe(base({ source: "meteora" }), CFG)?.priority).toBe(0);
  });

  it("gives no priority boost when ape_stonks_priority is off", () => {
    const cfg = { ...CFG, ape_stonks_priority: false };
    expect(classifyApe(base({ source: "stonks" }), cfg)?.priority).toBe(0);
  });
});

describe("compareApeCandidates — Stonks ranks ahead of an equal-score Meteora candidate", () => {
  it("Stonks wins on equal score", () => {
    const stonks = { priority: 1, score: 70 };
    const meteora = { priority: 0, score: 70 };
    expect(compareApeCandidates(stonks, meteora)).toBeLessThan(0); // stonks sorts first
    expect(compareApeCandidates(meteora, stonks)).toBeGreaterThan(0);
  });

  it("falls back to score when priority is tied", () => {
    const a = { priority: 0, score: 80 };
    const b = { priority: 0, score: 60 };
    expect(compareApeCandidates(a, b)).toBeLessThan(0);
  });

  it("priority beats a higher score (Stonks-first is a hard rule, not a tiebreak)", () => {
    const stonksLowScore = { priority: 1, score: 50 };
    const meteoraHighScore = { priority: 0, score: 99 };
    expect(compareApeCandidates(stonksLowScore, meteoraHighScore)).toBeLessThan(0);
  });
});
