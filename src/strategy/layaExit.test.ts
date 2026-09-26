import { describe, expect, it } from "vitest";
import {
  buildExitLayaRequest,
  decideLayaExit,
  parseLayaExitResponse,
  type LayaMode,
} from "./laya.js";

const rotate = (probability: number, confidence = 0.8) => ({
  model: "laya-typed-decisions",
  answers: {
    exit: { type: "noul", noul: probability },
    action: { type: "choice", choice: "rotate", confidence },
  },
});

const hold = (probability: number) => ({
  model: "laya-typed-decisions",
  answers: {
    exit: { type: "noul", noul: probability },
    action: { type: "choice", choice: "hold", confidence: 0.7 },
  },
});

describe("exit-side request", () => {
  it("asks an exit question keyed by name, not the entry question", () => {
    const request = buildExitLayaRequest({ phase: "exit_review" });
    expect(request.model).toBe("laya-typed-decisions");
    expect(request.state).toEqual({ phase: "exit_review" });
    const { exit: exitQuestion, action: actionQuestion } = request.questions as {
      exit: { type: string };
      action: { type: string; criteria: Record<string, string> };
    };
    expect(exitQuestion.type).toBe("noul");
    expect(actionQuestion.type).toBe("choice");
    expect(Object.keys(actionQuestion.criteria).sort()).toEqual(["hold", "rotate"]);
  });
});

describe("exit-side response contract", () => {
  it("accepts an explicit rotate with a usable probability", () => {
    expect(parseLayaExitResponse(rotate(0.91))).toEqual({
      shouldExit: true,
      probability: 0.91,
      confidence: 0.8,
      action: "rotate",
      model: "laya-typed-decisions",
    });
  });

  it("holds on an explicit hold regardless of probability", () => {
    const advice = parseLayaExitResponse(hold(0.8));
    expect(advice.shouldExit).toBe(false);
    expect(advice.action).toBe("hold");
  });

  it("holds when the model says rotate but with weak probability", () => {
    expect(parseLayaExitResponse(rotate(0.49)).shouldExit).toBe(false);
  });

  it("fails closed on malformed, missing, or non-finite model output", () => {
    expect(parseLayaExitResponse({ answers: {} })).toEqual({
      shouldExit: false,
      reason: "laya_response_missing_exit_answer",
    });
    expect(parseLayaExitResponse(undefined)).toEqual({
      shouldExit: false,
      reason: "laya_response_invalid_envelope",
    });
    expect(parseLayaExitResponse("nope")).toEqual({
      shouldExit: false,
      reason: "laya_response_invalid_envelope",
    });
    expect(parseLayaExitResponse({
      answers: { exit: { type: "noul", noul: Number.NaN } },
    })).toEqual({ shouldExit: false, reason: "laya_response_invalid_exit_probability" });
    expect(parseLayaExitResponse({
      answers: { exit: { type: "noul", noul: 0.9 }, action: { type: "choice", choice: "maybe" } },
    })).toEqual({ shouldExit: false, reason: "laya_response_missing_action_answer" });
    expect(parseLayaExitResponse({
      answers: {
        exit: { type: "noul", noul: 0.9 },
        action: { type: "choice", choice: "rotate", confidence: Number.NaN },
      },
    })).toEqual({ shouldExit: false, reason: "laya_response_invalid_action_confidence" });
  });

  it("holds when the noul envelope is present but not a noul answer", () => {
    expect(parseLayaExitResponse({
      answers: { exit: { type: "choice", choice: "rotate" } },
    })).toEqual({ shouldExit: false, reason: "laya_response_missing_exit_answer" });
  });
});

describe("exit authority gate", () => {
  const advisory = parseLayaExitResponse(rotate(0.9));
  const holding = parseLayaExitResponse(hold(0.1));

  it("never acts while Laya is disabled", () => {
    expect(decideLayaExit("off" as LayaMode, true, advisory)).toEqual({
      act: false,
      reason: "laya_disabled",
    });
  });

  it("never acts while exit_authority is off, even for an exit advice", () => {
    expect(decideLayaExit("gate" as LayaMode, false, advisory)).toEqual({
      act: false,
      reason: "exit_authority_disabled",
    });
  });

  it("acts only on enabled authority plus an exit advice", () => {
    expect(decideLayaExit("gate" as LayaMode, true, advisory)).toEqual({
      act: true,
      reason: "laya_exit_advised",
    });
  });

  it("leaves the rule-based ladder in charge when the model holds", () => {
    expect(decideLayaExit("gate" as LayaMode, true, holding)).toEqual({
      act: false,
      reason: "laya_hold",
    });
  });

  it("surfaces the parser's fail-closed reason rather than acting", () => {
    const broken = parseLayaExitResponse({ answers: {} });
    expect(decideLayaExit("gate" as LayaMode, true, broken)).toEqual({
      act: false,
      reason: "laya_response_missing_exit_answer",
    });
  });
});
