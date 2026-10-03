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
  /**
   * eys_seat exit: "tp" (take profit at eys_tp_pct) or "fee_hold" (hold while the
   * pool keeps paying; exit when fees fade or price leaves the range below).
   */
  eys_seat_exit?: "tp" | "fee_hold";
  /** fee_hold: minimum hold before the fee/range exits may fire. */
  eys_hold_min_minutes?: number;
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
  /** SOL-side plays: price below the range bottom (fully converted to token). */
  belowRange?: boolean;
  /** fee_hold: the pool's fee/TVL per hour has stayed below eys_hold_fee_min_pct_per_h (confirmed in loop.ts). */
  feeFaded?: boolean;
  /** Minutes since entry. */
  holdMin?: number;
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

  // Owner, 2026-10-03: the 3% take-profit capped every win at ~+0.001 SOL while
  // losers kept their full size. Backtest (46h, pools >= 5%/h, 69-bin seat):
  // holding while the pool pays turned -0.12 SOL into +1.27 SOL.
  if (input.play === "eys_seat" && cfg.eys_seat_exit === "fee_hold") {
    if ((input.holdMin ?? 0) < (cfg.eys_hold_min_minutes ?? 10)) return { shouldExit: false, reason: "" };
    if (input.belowRange) return { shouldExit: true, reason: "eys_seat: price fell below the range" };
    if (input.feeFaded) return { shouldExit: true, reason: "eys_seat: pool fees faded (fee/TVL per hour below the hold floor)" };
    return { shouldExit: false, reason: "" };
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

/**
 * Cooldown (hours) after an eys_seat idle close (token ran above the seat's
 * range). Owner, 2026-10-03: while the pool still pays the fee-tier rate, re-seat
 * at the new price instead of benching the token — the seat belongs under the
 * current price, ready for the dump. The 24h re-entry cap still bounds churn.
 */
export function seatIdleCooldownH(
  cfg: { reentry_cooldown_h?: number; eys_reseat_on_idle?: boolean; eys_fee_entry_pct_per_h?: number },
  poolFeePerHourPct: number,
): number {
  const feeEntry = cfg.eys_fee_entry_pct_per_h ?? 0;
  if (cfg.eys_reseat_on_idle && feeEntry > 0 && poolFeePerHourPct >= feeEntry) return 0;
  return cfg.reentry_cooldown_h ?? 3;
}
