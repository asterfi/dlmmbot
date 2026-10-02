/**
 * Combo sizing (Eys-only). Two modes:
 *
 * Canary mode (small accounts): every SOL-side play is a flat
 * `canary_position_sol` (0.1), every token-sided play (eys_ape, eys_breakout)
 * the fixed `ape_sol` ticket (0.1), and at most `canary_max_concurrent` (2)
 * combo positions are open at once — an open eys_seat plus its eys_breakout
 * fills both. Every size is checked against `checkAffordability` first:
 * equity must cover the size PLUS the fee reserve PLUS the position-account
 * rent, or the play is SKIPPED rather than sized down below its floor. The
 * entry pipeline re-runs the check with the REAL position-account count once
 * the range is built (a 1-account Spot range prices one account).
 *
 * Normal mode: Eys 30/70 — 30% of current equity is the combo's whole active
 * budget, `eys_share_pct` of it per SOL-side position, at most `max_concurrent`
 * open. eys_ape / eys_breakout are always the fixed `ape_sol` ticket.
 *
 * Reuses upstream's own equity/bankroll math (risk/limits.ts `computeBankroll`
 * — `walletSol` there IS total equity) rather than recomputing equity.
 */
import type { Bankroll } from "../../risk/limits.js";
import { minPositionSol } from "../../risk/limits.js";
import { isTokenSidedPlay, type Play } from "./plays.js";

export interface ComboSizingConfig {
  active_budget_pct: number;   // 30
  eys_share_pct: number;       // share of the active budget per SOL-side position
  max_concurrent: number;      // normal-mode cap on open combo positions
  min_floor_sol: number;       // 0.05
  fee_reserve_sol: number;     // 0.05 — extra rent/fee buffer on top of upstream's own reserve
}

export interface CanarySizingConfig {
  canary_mode: boolean;
  canary_position_sol: number;  // flat size for SOL-side plays while canary_mode is on
  /** Max open combo positions in canary mode (default 2: a seat plus its breakout). */
  canary_max_concurrent?: number;
  ape_sol: number;               // fixed token-sided ticket (eys_ape, eys_breakout), both modes
  fee_reserve_sol: number;       // always-free buffer (same figure as ComboSizingConfig.fee_reserve_sol)
  position_rent_est_sol: number; // ~0.06-0.07 SOL DLMM position-account rent estimate, PER ACCOUNT
}

export interface ComboOpenCounts {
  eysSeat: number;
  eysBreakout: number;
  eysTight: number;
  eysApe: number;
  eysDumpBonus: number;
}

export function totalOpen(counts: ComboOpenCounts): number {
  return counts.eysSeat + counts.eysBreakout + counts.eysTight + counts.eysApe + counts.eysDumpBonus;
}

/**
 * Normal-mode per-position size for a SOL-side play, or 0 when the play should
 * be skipped. Token-sided plays are never sized here (fixed `ape_sol` ticket).
 */
export function comboPositionSize(
  bankroll: Bankroll,
  counts: ComboOpenCounts,
  cfg: ComboSizingConfig,
): number {
  if (totalOpen(counts) >= cfg.max_concurrent) return 0;
  const equity = bankroll.walletSol; // computeBankroll() normalizes this to total equity
  const activeBudget = equity * (cfg.active_budget_pct / 100);
  const raw = activeBudget * (cfg.eys_share_pct / 100);

  const floor = Math.max(cfg.min_floor_sol, minPositionSol(equity));
  const deployable = Math.max(0, bankroll.deployableSol - cfg.fee_reserve_sol);
  const size = Math.min(raw, deployable);

  return size >= floor ? size : 0;
}

export interface AffordabilityResult {
  ok: boolean;
  reason?: string;
}

/**
 * Equity must cover size + the always-free fee reserve + position-account
 * rent, and deployable must cover size + that rent. Skips the play rather than
 * sizing it down below its floor (owner's instruction).
 */
export function checkAffordability(
  bankroll: Bankroll,
  sizeSol: number,
  cfg: Pick<CanarySizingConfig, "fee_reserve_sol" | "position_rent_est_sol">,
): AffordabilityResult {
  const neededEquity = sizeSol + cfg.fee_reserve_sol + cfg.position_rent_est_sol;
  if (bankroll.walletSol < neededEquity) {
    return { ok: false, reason: `equity ${bankroll.walletSol.toFixed(4)} < size+reserve+rent ${neededEquity.toFixed(4)}` };
  }
  const neededDeployable = sizeSol + cfg.position_rent_est_sol;
  if (bankroll.deployableSol < neededDeployable) {
    return { ok: false, reason: `deployable ${bankroll.deployableSol.toFixed(4)} < size+rent ${neededDeployable.toFixed(4)}` };
  }
  return { ok: true };
}

export interface ComboSizeResult {
  sizeSol: number;
  /** null when sizeSol > 0; otherwise the reason the play was skipped. */
  skipReason: string | null;
}

/** Unified sizing entry point, always affordability-checked (one account's rent; see header). */
export function sizeComboPlay(
  bankroll: Bankroll,
  play: Play,
  counts: ComboOpenCounts,
  sizingCfg: ComboSizingConfig,
  canaryCfg: CanarySizingConfig,
): ComboSizeResult {
  if (play === "eys_ape" && counts.eysApe >= 1) {
    return { sizeSol: 0, skipReason: "ape_max_concurrent" };
  }
  const tokenSided = isTokenSidedPlay(play);

  if (canaryCfg.canary_mode) {
    if (totalOpen(counts) >= (canaryCfg.canary_max_concurrent ?? 2)) {
      return { sizeSol: 0, skipReason: "canary_max_concurrent" };
    }
    const raw = tokenSided ? canaryCfg.ape_sol : canaryCfg.canary_position_sol;
    const afford = checkAffordability(bankroll, raw, canaryCfg);
    if (!afford.ok) return { sizeSol: 0, skipReason: `skip_affordability: ${afford.reason}` };
    return { sizeSol: raw, skipReason: null };
  }

  if (tokenSided) {
    if (totalOpen(counts) >= sizingCfg.max_concurrent) return { sizeSol: 0, skipReason: "combo_size_zero" };
    const afford = checkAffordability(bankroll, canaryCfg.ape_sol, canaryCfg);
    if (!afford.ok) return { sizeSol: 0, skipReason: `skip_affordability: ${afford.reason}` };
    return { sizeSol: canaryCfg.ape_sol, skipReason: null };
  }

  const size = comboPositionSize(bankroll, counts, sizingCfg);
  if (size <= 0) return { sizeSol: 0, skipReason: "combo_size_zero" };
  const afford = checkAffordability(bankroll, size, canaryCfg);
  if (!afford.ok) return { sizeSol: 0, skipReason: `skip_affordability: ${afford.reason}` };
  return { sizeSol: size, skipReason: null };
}

export interface EysCostConfig {
  eys_tp_pct: number;
  eys_cost_tx_count: number;     // ~4 txs per round trip (open, claim/close, swap, close-account)
  eys_cost_tx_sol: number;       // estimated SOL cost per tx (priority fee + base fee)
  eys_cost_slippage_bps: number; // expected swap slippage on the exit leg
}

/**
 * Cost-skip: skip a take-profit play when its expected win (target % of size)
 * would not clear the estimated round-trip cost (tx/priority fees + expected
 * slippage) — a position too small to be worth the cycle cost.
 */
export function eysCostSkip(sizeSol: number, cfg: EysCostConfig): boolean {
  const expectedWinSol = sizeSol * (cfg.eys_tp_pct / 100);
  const estCostSol = cfg.eys_cost_tx_count * cfg.eys_cost_tx_sol + sizeSol * (cfg.eys_cost_slippage_bps / 10_000);
  return expectedWinSol <= estCostSol;
}
