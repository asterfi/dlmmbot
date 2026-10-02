/**
 * Jev question batteries — ONE request per decision (docs.typesafe.ai:
 * questions in a battery are evaluated in parallel against one shared
 * `state`, so a richer battery costs little extra latency). IDs are code-side
 * only; every question's `instructions` is self-contained and references
 * `state` by backticked path (e.g. `pool.fees_24h_sol`).
 *
 * ENTRY battery = atomic red-flag nouls + atomic positive nouls + one Choice
 * `play` (eys_seat | eys_breakout | eys_tight | eys_ape | eys_dump_bonus | none). Composite
 * scoring and the red-flag veto are policy, computed in code from these raw
 * answers (strategy/jev/policy.ts) — never asked of the model directly.
 */
import type { JevLane, JevQuestion } from "./types.js";

export const JEV_QUESTION_VERSION = "combo-v2";

const ENTRY: Record<string, JevQuestion> = {
  redflag_wash_volume: {
    type: "noul",
    instructions: {
      question: "Do `pool` and `flow` show signs of wash or fake volume — volume that is busy but earns little real fee, or suspiciously mechanical/constant flow?",
      focus: "Judge the volume quality, not the numeric floors (those are enforced in code).",
    },
    criteria: {
      true: "Volume looks bought, farmed, or mechanically constant rather than organic.",
      false: "Volume and fee take tell one consistent, organic story.",
    },
  },
  redflag_security: {
    type: "noul",
    instructions: {
      question: "Does `vet` show rug/security red flags for a position that must be exitable — live mint/freeze authority, concentrated holders, insider clusters, an unproven or previously-rugging creator?",
      inspect: "`vet`",
    },
    criteria: {
      true: "Serious exit-risk signals are present in the vet record.",
      false: "The record shows a renounced, distributed, exit-safe token with a clean creator history.",
    },
  },
  redflag_exhausted_spike: {
    type: "noul",
    instructions: "Judging `candle_summary` and `flow`, has this token already made its move and is now exhausted — a blow-off spike that is rolling over rather than one keeping an upward trend? (Eys wants strong upward spikes that maintain an upward trend; a fresh breakout is fine, a finished one is not.)",
    criteria: {
      true: "The move already happened and is fading; this is chasing a top.",
      false: "There is a coherent, not-yet-exhausted setup: an active spike or steady uptrend with volume still behind it.",
    },
  },
  redflag_insider_dumping: {
    type: "noul",
    instructions: "Do `vet` and `flow` show signs that insiders, the dev, or early/fresh whale wallets are currently distributing (selling into the move) rather than holding?",
    criteria: {
      true: "Clear signs of insider/whale distribution happening now.",
      false: "No such signal, or holders are accumulating/holding.",
    },
  },
  redflag_stablecoin_major: {
    type: "noul",
    instructions: {
      question: "Is `candidate` actually a stablecoin, a wrapped major asset (wrapped BTC/ETH), or a liquid-staking/major token (e.g. SOL itself, mSOL, jitoSOL) — NOT a memecoin or a new launch?",
      focus: "Judge from `candidate.symbol`, `candidate.mcap_usd`, and `candidate.age_hours` as a whole: an old, enormous-mcap, well-known asset is a major, not a launch, regardless of how its other numbers look.",
    },
    criteria: {
      true: "This is a stablecoin, wrapped major, or liquid-staking/major token — not a memecoin.",
      false: "This is a genuine memecoin or new token launch.",
    },
  },
  positive_fresh_flow: {
    type: "noul",
    instructions: "Does `flow` show genuine, fresh buying interest behind `candidate` right now — not a stale or finished spike?",
    criteria: {
      true: "Recent flow is consistent with live buyers stepping in.",
      false: "Flow looks stale, directionless, or already finished.",
    },
  },
  positive_fee_generation_sol: {
    type: "noul",
    instructions: "Judging `pool.fee_tvl_24h_pct`, `pool.fees_24h_sol`, and the pool's fee-collection mode (`pool.quote_only_fee`), is this pool genuinely generating meaningful SOL-denominated fee income right now?",
    criteria: {
      true: "Fee generation in SOL is real and proportionate to the volume story.",
      false: "Fee generation is thin, inconsistent with the volume, or not really in SOL.",
    },
  },
  positive_bounce_confirmed: {
    type: "noul",
    instructions: "Judging `candle_summary`, is the current price action healthy enough to enter an Eys play — steady or trending up inside a pump, not free-falling or chaotic? For eys_dump_bonus (a wide Bid-Ask placed near the top as volume fades) judge only that price is still near its high and not already collapsing.",
    criteria: {
      true: "Price action is steady/uptrending (or, for the dump bonus, still near its high).",
      false: "Free-fall, a collapse already under way, or too chaotic to enter.",
    },
  },
  positive_narrative_strength: {
    type: "noul",
    instructions: "Judging only `candidate.symbol`, `candidate.name_or_socials` (if present) and nothing else speculative, does this token have any recognizable narrative/lore strength (a real meme, a notable name, visible community signal) versus being a generic, unremarkable ticker?",
    criteria: {
      true: "Some real narrative/lore/name strength is visible.",
      false: "Nothing notable, or the field is empty/unavailable — treat absence as neutral-low, not as a red flag.",
    },
  },
  play: {
    type: "choice",
    instructions: {
      question: "Given everything in `state`, which play (if any) best fits this candidate right now? This is advisory — it must AGREE with the rule engine's own classification (`candidate.rule_play`) or the model's own probability for that play must be meaningfully non-trivial; a clean disagreement is a reason to skip, not to override the rules.",
      playbook: "`playbook`",
    },
    criteria: {
      eys_seat: "First entry: Spot SOL-side default range below price on a token with real SOL fee income and high per-minute volume; quick in-and-out at +1-3% green.",
      eys_breakout: "Second, token-sided entry on a token whose seat is open: price broke above the seat's range on 3x volume and a strong spike; the seat stays as the backup.",
      eys_tight: "Spot SOL-side tight range (10-20 bins) on a token watched 1-2 minutes with no major dump, still chopping in a small pump-and-dump range.",
      eys_ape: "Riskiest: token-sided ape into a launchpad graduate whose pool collects SOL-only fees, selling into the pump above price. Token-sided, can go to zero.",
      eys_dump_bonus: "Bonus: volume peaked and is slowing while price is still near its high — a wide -85%/-90% Bid-Ask SOL-side ladder, waiting for the bounce.",
      none: "No coherent play fits — this candidate is not worth entering under any of the Eys plays.",
    },
  },
};

const EXIT: Record<string, JevQuestion> = {
  redflag_thesis_broken: {
    type: "noul",
    instructions: "Given `position` and `trigger`, has the thesis behind this position's play clearly broken down (not just normal profit-taking) — e.g. the pool looks compromised, holders are dumping, or the setup has fundamentally changed for the worse?",
    criteria: {
      true: "Something is clearly, seriously wrong beyond the ordinary trigger reason.",
      false: "Nothing alarming beyond the trigger itself.",
    },
  },
  exit_flow_dead: {
    type: "noul",
    instructions: "Given `position` and `trigger`, has the flow/fee opportunity behind this position genuinely died (rather than a normal brief lull)?",
    criteria: {
      true: "Flow/fees have genuinely dried up.",
      false: "There is still real flow or fee income, or the data is too thin to say they have died.",
    },
  },
  exit_action: {
    type: "choice",
    instructions: "A rule-based exit trigger has already fired for `position` (see `trigger`). Should the bot exit now, or hold a little longer?",
    criteria: {
      close_now: "Exit now — the trigger is real and banking it is correct.",
      hold: "Hold — the trigger looks spurious (e.g. a wick, a stale read) and waiting is clearly better.",
    },
  },
};

const BATTERIES: Record<JevLane, Record<string, JevQuestion>> = { enter: ENTRY, exit: EXIT };

/**
 * Question battery for a lane. For the entry lane, `qualifyingPlays` (owner,
 * 2026-10-03) narrows the `play` choice to the plays the rule engine says the
 * candidate actually qualifies for, plus "none" — Jev is not offered plays the
 * candidate cannot be entered under. Omitted/empty = the full menu.
 */
export function questionsFor(lane: JevLane, qualifyingPlays?: string[]): Record<string, JevQuestion> {
  const base = BATTERIES[lane];
  if (lane !== "enter" || !qualifyingPlays || qualifyingPlays.length === 0) return base;
  const play = base["play"];
  if (!play || play.type !== "choice") return base;
  const criteria = play.criteria as Record<string, string>;
  const narrowed: Record<string, string> = {};
  for (const [k, v] of Object.entries(criteria)) {
    if (k === "none" || qualifyingPlays.includes(k)) narrowed[k] = v;
  }
  return { ...base, play: { ...play, criteria: narrowed } as JevQuestion };
}
