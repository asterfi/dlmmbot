/**
 * Jev policy — composite scoring in CODE, per docs.typesafe.ai/patterns/
 * composite-scoring. The model answers atomic questions (raw nouls/choice);
 * every threshold, weight, and veto rule lives here, pure and unit-testable,
 * never asked of the model.
 */
import type { Play } from "../combo/plays.js";

export interface JevEntryAnswers {
  redflags: Record<string, number>;   // noul values, 0..1
  positives: Record<string, number>;  // noul values, 0..1
  playChoice: string;
  playProbabilities: Record<string, number>;
  playConfidence: number;
}

export interface JevPolicyWeights {
  fresh_flow: number;
  fee_generation: number;
  bounce: number;
  narrative: number;
}

export interface JevEntryPolicyConfig {
  redflag_veto: number;        // any redflag noul >= this => reject outright
  play_prob_min: number;       // choice must agree, or its probability for the rule's play must clear this
  uncertain_low: number;       // composite score inside [low, high] => genuinely uncertain (docs: noul ~0.5)
  uncertain_high: number;
  weights: JevPolicyWeights;
  thresholds: Record<Play, number>; // per-play composite-score bar (eys_ape stricter — riskiest)
}

export type JevEntryPolicyOutcome =
  | { decision: "approve"; compositeScore: number }
  | { decision: "reject"; reasonCode: "redflag_veto" | "below_threshold" | "play_mismatch"; compositeScore: number; detail: string }
  | { decision: "uncertain"; compositeScore: number };

export function compositeScore(positives: Record<string, number>, w: JevPolicyWeights): number {
  return (
    w.fresh_flow * (positives.positive_fresh_flow ?? 0) +
    w.fee_generation * (positives.positive_fee_generation_sol ?? 0) +
    w.bounce * (positives.positive_bounce_confirmed ?? 0) +
    w.narrative * (positives.positive_narrative_strength ?? 0)
  );
}

export function evaluateEntryPolicy(
  rulePlay: Play,
  answers: JevEntryAnswers,
  cfg: JevEntryPolicyConfig,
): JevEntryPolicyOutcome {
  for (const [id, v] of Object.entries(answers.redflags)) {
    if (v >= cfg.redflag_veto) {
      return { decision: "reject", reasonCode: "redflag_veto", compositeScore: 0, detail: `${id}=${v.toFixed(2)}` };
    }
  }

  const agrees = answers.playChoice === rulePlay || (answers.playProbabilities[rulePlay] ?? 0) >= cfg.play_prob_min;
  if (!agrees) {
    return {
      decision: "reject", reasonCode: "play_mismatch", compositeScore: 0,
      detail: `jev chose ${answers.playChoice} (p[${rulePlay}]=${(answers.playProbabilities[rulePlay] ?? 0).toFixed(2)})`,
    };
  }

  const score = compositeScore(answers.positives, cfg.weights);
  if (score >= cfg.uncertain_low && score <= cfg.uncertain_high) {
    return { decision: "uncertain", compositeScore: score };
  }
  const threshold = cfg.thresholds[rulePlay];
  if (score >= threshold) return { decision: "approve", compositeScore: score };
  return { decision: "reject", reasonCode: "below_threshold", compositeScore: score, detail: `${score.toFixed(3)} < ${threshold}` };
}

export interface JevExitAnswers {
  thesisBroken: number;
  flowDead: number;
  actionChoice: string;
  actionConfidence: number;
}

export interface JevExitPolicyConfig {
  redflag_veto: number;
  uncertain_low: number;
  uncertain_high: number;
}

export type JevExitPolicyOutcome = "exit" | "hold" | "uncertain";

/**
 * "If Jev is uncertain, follow the rule exit" (owner's instruction) — the
 * caller (jevConsult) resolves "uncertain" to the rule's own verdict for the
 * exit lane, since a rule trigger has already fired before this is ever
 * called; "uncertain" here is telemetry (outcome tag), not a fallback.
 */
export function evaluateExitPolicy(answers: JevExitAnswers, cfg: JevExitPolicyConfig): JevExitPolicyOutcome {
  if (answers.thesisBroken >= cfg.redflag_veto) return "exit";
  const uncertain =
    (answers.flowDead >= cfg.uncertain_low && answers.flowDead <= cfg.uncertain_high) ||
    answers.actionConfidence < 0.5;
  if (uncertain) return "uncertain";
  return answers.actionChoice === "close_now" || answers.flowDead >= 0.5 ? "exit" : "hold";
}
