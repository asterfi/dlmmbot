/**
 * jevConsult — the combo strategy's single entry point into Jev (Typesafe
 * System One). Per docs.typesafe.ai: one request per decision, composite
 * scoring and every threshold in code (./policy.ts), uncertainty bands
 * distinct from transport failure, model pinned (not the `-latest` alias),
 * and full raw answers retained in `jev_decisions` for later calibration
 * against realized P&L.
 *
 * Fail-OPEN only on transport failure (timeout, 5xx-after-retries, malformed
 * response, no key, disabled) — logged with `fallback=true` and the specific
 * `outcome`. A genuine Jev answer that is uncertain is NOT a fallback: entry
 * uncertainty skips (outcome "uncertain"), exit uncertainty follows the rule
 * (the rule already decided to exit before this call happens).
 */
import { createHash } from "node:crypto";
import { config, type Config } from "../../config.js";
import { getDb, now } from "../../db/db.js";
import { alert } from "../../alerts.js";
import { jevRequest } from "./client.js";
import { questionsFor, JEV_QUESTION_VERSION } from "./questions.js";
import { evaluateEntryPolicy, evaluateExitPolicy, type JevEntryAnswers, type JevEntryPolicyConfig, type JevExitAnswers, type JevExitPolicyConfig } from "./policy.js";
import type { JevConsultResult, JevLane, JevNoulAnswer, JevChoiceAnswer, JevVerdict } from "./types.js";
import type { Play } from "../combo/plays.js";

const HARD_MAX_TIMEOUT_MS = 6000;
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_RESPONSE_BYTES = 131_072;
const DEFAULT_MAX_PER_MIN = 20;
/** Model pinned per docs.typesafe.ai: "-latest" moves on new releases; our thresholds are tuned per version. */
const PINNED_MODEL = "jev-1.13.0";
/** docs: latency past which a moved price invalidates the answer — caller re-checks drift. */
const FRESHNESS_LATENCY_MS = 5000;

let inFlight = 0;
const consultTimestamps: number[] = []; // sliding 60s window, per-minute consult cap

/** Test-only: clear module-level rate-limit/concurrency state between test files. */
export function _resetJevStateForTests(): void {
  inFlight = 0;
  consultTimestamps.length = 0;
}

function withinRateCap(maxPerMin: number): boolean {
  const cutoff = Date.now() - 60_000;
  while (consultTimestamps.length && consultTimestamps[0]! < cutoff) consultTimestamps.shift();
  return consultTimestamps.length < maxPerMin;
}

export interface JevConsultInput {
  lane: JevLane;
  /** Opaque structured state handed to the model. */
  state: Record<string, unknown>;
  /** What the rule engine would do absent Jev — used verbatim on every fail-open path. */
  fallbackVerdict: JevVerdict;
  /** Entry lane: the rule-classified play (policy checks Jev's own `play` choice against this). Exit lane: the position's play, for logging only. */
  play: Play | string;
  /**
   * Entry lane: soft-tier volume bar (owner, 2026-10-03). A candidate that only
   * cleared the DYNAMIC soft volume floor (not Eys's literal 100k/min) must
   * score at least this composite — the play's own threshold is raised to it,
   * never lowered.
   */
  minComposite?: number;
  /** Entry lane: every play the candidate qualifies for (owner, 2026-10-03). Jev's `play` choice question lists only these plus "none". */
  qualifyingPlays?: string[];
  positionId?: number | null;
  mint?: string | null;
  pool?: string | null;
  question: string;
}

function stateHash(state: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 16);
}

function recordRow(input: JevConsultInput, result: JevConsultResult, hash: string): void {
  try {
    getDb().prepare(
      `INSERT INTO jev_decisions (
         ts, position_id, lane, play, mint, pool, question, inputs_json,
         verdict, fallback, outcome, latency_ms, model, input_tokens, output_tokens,
         answers_json, state_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      now(),
      input.positionId ?? null,
      input.lane,
      String(input.play),
      input.mint ?? null,
      input.pool ?? null,
      input.question,
      JSON.stringify(input.state),
      result.verdict,
      result.fallback ? 1 : 0,
      result.outcome,
      result.latencyMs,
      result.raw?.model ?? null,
      result.raw?.inputTokens ?? null,
      result.raw?.outputTokens ?? null,
      result.raw ? JSON.stringify(result.raw.answers) : null,
      hash,
    );
  } catch (e) {
    console.error("[jev] failed to record jev_decisions row:", e);
  }
}

function fallback(input: JevConsultInput, outcome: JevConsultResult["outcome"], reason: string, latencyMs = 0): JevConsultResult {
  const result: JevConsultResult = {
    consulted: false, verdict: input.fallbackVerdict, fallback: true,
    outcome, latencyMs, reason, slow: false,
  };
  recordRow(input, result, stateHash(input.state));
  if (outcome !== "disabled") console.log(`[jev] ${input.lane} consult fell back to rules (${outcome}): ${reason}`);
  return result;
}

function noul(answers: Record<string, unknown>, id: string): number {
  const a = answers[id] as JevNoulAnswer | undefined;
  return a && a.type === "noul" && typeof a.noul === "number" && Number.isFinite(a.noul) ? a.noul : 0;
}

function entryPolicyConfig(): JevEntryPolicyConfig {
  const j = config().jev ?? ({} as NonNullable<Config["jev"]>);
  const thresholds = {
    eys_seat: j.entry_threshold_eys_seat ?? 0.55,
    eys_tight: j.entry_threshold_eys_tight ?? j.entry_threshold_eys_seat ?? 0.55,
    eys_breakout: j.entry_threshold_eys_breakout ?? 0.65, // token-sided second leg
    eys_ape: j.entry_threshold_eys_ape ?? 0.7, // stricter — riskiest (token-sided)
    eys_dump_bonus: j.entry_threshold_eys_dump_bonus ?? j.entry_threshold_eys_seat ?? 0.55,
  };
  return {
    redflag_veto: j.redflag_veto ?? 0.6,
    play_prob_min: j.play_prob_min ?? 0.3,
    uncertain_low: j.uncertain_low ?? 0.45,
    uncertain_high: j.uncertain_high ?? 0.55,
    weights: {
      fresh_flow: j.weight_fresh_flow ?? 0.3,
      fee_generation: j.weight_fee_generation ?? 0.3,
      bounce: j.weight_bounce ?? 0.25,
      narrative: j.weight_narrative ?? 0.15,
    },
    thresholds,
  };
}

function exitPolicyConfig(): JevExitPolicyConfig {
  const j = config().jev ?? ({} as NonNullable<Config["jev"]>);
  return {
    redflag_veto: j.redflag_veto ?? 0.6,
    uncertain_low: j.uncertain_low ?? 0.45,
    uncertain_high: j.uncertain_high ?? 0.55,
  };
}

async function alertOnce(kind: string, text: string): Promise<void> {
  try {
    await alert("info", text);
  } catch (e) {
    console.error(`[jev] ${kind} alert failed:`, e);
  }
}

/**
 * Consult Jev for one decision. Never throws — every transport failure
 * resolves to `input.fallbackVerdict` (fail-open); a genuine answer runs
 * through the composite-scoring policy (policy.ts) to produce the verdict.
 */
export async function jevConsult(input: JevConsultInput): Promise<JevConsultResult> {
  const j = config().jev;
  if (!j || j.enabled === false) return fallback(input, "disabled", "jev.enabled = false");
  if (!process.env.TYPESAFE_API_KEY) return fallback(input, "no_api_key", "TYPESAFE_API_KEY not set");

  const maxPerMin = j.max_consults_per_min ?? DEFAULT_MAX_PER_MIN;
  if (!withinRateCap(maxPerMin)) {
    return fallback(input, "rate_capped" as JevConsultResult["outcome"], `consult budget exhausted (${maxPerMin}/min)`);
  }
  const maxConcurrent = j.max_concurrent ?? DEFAULT_MAX_CONCURRENT;
  if (inFlight >= maxConcurrent) {
    return fallback(input, "disabled", `jev consult concurrency budget exhausted (${inFlight}/${maxConcurrent} in flight)`);
  }

  const timeoutMs = Math.min(j.timeout_ms ?? DEFAULT_TIMEOUT_MS, HARD_MAX_TIMEOUT_MS);
  const questions = questionsFor(input.lane, input.qualifyingPlays);
  const model = j.model ?? PINNED_MODEL;

  consultTimestamps.push(Date.now());
  inFlight++;
  try {
    const res = await jevRequest(
      { state: input.state, model, questions },
      { timeoutMs, maxResponseBytes: j.max_response_bytes ?? DEFAULT_MAX_RESPONSE_BYTES },
    );
    if (!res.ok) {
      if (res.error === "401") {
        await alertOnce("401", "Jev (Typesafe) rejected TYPESAFE_API_KEY (401) — consults are failing open to rules. Check the key.");
        return fallback(input, "401", "401 unauthorized", res.latencyMs);
      }
      if (res.error === "422") {
        console.error(`[jev] 422 from Typesafe (our bug) — body: ${res.detail?.slice(0, 2000)}`);
        await alertOnce("422", `Jev (Typesafe) returned 422 (likely a payload bug on our side) — consults failing open to rules. Detail: ${res.detail?.slice(0, 300)}`);
        return fallback(input, "422", `422: ${res.detail ?? ""}`, res.latencyMs);
      }
      const outcome = res.error === "no_api_key" ? "no_api_key"
        : res.error === "timeout" ? "timeout"
        : res.error.startsWith("parse_") ? "parse_error"
        : "http_error";
      return fallback(input, outcome, res.error, res.latencyMs);
    }

    const hash = stateHash(input.state);
    const slow = res.latencyMs > FRESHNESS_LATENCY_MS;
    const raw = { answers: res.answers, model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens };

    if (input.lane === "enter") {
      const redflags: Record<string, number> = {};
      for (const id of ["redflag_wash_volume", "redflag_security", "redflag_exhausted_spike", "redflag_insider_dumping", "redflag_stablecoin_major"]) {
        redflags[id] = noul(res.answers, id);
      }
      const positives: Record<string, number> = {};
      for (const id of ["positive_fresh_flow", "positive_fee_generation_sol", "positive_bounce_confirmed", "positive_narrative_strength"]) {
        positives[id] = noul(res.answers, id);
      }
      const playAns = res.answers.play as JevChoiceAnswer | undefined;
      const answers: JevEntryAnswers = {
        redflags, positives,
        playChoice: playAns?.choice ?? "none",
        playProbabilities: playAns?.probabilities ?? {},
        playConfidence: playAns?.confidence ?? 0,
      };
      const policyCfg = entryPolicyConfig();
      if (input.minComposite !== undefined) {
        const p = input.play as Play;
        policyCfg.thresholds = { ...policyCfg.thresholds, [p]: Math.max(policyCfg.thresholds[p] ?? 0, input.minComposite) };
      }
      const outcome = evaluateEntryPolicy(input.play as Play, answers, policyCfg);
      let result: JevConsultResult;
      if (outcome.decision === "approve") {
        result = { consulted: true, verdict: "yes", fallback: false, outcome: "ok", latencyMs: res.latencyMs, slow, raw,
          playChoice: answers.playChoice,
          reason: `approved (composite=${outcome.compositeScore.toFixed(3)}, model=${res.model ?? model}, ${res.latencyMs}ms)` };
      } else if (outcome.decision === "uncertain") {
        // Owner's decision (2026-10-02): the strategy should be aggressive
        // like the authors, not conservative. For SOL-side plays an uncertain
        // composite defers to the play's own rules (enter) rather than
        // skipping; eys_ape (token-sided, no stop-loss) keeps the
        // conservative skip. Config-driven, per-play overridable.
        const mode = input.play === "eys_ape" || input.play === "eys_breakout"
          ? (j.ape_uncertain_entry ?? "skip")
          : (j.uncertain_entry ?? "rules");
        if (mode === "rules") {
          result = { consulted: true, verdict: "yes", fallback: false, outcome: "jev_uncertain_rules_enter", latencyMs: res.latencyMs, slow, raw,
            playChoice: answers.playChoice,
            reason: `uncertain (composite=${outcome.compositeScore.toFixed(3)} in band) — deferring to ${input.play}'s own rules (uncertain_entry=rules)` };
        } else {
          result = { consulted: true, verdict: "no", fallback: false, outcome: "uncertain", latencyMs: res.latencyMs, slow, raw,
            playChoice: answers.playChoice,
            reason: `uncertain (composite=${outcome.compositeScore.toFixed(3)} in band) — entry skipped (uncertain_entry=skip)` };
        }
      } else {
        result = { consulted: true, verdict: "no", fallback: false, outcome: "ok", latencyMs: res.latencyMs, slow, raw,
          playChoice: answers.playChoice,
          reason: `rejected (${outcome.reasonCode}${outcome.detail ? `: ${outcome.detail}` : ""})` };
      }
      recordRow(input, result, hash);
      return result;
    }

    // exit lane
    const actionAns = res.answers.exit_action as JevChoiceAnswer | undefined;
    const exitAnswers: JevExitAnswers = {
      thesisBroken: noul(res.answers, "redflag_thesis_broken"),
      flowDead: noul(res.answers, "exit_flow_dead"),
      actionChoice: actionAns?.choice ?? "hold",
      actionConfidence: actionAns?.confidence ?? 0,
    };
    const exitOutcome = evaluateExitPolicy(exitAnswers, exitPolicyConfig());
    let result: JevConsultResult;
    if (exitOutcome === "uncertain") {
      // "If Jev is uncertain, follow the rule exit" — the rule already decided
      // to exit before this call happens, so uncertain resolves to yes.
      result = { consulted: true, verdict: input.fallbackVerdict, fallback: false, outcome: "uncertain", latencyMs: res.latencyMs, slow, raw,
        reason: "uncertain — following the rule's own exit trigger" };
    } else {
      result = { consulted: true, verdict: exitOutcome === "exit" ? "yes" : "no", fallback: false, outcome: "ok", latencyMs: res.latencyMs, slow, raw,
        reason: `${exitOutcome} (thesis_broken=${exitAnswers.thesisBroken.toFixed(2)}, flow_dead=${exitAnswers.flowDead.toFixed(2)}, action=${exitAnswers.actionChoice})` };
    }
    recordRow(input, result, hash);
    return result;
  } catch (e) {
    return fallback(input, "http_error", e instanceof Error ? e.message : "unknown error");
  } finally {
    inFlight--;
  }
}

export { JEV_QUESTION_VERSION };
