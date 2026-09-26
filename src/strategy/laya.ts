import { config } from "../config.js";

export type LayaMode = "off" | "shadow" | "gate";
export type LayaStage = "reject" | "anchor" | "tight" | "breakout" | "dump-bonus";

export interface LayaApproval {
  approved: boolean;
  approvalProbability?: number;
  stage?: LayaStage;
  confidence?: number;
  model?: string;
  reason?: string;
}

export interface LayaGateResult {
  accepted: boolean;
  reason?: string;
}

export interface LayaRequestSnapshot {
  strategy: "eys";
  discovery: Record<string, unknown>;
  candidate: Record<string, unknown>;
  evidence: Record<string, unknown>;
  hardGates: Record<string, unknown>;
  risk: Record<string, unknown>;
  range: Record<string, unknown>;
}

export interface LayaEvaluation {
  attempted: boolean;
  latencyMs: number | null;
  result: LayaApproval;
  error?: string;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function finiteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function stage(value: unknown): LayaStage | null {
  return value === "reject" || value === "anchor" || value === "tight" ||
    value === "breakout" || value === "dump-bonus" ? value : null;
}

/** Validate the small response contract exposed by the localhost Laya wrapper. */
export function parseLayaResponse(value: unknown): LayaApproval {
  const envelope = objectRecord(value);
  const answers = objectRecord(envelope?.answers);
  if (!envelope || !answers) return { approved: false, reason: "laya_response_invalid_envelope" };

  const trade = objectRecord(answers.trade);
  if (!trade || trade.type !== "noul") {
    return { approved: false, reason: "laya_response_missing_trade_answer" };
  }
  const approvalProbability = trade.noul;
  if (!finiteProbability(approvalProbability)) {
    return { approved: false, reason: "laya_response_invalid_trade_probability" };
  }

  const stageAnswer = objectRecord(answers.stage);
  const selectedStage = stage(stageAnswer?.choice);
  if (!stageAnswer || stageAnswer.type !== "choice" || !selectedStage) {
    return { approved: false, reason: "laya_response_missing_stage_answer" };
  }
  const confidence = stageAnswer.confidence;
  if (!finiteProbability(confidence)) {
    return { approved: false, reason: "laya_response_invalid_stage_confidence" };
  }

  return {
    approved: approvalProbability >= 0.5 && selectedStage !== "reject",
    approvalProbability,
    stage: selectedStage,
    confidence,
    model: typeof envelope.model === "string" ? envelope.model : undefined,
  };
}

/**
 * Laya can veto in explicit gate mode. Off and shadow modes never change the
 * core admission result; malformed/unavailable output is still observable by
 * the caller and becomes a rejection only when gate mode is selected.
 */
export function decideLayaGate(
  mode: LayaMode,
  result: LayaApproval,
  minApprovalProbability = 0.5,
): LayaGateResult {
  if (mode !== "gate") return { accepted: true };
  if (!result.approved) return { accepted: false, reason: result.reason ?? "laya_rejected" };
  if (!finiteProbability(minApprovalProbability) ||
      result.approvalProbability == null || result.approvalProbability < minApprovalProbability) {
    return { accepted: false, reason: "laya_probability_below_threshold" };
  }
  return { accepted: true };
}

export function layaMode(): LayaMode {
  const mode = config().laya?.mode;
  return mode === "shadow" || mode === "gate" ? mode : "off";
}

/** Exit-side advisory. `shouldExit` is false on every parse failure path. */
export interface LayaExitAdvice {
  shouldExit: boolean;
  probability?: number;
  confidence?: number;
  action?: "rotate" | "hold";
  reason?: string;
  model?: string;
}

/** Exit-side consult budget flag. 0/absent keeps exits rule-based. */
export function exitAuthorityEnabled(): boolean {
  const value = config().laya?.exit_authority;
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function buildLayaRequest(snapshot: LayaRequestSnapshot): Record<string, unknown> {
  return {
    model: "laya-typed-decisions",
    state: snapshot,
    questions: {
      trade: {
        type: "noul",
        instructions: "Given the complete validated Eys snapshot, is this a qualified trade setup worth sending to the core executor?",
        criteria: {
          true: "The exact pool, fresh flow, safety evidence, executable economics, and Eys stage form a coherent setup.",
          false: "The setup is contradictory, decaying, unsafe, stale, or not sufficiently evidenced.",
        },
      },
      stage: {
        type: "choice",
        instructions: "Which Eys stage is justified by the supplied snapshot?",
        criteria: {
          reject: "Do not open; evidence is incomplete, contradictory, or the thesis is invalid.",
          anchor: "Initial SOL-side Spot anchor is justified.",
          tight: "Additional SOL-side tight position is justified by sustained strength.",
          breakout: "A qualified upward breakout justifies a token-side stage, subject to a separate core funding path.",
          "dump-bonus": "A SOL-side dump-bonus range is justified near a qualified high/dump context.",
        },
      },
    },
  };
}

/**
 * Effective sidecar timeout for one decision.
 *
 * Ceiling raised 2s -> 6s (2026-09-23): the full modelSnapshot answers in
 * 4.7-5.1s on the int8 ONNX sidecar, so the old 2s hard cap aborted every
 * real proposal fail-closed (3x strategy_laya_unavailable) before the model
 * could answer. Default stays 750ms; floor stays 50ms.
 *
 * Ceiling raised 6s -> 9s (2026-09-25): re-measured over 423 live decisions
 * the model had outgrown the 6s it was raised to cover — p50 5412ms, p90
 * 6001ms, p95 6003ms, with 47 decisions landing at >=6000ms. `latencyMs` is
 * stamped at return while the abort timer starts at function entry, so those
 * 47 cleared the bar only because Node delivered the timer a few ms late;
 * one scheduling tick the other way and they record `laya_unavailable` and
 * the entry is dropped fail-closed. The cost of the extra 3s is paid only on
 * a path that already fails, so it buys real headroom for nothing.
 */
export function layaTimeoutMs(configured: unknown): number {
  return typeof configured === "number" && Number.isFinite(configured)
    ? Math.min(9_000, Math.max(50, configured))
    : 750;
}

function localSidecarBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === "localhost" || hostname === "127.0.0.1" ||
      hostname === "[::1]" || hostname === "::1";
    if (url.protocol !== "http:" || !loopback || url.username || url.password) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export async function requestLaya(snapshot: LayaRequestSnapshot): Promise<LayaEvaluation> {
  const mode = layaMode();
  if (mode === "off") {
    return { attempted: false, latencyMs: null, result: { approved: true, reason: "laya_disabled" } };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timeoutMs = layaTimeoutMs(config().laya?.timeout_ms);
  const baseUrl = localSidecarBaseUrl(config().laya?.base_url);
  if (!baseUrl) {
    return {
      attempted: false,
      latencyMs: 0,
      result: { approved: false, reason: "laya_invalid_local_url" },
    };
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildLayaRequest(snapshot)),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        attempted: true,
        latencyMs: Date.now() - started,
        result: { approved: false, reason: "laya_http_error" },
        error: `HTTP ${response.status}`,
      };
    }
    let body: unknown;
    try {
      const text = await response.text();
      if (text.length > 128 * 1024) throw new Error("response_too_large");
      body = JSON.parse(text) as unknown;
    } catch {
      return {
        attempted: true,
        latencyMs: Date.now() - started,
        result: { approved: false, reason: "laya_invalid_json" },
      };
    }
    return { attempted: true, latencyMs: Date.now() - started, result: parseLayaResponse(body) };
  } catch (error) {
    return {
      attempted: true,
      latencyMs: Date.now() - started,
      result: { approved: false, reason: "laya_unavailable" },
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exit-side request: "rotate now, or hold?" instead of the entry question.
 * Answers are keyed by question name, so this is additive to the entry path —
 * the sidecar contract (`{model, state, questions}` -> `answers.<key>`) does
 * not care which keys we ask for.
 */
export function buildExitLayaRequest(state: Record<string, unknown>): Record<string, unknown> {
  return {
    model: "laya-typed-decisions",
    state,
    questions: {
      exit: {
        type: "noul",
        instructions:
          "Given this live open position and its pool-health snapshot, is rotating out now better than holding?",
        criteria: {
          true: "The fee/volume decay is persistent, and holding is expected to give back principal or unclaimed fees.",
          false: "The decay looks transient, or the position still has range and fee life worth keeping.",
        },
      },
      action: {
        type: "choice",
        instructions: "What should happen to this open position right now?",
        criteria: {
          rotate: "Close it now; the decay is real and further holding is expected to lose value.",
          hold: "Keep it open and leave the rule-based exit ladder in charge.",
        },
      },
    },
  };
}

/**
 * Exit-side response contract. Fail-closed by construction: every malformed,
 * missing or ambiguous field returns `shouldExit: false`, which reads as
 * "hold" — i.e. exactly the rule-based behavior we have today. A broken model
 * can therefore never cause a close it did not actually ask for.
 */
export function parseLayaExitResponse(value: unknown): LayaExitAdvice {
  const envelope = objectRecord(value);
  const answers = objectRecord(envelope?.answers);
  if (!envelope || !answers) return { shouldExit: false, reason: "laya_response_invalid_envelope" };

  const exitAnswer = objectRecord(answers.exit);
  if (!exitAnswer || exitAnswer.type !== "noul") {
    return { shouldExit: false, reason: "laya_response_missing_exit_answer" };
  }
  const probability = exitAnswer.noul;
  if (!finiteProbability(probability)) {
    return { shouldExit: false, reason: "laya_response_invalid_exit_probability" };
  }

  const actionAnswer = objectRecord(answers.action);
  if (!actionAnswer || actionAnswer.type !== "choice" ||
      (actionAnswer.choice !== "rotate" && actionAnswer.choice !== "hold")) {
    return { shouldExit: false, reason: "laya_response_missing_action_answer" };
  }
  const confidence = actionAnswer.confidence;
  if (confidence !== undefined && !finiteProbability(confidence)) {
    return { shouldExit: false, reason: "laya_response_invalid_action_confidence" };
  }

  return {
    shouldExit: actionAnswer.choice === "rotate" && probability >= 0.5,
    probability,
    confidence: typeof confidence === "number" ? confidence : undefined,
    action: actionAnswer.choice,
    model: typeof envelope.model === "string" ? envelope.model : undefined,
  };
}

/**
 * Pure gate for the exit hook — deliberately mirrors `decideLayaGate`.
 * Authority is checked independently of the model's answer so that turning
 * `exit_authority` off is a complete, immediate rollback regardless of what
 * the model returns.
 */
export function decideLayaExit(
  mode: LayaMode,
  exitAuthority: boolean,
  advice: LayaExitAdvice,
): { act: boolean; reason: string } {
  if (mode === "off") return { act: false, reason: "laya_disabled" };
  if (!exitAuthority) return { act: false, reason: "exit_authority_disabled" };
  if (!advice.shouldExit) return { act: false, reason: advice.reason ?? "laya_hold" };
  return { act: true, reason: "laya_exit_advised" };
}

export async function requestLayaExit(
  state: Record<string, unknown>,
): Promise<{ attempted: boolean; latencyMs: number | null; advice: LayaExitAdvice; error?: string }> {
  const mode = layaMode();
  if (mode === "off") {
    return { attempted: false, latencyMs: null, advice: { shouldExit: false, reason: "laya_disabled" } };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timeoutMs = layaTimeoutMs(config().laya?.timeout_ms);
  const baseUrl = localSidecarBaseUrl(config().laya?.base_url);
  if (!baseUrl) {
    return { attempted: false, latencyMs: 0, advice: { shouldExit: false, reason: "laya_invalid_local_url" } };
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildExitLayaRequest(state)),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        attempted: true,
        latencyMs: Date.now() - started,
        advice: { shouldExit: false, reason: "laya_http_error" },
        error: `HTTP ${response.status}`,
      };
    }
    let body: unknown;
    try {
      const text = await response.text();
      if (text.length > 128 * 1024) throw new Error("response_too_large");
      body = JSON.parse(text) as unknown;
    } catch {
      return { attempted: true, latencyMs: Date.now() - started, advice: { shouldExit: false, reason: "laya_invalid_json" } };
    }
    return { attempted: true, latencyMs: Date.now() - started, advice: parseLayaExitResponse(body) };
  } catch (error) {
    return {
      attempted: true,
      latencyMs: Date.now() - started,
      advice: { shouldExit: false, reason: "laya_unavailable" },
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
