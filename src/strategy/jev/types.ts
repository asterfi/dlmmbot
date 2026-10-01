/**
 * Jev — Typesafe System One decision layer, per docs.typesafe.ai (api,
 * models, confidence, primitives/noul, patterns/composite-scoring).
 *
 * One request per decision (speculative fan-out): all questions in a lane's
 * battery are evaluated in parallel against one shared `state`, so adding
 * questions costs little latency. Composite scoring and all policy
 * thresholds live in code (strategy/jev/policy.ts), never in the model.
 */

export type JevLane = "enter" | "exit";

/** One question in a lane's battery. IDs are code-side only — never sent to the model. */
export interface JevQuestion {
  type: "noul" | "choice";
  instructions: unknown;
  criteria: unknown;
}

export interface JevNoulAnswer {
  type: "noul";
  /** docs/primitives/noul: a probability-like scalar in [0,1]; ~0.5 is genuinely uncertain, not "medium". */
  noul: number;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  /** docs/confidence: < 0.5 means the model itself is unsure of this choice. */
  confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer;

export type JevVerdict = "yes" | "no";

export type JevOutcome =
  | "ok"
  | "disabled"
  | "no_api_key"
  | "timeout"
  | "401"
  | "422"
  | "http_error"
  | "parse_error"
  | "rate_capped"
  | "uncertain";

export interface JevRawAnswers {
  answers: Record<string, unknown>;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
}

export interface JevConsultResult {
  consulted: boolean;
  verdict: JevVerdict;
  fallback: boolean;
  outcome: JevOutcome;
  latencyMs: number;
  reason: string;
  /** Present when consulted: full raw answers for later threshold/weight calibration (docs/AutoResearch). */
  raw?: JevRawAnswers;
  /** Entry lane only: Jev's own play choice, when it answered. */
  playChoice?: string | null;
  /** True when latencyMs exceeded the freshness budget — caller should re-validate price before acting. */
  slow: boolean;
}
