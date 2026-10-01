/**
 * Per-play mechanical exit triggers (owner's decisions). These run only on
 * positions tagged with a combo `play`; every trigger still passes through a
 * Jev exit consult (fail-open) before the position actually closes — see
 * manager/loop.ts. P0 safety exits are untouched and always run first,
 * independent of play.
 */
import type { Play } from "./plays.js";

export interface ComboExitConfig {
  molu_tp_pct: number;            // 15
  molu_tp_pct_top_tier: number;   // 5
  molu_top_tier_sol: number;      // position-size threshold for the 5% exit
  eys_tp_pct: number;             // 2 (configurable 1-3)
  danko_tp_pct: number;           // 15-20, default 17.5
}

export interface ComboExitInput {
  play: Play;
  entrySol: number;
  /** Fee-inclusive mark-to-market PnL fraction of entry (matches upstream's P1/give-back basis). */
  pnlFrac: number;
  /** True when the play's flow/volume-decay signal says the opportunity has died (reuses upstream's P2 fee/vol decay reading). */
  flowDead: boolean;
  /**
   * True once the position has been in drawdown at some point since entry —
   * danko_trap's "break-even-or-better after a bounce" condition. Sourced
   * from the existing `positions.fell_deep` column (upstream's own
   * below-range tracking), so no new per-tick state is introduced.
   */
  everDrawn: boolean;
  /**
   * True once the ladder has actually converted some SOL to token (owner's
   * live-churn fix, 2026-10-02): a below-price BidAsk ladder's top bin IS the
   * active bin at entry, so everDrawn/ever_in_range alone cannot tell "never
   * filled" apart from "just opened". Sourced from active-bin-vs-top-bin
   * tracking in loop.ts (`ever_filled`), not from everDrawn/ever_in_range.
   * danko's break-even exit below REQUIRES this: a ladder that never filled
   * never actually converted anything, so "break-even" on it is not a real
   * trade outcome — it must instead time out (see combo.danko_idle_max_h).
   */
  everFilled: boolean;
  /** eys_ape only: has price run through the top of the token-sided range (fully converted to SOL)? Sourced from PositionMark.aboveRange — no new state. */
  aboveRange?: boolean;
}

export interface ComboExitDecision {
  shouldExit: boolean;
  reason: string;
}

export function comboExitCheck(input: ComboExitInput, cfg: ComboExitConfig): ComboExitDecision {
  if (input.flowDead) {
    return { shouldExit: true, reason: `${input.play}: flow/volume died` };
  }
  switch (input.play) {
    case "molu_ladder": {
      const tpFrac = input.entrySol >= cfg.molu_top_tier_sol
        ? cfg.molu_tp_pct_top_tier / 100
        : cfg.molu_tp_pct / 100;
      if (input.pnlFrac >= tpFrac) {
        return { shouldExit: true, reason: `molu_ladder: +${(input.pnlFrac * 100).toFixed(1)}% >= ${(tpFrac * 100).toFixed(0)}% target` };
      }
      return { shouldExit: false, reason: "" };
    }
    case "eys_seat": {
      const tpFrac = cfg.eys_tp_pct / 100;
      if (input.pnlFrac >= tpFrac) {
        return { shouldExit: true, reason: `eys_seat: +${(input.pnlFrac * 100).toFixed(1)}% >= ${(tpFrac * 100).toFixed(1)}% target` };
      }
      return { shouldExit: false, reason: "" };
    }
    case "danko_trap": {
      const tpFrac = cfg.danko_tp_pct / 100;
      if (input.pnlFrac >= tpFrac) {
        return { shouldExit: true, reason: `danko_trap: +${(input.pnlFrac * 100).toFixed(1)}% >= ${(tpFrac * 100).toFixed(1)}% runner target` };
      }
      if (input.everFilled && input.everDrawn && input.pnlFrac >= 0) {
        return { shouldExit: true, reason: `danko_trap: break-even-or-better (${(input.pnlFrac * 100).toFixed(1)}%) after a bounce` };
      }
      return { shouldExit: false, reason: "" };
    }
    case "eys_ape": {
      if (input.aboveRange) {
        return { shouldExit: true, reason: "eys_ape: range fully converted to SOL (price ran through the top)" };
      }
      return { shouldExit: false, reason: "" };
    }
  }
}
