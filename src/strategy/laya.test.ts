import { describe, expect, it } from "vitest";
import {
  buildLayaRequest,
  decideLayaGate,
  parseLayaResponse,
  type LayaMode,
} from "./laya.js";

describe("Laya decision boundary", () => {
  it("accepts only an explicit approved typed response", () => {
    const parsed = parseLayaResponse({
      model: "laya-typed-decisions",
      answers: {
        trade: { type: "noul", noul: 0.96 },
        stage: {
          type: "choice",
          choice: "anchor",
          confidence: 0.91,
          probabilities: { anchor: 0.91, reject: 0.09 },
        },
      },
    });

    expect(parsed).toEqual({
      approved: true,
      approvalProbability: 0.96,
      stage: "anchor",
      confidence: 0.91,
      model: "laya-typed-decisions",
    });
  });

  it("fails closed on malformed, missing, or non-finite model output", () => {
    expect(parseLayaResponse({ answers: {} })).toEqual({
      approved: false,
      reason: "laya_response_missing_trade_answer",
    });
    expect(parseLayaResponse({
      answers: { trade: { type: "noul", noul: Number.NaN } },
    })).toEqual({
      approved: false,
      reason: "laya_response_invalid_trade_probability",
    });
    expect(parseLayaResponse(null)).toEqual({
      approved: false,
      reason: "laya_response_invalid_envelope",
    });
  });

  it("uses Laya as a veto only in gate mode and never lets shadow mode block", () => {
    const approved = { approved: true as const, approvalProbability: 0.91, stage: "anchor" as const, confidence: 0.9, model: "laya" };
    const rejected = { approved: false as const, reason: "laya_rejected" };

    const modes: Array<[LayaMode, boolean, boolean]> = [
      ["off", true, true],
      ["shadow", true, true],
      ["shadow", false, true],
      ["gate", true, true],
      ["gate", false, false],
    ];
    for (const [mode, modelAvailable, expected] of modes) {
      const result = decideLayaGate(mode, modelAvailable ? approved : rejected);
      expect(result.accepted, `${mode}/${modelAvailable}`).toBe(expected);
    }
    expect(decideLayaGate("gate", approved, 0.95)).toEqual({
      accepted: false,
      reason: "laya_probability_below_threshold",
    });
  });

  it("builds one bounded typed-decision request from the normalized snapshot", () => {
    const request = buildLayaRequest({
      strategy: "eys",
      discovery: { sweptPools: 300, provider: "gmgn" },
      candidate: { mint: "mint", pool: "pool" },
      evidence: { flowUsdPerMin: 125_000, flowCadence: "1m" },
      hardGates: { exactPool: true, safety: "pass" },
      risk: { requestedSizeSol: 0.1, reserveOk: true },
      range: { shape: "spot", fundingSide: "sol" },
    });

    expect(request.model).toBe("laya-typed-decisions");
    expect(request.state).toMatchObject({ strategy: "eys" });
    expect(request.questions).toHaveProperty("trade");
    expect(request.questions).toHaveProperty("stage");
  });
});
