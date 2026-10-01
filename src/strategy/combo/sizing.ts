/**
 * Combo sizing — Eys 30/70: 30% of current equity is the combo strategy's
 * entire active budget; the other 70% is never deployed by combo plays.
 * Per-position size: eys_seat and molu_ladder ~1/3 of the active budget
 * each, danko_trap up to 1/3; max 3 concurrent combo positions total (and
 * at most 1 danko_trap). eys_ape is a fixed ticket size (`ape_sol`), capped
 * at 1 concurrent regardless of mode.
 *
 * Canary mode (owner addition, 2026-10-01, for a ~0.3 SOL account): overrides
 * the 30/70 math with a single flat position size and a hard max_concurrent
 * of 1 across ALL combo plays — whichever play Jev approves first takes the
 * one slot. Every size (canary or normal) is checked against
 * `checkAffordability` before being offered: equity must cover the position
 * size PLUS the fee reserve PLUS an estimated position-rent cost, or the
 * play is skipped rather than sized down below its floor.
 *
 * Reuses upstream's own equity/bankroll math (risk/limits.ts `computeBankroll`
 * — `walletSol` there IS total equity, see its own comment) rather than
 * recomputing equity. Sizes grow automatically as equity grows because the
 * budget is a percentage, not a fixed SOL amount (outside canary mode).
 */
import type { Bankroll } from "../../risk/limits.js";
import { minPositionSol } from "../../risk/limits.js";
import type { Play } from "./plays.js";

export interface ComboSizingConfig {
  active_budget_pct: number;   // 30
  molu_share_pct: number;      // ~33.33
  eys_share_pct: number;       // ~33.33
  danko_share_pct: number;     // ~33.33
  max_concurrent: number;      // 3
  min_floor_sol: number;       // 0.05
  fee_reserve_sol: number;     // 0.05 — extra rent/fee buffer on top of upstream's own reserve
}

export interface CanarySizingConfig {
  canary_mode: boolean;
  canary_position_sol: number;  // flat size for SOL-side plays while canary_mode is on
  ape_sol: number;               // fixed ape ticket size, both modes
  fee_reserve_sol: number;       // always-free buffer (same figure as ComboSizingConfig.fee_reserve_sol)
  position_rent_est_sol: number; // ~0.06-0.07 SOL DLMM position-account rent estimate
}

export interface ComboOpenCounts {
  moluLadder: number;
  eysSeat: number;
  dankoTrap: number;
  eysApe: number;
}

function shareFor(play: Exclude<Play, "eys_ape">, c: ComboSizingConfig): number {
  switch (play) {
    case "molu_ladder": return c.molu_share_pct;
    case "eys_seat": return c.eys_share_pct;
    case "danko_trap": return c.danko_share_pct;
  }
}

/**
 * Normal-mode (non-canary) per-position size for a SOL-side play, or 0 when
 * the play should be skipped. eys_ape is never sized here — it always uses
 * the fixed `ape_sol` ticket (see sizeComboPlay).
 */
export function comboPositionSize(
  bankroll: Bankroll,
  play: Exclude<Play, "eys_ape">,
  counts: ComboOpenCounts,
  cfg: ComboSizingConfig,
): number {
  const totalOpen = counts.moluLadder + counts.eysSeat + counts.dankoTrap;
  if (totalOpen >= cfg.max_concurrent) return 0;
  if (play === "danko_trap" && counts.dankoTrap >= 1) return 0;

  const equity = bankroll.walletSol; // computeBankroll() normalizes this to total equity
  const activeBudget = equity * (cfg.active_budget_pct / 100);
  const raw = activeBudget * (shareFor(play, cfg) / 100);

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
 * Equity must cover size + the always-free fee reserve + an estimated
 * position-account rent, and deployable must cover size + that rent. Skips
 * the play rather than sizing it down below its floor (owner's instruction).
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

/**
 * Unified sizing entry point: canary mode (flat size, max 1 total combo
 * position) or normal 30/70 mode, always affordability-checked.
 */
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

  if (canaryCfg.canary_mode) {
    const totalOpen = counts.moluLadder + counts.eysSeat + counts.dankoTrap + counts.eysApe;
    if (totalOpen >= 1) return { sizeSol: 0, skipReason: "canary_max_concurrent" };
    const raw = play === "eys_ape" ? canaryCfg.ape_sol : canaryCfg.canary_position_sol;
    const afford = checkAffordability(bankroll, raw, canaryCfg);
    if (!afford.ok) return { sizeSol: 0, skipReason: `skip_affordability: ${afford.reason}` };
    return { sizeSol: raw, skipReason: null };
  }

  if (play === "eys_ape") {
    const afford = checkAffordability(bankroll, canaryCfg.ape_sol, canaryCfg);
    if (!afford.ok) return { sizeSol: 0, skipReason: `skip_affordability: ${afford.reason}` };
    return { sizeSol: canaryCfg.ape_sol, skipReason: null };
  }

  const size = comboPositionSize(bankroll, play, counts, sizingCfg);
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
 * eys_seat cost-skip: skip the play when its expected win (target % of size)
 * would not clear the estimated round-trip cost (tx/priority fees + expected
 * slippage) — a position too small to be worth the cycle cost.
 */
export function eysCostSkip(sizeSol: number, cfg: EysCostConfig): boolean {
  const expectedWinSol = sizeSol * (cfg.eys_tp_pct / 100);
  const estCostSol = cfg.eys_cost_tx_count * cfg.eys_cost_tx_sol + sizeSol * (cfg.eys_cost_slippage_bps / 10_000);
  return expectedWinSol <= estCostSol;
}
