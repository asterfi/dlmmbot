// Card builders for the Telegram image-card redesign. Pure data -> CardSpec
// functions (easy to unit test, no network) plus a thin parsing layer that
// maps the free-text messages existing alert() call sites already produce
// onto the richest card we can build without touching those call sites —
// every kind falls back to a plain legible "fallback" card if parsing misses,
// so nothing is ever dropped silently.
import type { CardRow, CardSpec, StatusPill } from "./layout.js";
import { COLOR } from "./theme.js";
import { isLive } from "../config.js";

export type CardKind =
  | "opened" | "closed" | "fees_claimed" | "profit_lock" | "account"
  | "jev_decision" | "ape_opened" | "ape_closed" | "skip_summary"
  | "reconcile_orphan" | "error" | "warning" | "startup" | "truth_pnl_daily"
  | "fallback";

export interface BuiltCard {
  spec: CardSpec;
  /** Plain caption for sendPhoto, <=200 chars, readable in a push-notification preview. */
  caption: string;
}

function statusPill(): StatusPill {
  return isLive() ? "LIVE" : "PAPER";
}

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function sign(n: number): string {
  return n >= 0 ? "+" : "";
}

// ---------------------------------------------------------------------------
// opened
// ---------------------------------------------------------------------------
export interface OpenedData {
  symbol: string;
  posId: number;
  sizeSol: number;
  entryPrice: number;
  score?: number;
  depthPct?: number;
  play?: string;
  tranche?: boolean;
  note?: string;
}

export function buildOpenedCard(d: OpenedData): BuiltCard {
  const rows: CardRow[] = [
    { label: "position", value: `pos#${d.posId}${d.tranche ? " (tranche)" : ""}` },
    { label: "entry price", value: d.entryPrice.toPrecision(4) },
  ];
  if (d.score != null) rows.push({ label: "score", value: d.score.toFixed(0) });
  if (d.depthPct != null) rows.push({ label: "range depth", value: `${d.depthPct.toFixed(0)}%` });
  if (d.note) rows.push({ label: "note", value: cap(d.note, 48) });
  const spec: CardSpec = {
    kindLabel: "OPENED",
    kindColor: COLOR.ok,
    statusPill: statusPill(),
    title: d.symbol,
    subtitle: `pos#${d.posId}`,
    play: d.play,
    bigValue: `${d.sizeSol.toFixed(2)} SOL`,
    bigValueColor: COLOR.fg,
    rows,
    footerNote: "entry",
  };
  return {
    spec,
    caption: cap(`🟢 OPENED${d.play ? ` · ${d.play}` : ""} · ${d.sizeSol.toFixed(2)} SOL · ${d.symbol}`, 200),
  };
}

// ---------------------------------------------------------------------------
// closed
// ---------------------------------------------------------------------------
export interface ClosedData {
  symbol: string;
  posId: number;
  pnlSol: number;
  pnlPct: number;
  entrySol: number;
  exitSol: number;
  feesSol: number;
  holdTime: string;
  reason?: string;
  play?: string;
}

export function buildClosedCard(d: ClosedData): BuiltCard {
  const win = d.pnlSol >= 0;
  const color = win ? COLOR.ok : COLOR.danger;
  const rows: CardRow[] = [
    { label: "entry → exit", value: `${d.entrySol.toFixed(3)} → ${d.exitSol.toFixed(3)} SOL` },
    { label: "fees", value: `${d.feesSol.toFixed(4)} SOL` },
    { label: "held", value: d.holdTime },
  ];
  if (d.reason) rows.push({ label: "reason", value: cap(d.reason, 40) });
  return {
    spec: {
      kindLabel: "CLOSED",
      kindColor: color,
      statusPill: statusPill(),
      title: d.symbol,
      subtitle: `pos#${d.posId}`,
      play: d.play,
      bigValue: `${sign(d.pnlSol)}${d.pnlSol.toFixed(4)} SOL`,
      bigValueColor: color,
      bigValueSub: `(${sign(d.pnlPct)}${d.pnlPct.toFixed(1)}%)`,
      rows,
      footerNote: "close",
    },
    caption: cap(`${win ? "✅" : "🔴"} CLOSED · ${d.symbol} · ${sign(d.pnlSol)}${d.pnlSol.toFixed(4)} SOL (${sign(d.pnlPct)}${d.pnlPct.toFixed(1)}%) · held ${d.holdTime}`, 200),
  };
}

// ---------------------------------------------------------------------------
// fees_claimed
// ---------------------------------------------------------------------------
export interface FeesClaimedData {
  symbol: string;
  posId?: number;
  claimedSol: number;
  note?: string;
}

export function buildFeesClaimedCard(d: FeesClaimedData): BuiltCard {
  return {
    spec: {
      kindLabel: "FEES",
      kindColor: COLOR.accent,
      statusPill: statusPill(),
      title: d.symbol,
      subtitle: d.posId != null ? `pos#${d.posId}` : undefined,
      bigValue: `+${d.claimedSol.toFixed(4)} SOL`,
      bigValueColor: COLOR.ok,
      rows: d.note ? [{ label: "note", value: cap(d.note, 60) }] : [],
      footerNote: "fees claimed",
    },
    caption: cap(`💰 FEES · ${d.symbol} · +${d.claimedSol.toFixed(4)} SOL`, 200),
  };
}

// ---------------------------------------------------------------------------
// profit_lock
// ---------------------------------------------------------------------------
export interface ProfitLockData {
  symbol: string;
  posId: number;
  gainPct: number;
  withdrawnSol: number;
}

export function buildProfitLockCard(d: ProfitLockData): BuiltCard {
  return {
    spec: {
      kindLabel: "PROFIT LOCK",
      kindColor: COLOR.sol,
      statusPill: statusPill(),
      title: d.symbol,
      subtitle: `pos#${d.posId}`,
      bigValue: `+${d.withdrawnSol.toFixed(4)} SOL`,
      bigValueColor: COLOR.ok,
      bigValueSub: `(at +${d.gainPct.toFixed(0)}%)`,
      rows: [],
      footerNote: "profit lock withdrawal",
    },
    caption: cap(`🔒 PROFIT LOCK · ${d.symbol} · withdrew ${d.withdrawnSol.toFixed(4)} SOL at +${d.gainPct.toFixed(0)}%`, 200),
  };
}

// ---------------------------------------------------------------------------
// account
// ---------------------------------------------------------------------------
export interface AccountData {
  acctSol: number;
  acctPct: number;
  walletSol: number;
  inPositionsSol: number;
  baselineSol: number;
  closedCount: number;
  realizedSol: number;
}

export function buildAccountCard(d: AccountData): BuiltCard {
  const color = d.acctSol >= 0 ? COLOR.ok : COLOR.danger;
  return {
    spec: {
      kindLabel: "ACCOUNT",
      kindColor: COLOR.accent,
      statusPill: statusPill(),
      title: "Account since start",
      bigValue: `${sign(d.acctSol)}${d.acctSol.toFixed(4)} SOL`,
      bigValueColor: color,
      bigValueSub: `(${sign(d.acctPct)}${d.acctPct.toFixed(2)}%)`,
      rows: [
        { label: "wallet", value: `${d.walletSol.toFixed(3)} SOL` },
        { label: "in positions", value: `${d.inPositionsSol.toFixed(3)} SOL` },
        { label: "baseline", value: `${d.baselineSol.toFixed(3)} SOL` },
        { label: "closed / realized", value: `${d.closedCount} / ${sign(d.realizedSol)}${d.realizedSol.toFixed(4)} SOL` },
      ],
      footerNote: "account summary",
    },
    caption: cap(`📊 ACCOUNT · ${sign(d.acctSol)}${d.acctSol.toFixed(4)} SOL (${sign(d.acctPct)}${d.acctPct.toFixed(2)}%)`, 200),
  };
}

// ---------------------------------------------------------------------------
// jev_decision
// ---------------------------------------------------------------------------
export interface JevDecisionData {
  symbol: string;
  verdict: "yes" | "no" | "uncertain";
  redFlagMax?: number;
  composite?: number;
  play?: string;
  keyAnswers?: Array<{ q: string; a: string }>;
}

export function buildJevDecisionCard(d: JevDecisionData): BuiltCard {
  const color = d.verdict === "yes" ? COLOR.ok : d.verdict === "no" ? COLOR.danger : COLOR.warn;
  const rows: CardRow[] = [];
  if (d.redFlagMax != null) rows.push({ label: "red-flag max", value: d.redFlagMax.toFixed(2) });
  if (d.composite != null) rows.push({ label: "composite score", value: d.composite.toFixed(0) });
  for (const ka of (d.keyAnswers ?? []).slice(0, 3)) rows.push({ label: ka.q, value: cap(ka.a, 24) });
  return {
    spec: {
      kindLabel: "JEV",
      kindColor: color,
      statusPill: statusPill(),
      title: d.symbol,
      subtitle: "entry consult",
      play: d.play,
      bigValue: d.verdict.toUpperCase(),
      bigValueColor: color,
      rows,
      footerNote: "jev decision",
    },
    caption: cap(`🤖 JEV ${d.verdict.toUpperCase()} · ${d.symbol}${d.composite != null ? ` · score ${d.composite.toFixed(0)}` : ""}`, 200),
  };
}

// ---------------------------------------------------------------------------
// ape_opened / ape_closed
// ---------------------------------------------------------------------------
export interface ApeOpenedData {
  symbol: string;
  posId: number;
  sizeSol: number;
  multiple: number;
  play: string;
}

export function buildApeOpenedCard(d: ApeOpenedData): BuiltCard {
  return {
    spec: {
      kindLabel: "APE OPENED",
      kindColor: COLOR.pink,
      statusPill: statusPill(),
      title: d.symbol,
      subtitle: `pos#${d.posId}`,
      play: d.play,
      bigValue: `${d.sizeSol.toFixed(2)} SOL`,
      bigValueSub: `(${d.multiple.toFixed(1)}x)`,
      rows: [],
      footerNote: "ape entry",
    },
    caption: cap(`🦍 APE OPENED · ${d.play} · ${d.sizeSol.toFixed(2)} SOL (${d.multiple.toFixed(1)}x) · ${d.symbol}`, 200),
  };
}

export interface ApeClosedData {
  symbol: string;
  posId: number;
  pnlSol: number;
  pnlPct: number;
  multiple: number;
}

export function buildApeClosedCard(d: ApeClosedData): BuiltCard {
  const color = d.pnlSol >= 0 ? COLOR.ok : COLOR.danger;
  return {
    spec: {
      kindLabel: "APE CLOSED",
      kindColor: color,
      statusPill: statusPill(),
      title: d.symbol,
      subtitle: `pos#${d.posId}`,
      bigValue: `${sign(d.pnlSol)}${d.pnlSol.toFixed(4)} SOL`,
      bigValueColor: color,
      bigValueSub: `(${sign(d.pnlPct)}${d.pnlPct.toFixed(1)}%, ${d.multiple.toFixed(1)}x)`,
      rows: [],
      footerNote: "ape close",
    },
    caption: cap(`🦍 APE CLOSED · ${d.symbol} · ${sign(d.pnlSol)}${d.pnlSol.toFixed(4)} SOL (${sign(d.pnlPct)}${d.pnlPct.toFixed(1)}%)`, 200),
  };
}

// ---------------------------------------------------------------------------
// skip_summary
// ---------------------------------------------------------------------------
export interface SkipSummaryData {
  windowLabel: string;
  skipped: number;
  topReasons: Array<{ reason: string; count: number }>;
}

export function buildSkipSummaryCard(d: SkipSummaryData): BuiltCard {
  return {
    spec: {
      kindLabel: "SKIPS",
      kindColor: COLOR.muted,
      statusPill: statusPill(),
      title: `${d.skipped} skipped`,
      subtitle: d.windowLabel,
      bigValue: String(d.skipped),
      rows: d.topReasons.slice(0, 5).map((r) => ({ label: r.reason, value: String(r.count) })),
      footerNote: "skip summary",
    },
    caption: cap(`⏭️ SKIPS · ${d.skipped} in ${d.windowLabel}`, 200),
  };
}

// ---------------------------------------------------------------------------
// reconcile_orphan
// ---------------------------------------------------------------------------
export interface ReconcileData {
  orphaned: string[];
  adopted: string[];
  warning?: string;
}

export function buildReconcileCard(d: ReconcileData): BuiltCard {
  const danger = d.orphaned.length > 0 || !!d.warning;
  return {
    spec: {
      kindLabel: "RECONCILE",
      kindColor: danger ? COLOR.warn : COLOR.accent,
      statusPill: statusPill(),
      title: d.warning ? "reconcile hold-off" : "reconcile",
      subtitle: d.warning ? cap(d.warning, 60) : undefined,
      rows: [
        { label: "orphaned", value: d.orphaned.length ? d.orphaned.join(", ").slice(0, 40) : "0" },
        { label: "adopted", value: d.adopted.length ? d.adopted.join(", ").slice(0, 40) : "0" },
      ],
      footerNote: "boot reconcile",
    },
    caption: cap(`🔁 RECONCILE · ${d.orphaned.length} orphaned, ${d.adopted.length} adopted${d.warning ? " · " + d.warning : ""}`, 200),
  };
}

// ---------------------------------------------------------------------------
// error / warning / startup
// ---------------------------------------------------------------------------
export function buildErrorCard(title: string, message: string): BuiltCard {
  return {
    spec: {
      kindLabel: "ERROR",
      kindColor: COLOR.danger,
      statusPill: statusPill(),
      title: cap(title, 40),
      subtitle: cap(message, 90),
      rows: [],
      footerNote: "error",
    },
    caption: cap(`🚨 ERROR · ${title}`, 200),
  };
}

export function buildWarningCard(title: string, message: string): BuiltCard {
  return {
    spec: {
      kindLabel: "WARNING",
      kindColor: COLOR.warn,
      statusPill: statusPill(),
      title: cap(title, 40),
      subtitle: cap(message, 90),
      rows: [],
      footerNote: "warning",
    },
    caption: cap(`⚠️ WARNING · ${title}`, 200),
  };
}

export function buildStartupCard(mode: string, note?: string): BuiltCard {
  return {
    spec: {
      kindLabel: "STARTUP",
      kindColor: COLOR.ok,
      statusPill: statusPill(),
      title: "Bot armed",
      subtitle: note,
      rows: [{ label: "mode", value: mode }],
      footerNote: "startup",
    },
    caption: cap(`✅ STARTUP · armed in ${mode} mode`, 200),
  };
}

// ---------------------------------------------------------------------------
// truth_pnl_daily
// ---------------------------------------------------------------------------
export interface TruthPnlData {
  equitySol: number;
  netDepositsSol: number;
  pnlSol: number;
  pnlPct: number;
  unexplainedOutflowSol: number;
  history?: number[];
}

export function buildTruthPnlCard(d: TruthPnlData): BuiltCard {
  const color = d.pnlSol >= 0 ? COLOR.ok : COLOR.danger;
  const rows: CardRow[] = [
    { label: "equity", value: `${d.equitySol.toFixed(4)} SOL` },
    { label: "net deposits", value: `${d.netDepositsSol.toFixed(4)} SOL` },
  ];
  if (d.unexplainedOutflowSol > 1e-6) {
    rows.push({ label: "unexplained outflow", value: `${d.unexplainedOutflowSol.toFixed(4)} SOL`, color: COLOR.danger });
  }
  return {
    spec: {
      kindLabel: "TRUTH-PNL",
      kindColor: COLOR.accent,
      statusPill: statusPill(),
      title: "Daily truth report",
      bigValue: `${sign(d.pnlSol)}${d.pnlSol.toFixed(4)} SOL`,
      bigValueColor: color,
      bigValueSub: `(${sign(d.pnlPct)}${d.pnlPct.toFixed(1)}%)`,
      rows,
      sparkline: d.history,
      footerNote: "truth-pnl",
    },
    caption: cap(`📈 TRUTH-PNL · equity ${d.equitySol.toFixed(4)} SOL · pnl ${sign(d.pnlSol)}${d.pnlSol.toFixed(4)} SOL (${sign(d.pnlPct)}${d.pnlPct.toFixed(1)}%)${d.unexplainedOutflowSol > 1e-6 ? " ⚠️ outflow" : ""}`, 200),
  };
}

// ---------------------------------------------------------------------------
// fallback — anything that doesn't parse, or kinds with no structured builder
// ---------------------------------------------------------------------------
export function buildFallbackCard(kind: string, message: string): BuiltCard {
  const firstLine = message.split("\n")[0] ?? message;
  const rest = message.split("\n").slice(1, 4).join(" · ");
  const danger = kind === "safety_exit" || kind === "stop_loss" || kind === "circuit_breaker";
  const warn = kind === "below_cut" || kind === "watchdog" || kind === "displacement";
  const color = danger ? COLOR.danger : warn ? COLOR.warn : COLOR.muted;
  return {
    spec: {
      kindLabel: kind.toUpperCase(),
      kindColor: color,
      statusPill: statusPill(),
      title: cap(firstLine, 56),
      subtitle: rest ? cap(rest, 90) : undefined,
      rows: [],
      footerNote: kind,
    },
    caption: cap(`[${kind}] ${firstLine}`, 200),
  };
}

// ---------------------------------------------------------------------------
// Parse layer: maps the AlertKind + free-text message every existing call
// site already produces onto the richest card above, falling back to
// buildFallbackCard when the text doesn't match the expected shape. No call
// site needs to change for this layer to work.
// ---------------------------------------------------------------------------
function num(re: RegExp, s: string): number | undefined {
  const m = re.exec(s);
  return m && m[1] !== undefined ? Number(m[1]) : undefined;
}
function str(re: RegExp, s: string): string | undefined {
  const m = re.exec(s);
  return m?.[1];
}

export function parseAlertToCard(kind: string, message: string): BuiltCard {
  try {
    if (kind === "entry") {
      const symbol = str(/^([^\s]+)\s+(?:tranche\s+)?pos#\d+/, message);
      const posId = num(/pos#(\d+)/, message);
      const sizeSol = num(/(?:entered|:)\s*([\d.]+)\s*SOL/, message);
      if (symbol && posId != null && sizeSol != null) {
        return buildOpenedCard({
          symbol,
          posId,
          sizeSol,
          entryPrice: num(/@\s*([\d.]+)/, message) ?? 0,
          score: num(/score\s+([\d.]+)/, message),
          depthPct: num(/depth\s+([\d.]+)%/, message),
          tranche: /tranche/.test(message),
        });
      }
    } else if (kind === "close") {
      const symbol = str(/^([^\s]+)\s+pos#\d+/, message);
      const posId = num(/pos#(\d+)/, message);
      const pnlSol = num(/PnL:\s*([+-]?[\d.]+)\s*SOL/, message);
      const pnlPct = num(/PnL:[^(]*\(([+-]?[\d.]+)%\)/, message);
      const entrySol = num(/entry\s+([\d.]+)\s*→/, message);
      const exitSol = num(/→\s*exit\s+([\d.]+)/, message);
      const feesSol = num(/fees\s+([\d.]+)\s*SOL/, message);
      const hold = str(/held\s+(\S+)/, message);
      if (symbol && posId != null && pnlSol != null && pnlPct != null) {
        return buildClosedCard({
          symbol, posId, pnlSol, pnlPct,
          entrySol: entrySol ?? 0, exitSol: exitSol ?? 0, feesSol: feesSol ?? 0,
          holdTime: hold ?? "?",
        });
      }
    } else if (kind === "claim") {
      const symbol = str(/^(?:🧹\s*\[sweep\]\s*)?(?:sold stranded\s*)?([^\s]+)\s+pos#\d+/, message)
        ?? str(/stranded\s+([^\s]+)\s+/, message);
      const posId = num(/pos#(\d+)/, message);
      const claimedSol = num(/claimed\s+([\d.]+)\s*SOL/, message)
        ?? num(/banked\s+([\d.]+)\s*SOL/, message)
        ?? num(/for\s+([\d.]+)\s*SOL/, message);
      if (symbol && claimedSol != null) {
        return buildFeesClaimedCard({ symbol, posId, claimedSol, note: message.split("\n")[0] });
      }
    } else if (kind === "profit_lock") {
      const symbol = str(/^([^\s]+)\s+pos#\d+/, message);
      const posId = num(/pos#(\d+)/, message);
      const gainPct = num(/\+?([\d.]+)%/, message);
      const withdrawnSol = num(/withdrew\s+([\d.]+)\s*SOL/, message);
      if (symbol && posId != null && gainPct != null && withdrawnSol != null) {
        return buildProfitLockCard({ symbol, posId, gainPct, withdrawnSol });
      }
    } else if (kind === "account") {
      const acctSol = num(/since start:\s*([+-]?[\d.]+)\s*SOL/, message);
      const acctPct = num(/since start:[^(]*\(([+-]?[\d.]+)%\)/, message);
      const walletSol = num(/wallet\s+([\d.]+)/, message);
      const inPositionsSol = num(/in positions\s+([\d.]+)/, message);
      const baselineSol = num(/vs start\s+([\d.]+)/, message);
      const closedCount = num(/closed\s+(\d+)/, message);
      const realizedSol = num(/realized on positions\s+([+-]?[\d.]+)/, message);
      if (acctSol != null && acctPct != null) {
        return buildAccountCard({
          acctSol, acctPct,
          walletSol: walletSol ?? 0, inPositionsSol: inPositionsSol ?? 0,
          baselineSol: baselineSol ?? 0, closedCount: closedCount ?? 0,
          realizedSol: realizedSol ?? 0,
        });
      }
    } else if (kind === "info" && /^reconcile:/.test(message)) {
      if (/refusing to orphan/.test(message)) {
        return buildReconcileCard({ orphaned: [], adopted: [], warning: "chain read returned 0 — refusing to orphan" });
      }
      const orphanedN = num(/(\d+)\s+DB-open orphans closed/, message);
      const adoptedN = num(/(\d+)\s+chain positions adopted/, message);
      const orphanedList = str(/orphans closed \(([^)]*)\)/, message);
      const adoptedList = str(/adopted \(([^)]*)\)/, message);
      if (orphanedN != null || adoptedN != null) {
        return buildReconcileCard({
          orphaned: orphanedList && orphanedList !== "-" ? orphanedList.split(", ") : [],
          adopted: adoptedList ? adoptedList.split(", ").filter(Boolean) : [],
        });
      }
    }
  } catch {
    // fall through to generic fallback below — parsing must never throw out
    // of the alert path.
  }
  return buildFallbackCard(kind, message);
}
