import { describe, expect, it } from "vitest";
import { classifyApe, type ApeCandidateFeatures, type ApeConfigLike } from "./ape.js";

const CFG: ApeConfigLike = { ape_fee_min_sol: 10 };

function base(overrides: Partial<ApeCandidateFeatures> = {}): ApeCandidateFeatures {
  return {
    feeModeKnown: true,
    quoteOnlyFee: true,
    feesEarnedPoolSol: null,
    oneSidedFeasible: true,
    ...overrides,
  };
}

describe("classifyApe — fee mode detectable (the normal DLMM case)", () => {
  it("accepts a quote-only (SOL) fee pool", () => {
    const c = classifyApe(base({ feeModeKnown: true, quoteOnlyFee: true }), CFG);
    expect(c?.play).toBe("eys_ape");
    expect(c?.feeModeUnknown).toBe(false);
  });

  it("rejects a both-tokens fee pool when the mode is known", () => {
    const c = classifyApe(base({ feeModeKnown: true, quoteOnlyFee: false }), CFG);
    expect(c).toBeNull();
  });

  it("never falls back to the fee-floor when the mode is known and fails", () => {
    const c = classifyApe(base({ feeModeKnown: true, quoteOnlyFee: false, feesEarnedPoolSol: 1000 }), CFG);
    expect(c).toBeNull();
  });
});

describe("classifyApe — fee mode undetectable (fallback path)", () => {
  it("logs fee_mode_unknown and requires the fee-earned floor instead", () => {
    const c = classifyApe(base({ feeModeKnown: false, feesEarnedPoolSol: 15 }), CFG);
    expect(c?.play).toBe("eys_ape");
    expect(c?.feeModeUnknown).toBe(true);
  });

  it("rejects below the fallback fee floor", () => {
    const c = classifyApe(base({ feeModeKnown: false, feesEarnedPoolSol: 9.99 }), CFG);
    expect(c).toBeNull();
  });

  it("fails closed when fees-earned is itself unknown", () => {
    const c = classifyApe(base({ feeModeKnown: false, feesEarnedPoolSol: null }), CFG);
    expect(c).toBeNull();
  });
});

describe("classifyApe — range feasibility", () => {
  it("rejects when a token-sided range above price can't be built", () => {
    const c = classifyApe(base({ oneSidedFeasible: false }), CFG);
    expect(c).toBeNull();
  });
});
