/**
 * Per-play mechanical exit triggers (owner's decisions; Eys-only combo). These
 * run only on positions tagged with a combo `play`; every trigger still passes
 * through a Jev exit consult (fail-open) before the position actually closes —
 * see manager/loop.ts. P0 safety exits are untouched and always run first,
 * independent of play. There is NEVER a stop-loss: Eys exits when green or when
 * flow dies, and the deep bonus ladder just waits.
 */
import type { Play } from "./plays.js";

export interface ComboExitConfig {
  /** Take profit once the position is green by this much (Eys: "whether it's 1%, 2%, or 3%"). */
  eys_tp_pct: number;
}

export interface ComboExitInput {
  play: Play;
  entrySol: number;
  /** Fee-inclusive mark-to-market PnL fraction of entry (matches upstream's give-back basis). */
  pnlFrac: number;
  /** True once the flow/volume-death condition has held for combo.flow_dead_confirm_min (confirmed in loop.ts). */
  flowDead: boolean;
  /**
   * True once a SOL-side ladder has actually converted some SOL to token
   * (active bin has gone strictly below the position's top bin). A below-price
   * ladder's top bin IS the active bin at entry, so ever_in_range cannot tell
   * "never filled" from "just opened". eys_dump_bonus only takes profit on a
   * ladder that really filled.
   */
  everFilled: boolean;
  /** Token-sided plays: has price run through the top of the range (fully converted back to SOL)? */
  aboveRange?: boolean;
}

export interface ComboExitDecision {
  shouldExit: boolean;
  reason: string;
}

export function comboExitCheck(input: ComboExitInput, cfg: ComboExitConfig): ComboExitDecision {
  const tpFrac = cfg.eys_tp_pct / 100;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  // eys_dump_bonus is a deep Bid-Ask ladder placed as volume fades — flow dying
  // is its premise, not an exit. It waits for the bounce (green on a real fill).
  if (input.play === "eys_dump_bonus") {
    if (input.everFilled && input.pnlFrac >= tpFrac) {
      return { shouldExit: true, reason: `eys_dump_bonus: +${pct(input.pnlFrac)} >= ${pct(tpFrac)} on a filled ladder (bounce)` };
    }
    return { shouldExit: false, reason: "" };
  }

  if (input.flowDead) {
    return { shouldExit: true, reason: `${input.play}: flow/volume died` };
  }

  switch (input.play) {
    case "eys_seat":
    case "eys_tight": {
      if (input.pnlFrac >= tpFrac) {
        return { shouldExit: true, reason: `${input.play}: +${pct(input.pnlFrac)} >= ${pct(tpFrac)} target` };
      }
      return { shouldExit: false, reason: "" };
    }
    case "eys_breakout": {
      if (input.aboveRange) {
        return { shouldExit: true, reason: "eys_breakout: range fully converted to SOL (price ran through the top)" };
      }
      if (input.pnlFrac >= tpFrac) {
        return { shouldExit: true, reason: `eys_breakout: +${pct(input.pnlFrac)} >= ${pct(tpFrac)} target` };
      }
      return { shouldExit: false, reason: "" };
    }
    case "eys_ape": {
      if (input.aboveRange) {
        return { shouldExit: true, reason: "eys_ape: range fully converted to SOL (price ran through the top)" };
      }
      return { shouldExit: false, reason: "" };
    }
    default:
      return { shouldExit: false, reason: "" };
  }
}
