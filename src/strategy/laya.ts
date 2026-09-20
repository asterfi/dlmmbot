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
  const configuredTimeout = config().laya?.timeout_ms;
  const timeoutMs = typeof configuredTimeout === "number" && Number.isFinite(configuredTimeout)
    ? Math.min(2_000, Math.max(50, configuredTimeout))
    : 750;
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
