/**
 * Jev question batteries — ONE request per decision (docs.typesafe.ai:
 * questions in a battery are evaluated in parallel against one shared
 * `state`, so a richer battery costs little extra latency). IDs are code-side
 * only; every question's `instructions` is self-contained and references
 * `state` by backticked path (e.g. `pool.fees_24h_sol`).
 *
 * ENTRY battery = atomic red-flag nouls + atomic positive nouls + one Choice
 * `play` (molu_ladder | danko_trap | eys_seat | eys_ape | none). Composite
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
    instructions: "Judging `candle_summary` and `momentum`, has this token already made its move — an exhausted vertical spike rather than a position with room left to run, or (for the dip-then-bounce plays) a candidate being entered ON the initial vertical rather than after a real dip and bounce?",
    criteria: {
      true: "The move already happened; this is chasing a top or buying the initial vertical.",
      false: "There is a coherent, not-yet-exhausted setup (including, where the play calls for it, a genuine dip and bounce already completed).",
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
    instructions: "For plays whose thesis needs a dip-then-bounce (molu_ladder, danko_trap), does `candle_summary` show a genuine dip followed by a confirmed bounce off the low — not a token still in free-fall nor one that never dipped at all? For plays that don't need a bounce (eys_seat, eys_ape), judge whether the current price action is at least stable enough to enter.",
    criteria: {
      true: "A real dip-and-bounce is visible, or (for non-bounce plays) price action is stable.",
      false: "Still falling, no dip ever happened, or price action is too chaotic to enter.",
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
      molu_ladder: "Core: proven mcap, young token, entering after a real dip+bounce, one-sided SOL bid-ask below price.",
      danko_trap: "Deep: proven mcap AND proven age (>=48h), one-sided SOL bid-ask far below price (-85%/-90%), patient.",
      eys_seat: "Fast: smaller mcap floor, real SOL fee income, high volume rate, narrow spot range, quick in-and-out.",
      eys_ape: "Riskiest: token-sided ape into a Stonks-launchpad graduate paying SOL-only fees, selling into the pump above price. Token-sided, can go to zero.",
      none: "No coherent play fits — this candidate is not worth entering under any of the four plays.",
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

export function questionsFor(lane: JevLane): Record<string, JevQuestion> {
  return BATTERIES[lane];
}
