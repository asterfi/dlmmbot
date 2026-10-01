import { describe, expect, it } from "vitest";
import { evaluateEntryPolicy, evaluateExitPolicy, compositeScore, type JevEntryAnswers, type JevEntryPolicyConfig, type JevExitAnswers, type JevExitPolicyConfig } from "./policy.js";

const ENTRY_CFG: JevEntryPolicyConfig = {
  redflag_veto: 0.6,
  play_prob_min: 0.3,
  uncertain_low: 0.45,
  uncertain_high: 0.55,
  weights: { fresh_flow: 0.3, fee_generation: 0.3, bounce: 0.25, narrative: 0.15 },
  thresholds: { molu_ladder: 0.6, danko_trap: 0.6, eys_seat: 0.55, eys_ape: 0.7 },
};

function answers(overrides: Partial<JevEntryAnswers> = {}): JevEntryAnswers {
  return {
    redflags: { redflag_wash_volume: 0.1, redflag_security: 0.1, redflag_exhausted_spike: 0.1, redflag_insider_dumping: 0.1 },
    positives: { positive_fresh_flow: 0.9, positive_fee_generation_sol: 0.9, positive_bounce_confirmed: 0.9, positive_narrative_strength: 0.5 },
    playChoice: "eys_seat",
    playProbabilities: { eys_seat: 0.9 },
    playConfidence: 0.9,
    ...overrides,
  };
}

describe("compositeScore", () => {
  it("weights sum correctly", () => {
    const score = compositeScore(
      { positive_fresh_flow: 1, positive_fee_generation_sol: 1, positive_bounce_confirmed: 1, positive_narrative_strength: 1 },
      ENTRY_CFG.weights,
    );
    expect(score).toBeCloseTo(1, 6);
  });

  it("defaults missing dimensions to 0", () => {
    expect(compositeScore({}, ENTRY_CFG.weights)).toBe(0);
  });
});

describe("evaluateEntryPolicy — redflag veto", () => {
  it("rejects outright when any redflag clears the veto threshold, regardless of strong positives", () => {
    const a = answers({ redflags: { redflag_wash_volume: 0.1, redflag_security: 0.65, redflag_exhausted_spike: 0.1, redflag_insider_dumping: 0.1 } });
    const r = evaluateEntryPolicy("eys_seat", a, ENTRY_CFG);
    expect(r.decision).toBe("reject");
    if (r.decision === "reject") expect(r.reasonCode).toBe("redflag_veto");
  });

  it("does not veto just under the threshold", () => {
    const a = answers({ redflags: { redflag_wash_volume: 0.59, redflag_security: 0.1, redflag_exhausted_spike: 0.1, redflag_insider_dumping: 0.1 } });
    const r = evaluateEntryPolicy("eys_seat", a, ENTRY_CFG);
    expect(r.decision).not.toBe("reject");
  });
});

describe("evaluateEntryPolicy — play agreement", () => {
  it("rejects a clean play mismatch with low probability for the rule's play", () => {
    const a = answers({ playChoice: "none", playProbabilities: { eys_seat: 0.1, none: 0.9 } });
    const r = evaluateEntryPolicy("eys_seat", a, ENTRY_CFG);
    expect(r.decision).toBe("reject");
    if (r.decision === "reject") expect(r.reasonCode).toBe("play_mismatch");
  });

  it("accepts disagreement in choice when the rule's play still clears play_prob_min", () => {
    const a = answers({ playChoice: "molu_ladder", playProbabilities: { eys_seat: 0.35, molu_ladder: 0.5 } });
    const r = evaluateEntryPolicy("eys_seat", a, ENTRY_CFG);
    expect(r.decision).not.toBe("reject");
  });
});

describe("evaluateEntryPolicy — composite threshold and uncertainty", () => {
  it("approves when the composite score clears the play's threshold", () => {
    const r = evaluateEntryPolicy("eys_seat", answers(), ENTRY_CFG);
    expect(r.decision).toBe("approve");
  });

  it("rejects below the play's threshold", () => {
    const a = answers({ positives: { positive_fresh_flow: 0.1, positive_fee_generation_sol: 0.1, positive_bounce_confirmed: 0.1, positive_narrative_strength: 0.1 } });
    const r = evaluateEntryPolicy("eys_seat", a, ENTRY_CFG);
    expect(r.decision).toBe("reject");
    if (r.decision === "reject") expect(r.reasonCode).toBe("below_threshold");
  });

  it("is uncertain when the composite score lands inside the uncertain band", () => {
    // weights 0.3/0.3/0.25/0.15; pick positives so composite lands ~0.50
    const a = answers({ positives: { positive_fresh_flow: 0.5, positive_fee_generation_sol: 0.5, positive_bounce_confirmed: 0.5, positive_narrative_strength: 0.5 } });
    const r = evaluateEntryPolicy("eys_seat", a, ENTRY_CFG);
    expect(r.decision).toBe("uncertain");
  });

  it("applies a stricter threshold for eys_ape than eys_seat", () => {
    // composite ~0.63: clears eys_seat (0.55) and molu/danko (0.6) but not eys_ape (0.7)
    const a = answers({ positives: { positive_fresh_flow: 0.7, positive_fee_generation_sol: 0.7, positive_bounce_confirmed: 0.6, positive_narrative_strength: 0.3 }, playChoice: "eys_ape", playProbabilities: { eys_ape: 0.9 } });
    const seatVerdict = evaluateEntryPolicy("eys_seat", { ...a, playChoice: "eys_seat", playProbabilities: { eys_seat: 0.9 } }, ENTRY_CFG);
    const apeVerdict = evaluateEntryPolicy("eys_ape", a, ENTRY_CFG);
    expect(seatVerdict.decision).toBe("approve");
    expect(apeVerdict.decision).not.toBe("approve");
  });
});

const EXIT_CFG: JevExitPolicyConfig = { redflag_veto: 0.6, uncertain_low: 0.45, uncertain_high: 0.55 };

function exitAnswers(overrides: Partial<JevExitAnswers> = {}): JevExitAnswers {
  return { thesisBroken: 0.1, flowDead: 0.8, actionChoice: "close_now", actionConfidence: 0.8, ...overrides };
}

describe("evaluateExitPolicy", () => {
  it("exits immediately on a broken-thesis red flag", () => {
    expect(evaluateExitPolicy(exitAnswers({ thesisBroken: 0.7 }), EXIT_CFG)).toBe("exit");
  });

  it("exits when flow is clearly dead and the choice agrees", () => {
    expect(evaluateExitPolicy(exitAnswers(), EXIT_CFG)).toBe("exit");
  });

  it("holds when flow is clearly alive and the choice agrees", () => {
    expect(evaluateExitPolicy(exitAnswers({ flowDead: 0.1, actionChoice: "hold" }), EXIT_CFG)).toBe("hold");
  });

  it("is uncertain when flow_dead sits in the uncertain band", () => {
    expect(evaluateExitPolicy(exitAnswers({ flowDead: 0.5 }), EXIT_CFG)).toBe("uncertain");
  });

  it("is uncertain when the choice's confidence is low, even with a clear flow reading", () => {
    expect(evaluateExitPolicy(exitAnswers({ flowDead: 0.9, actionConfidence: 0.3 }), EXIT_CFG)).toBe("uncertain");
  });
});
