import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { LiveWatch } from "@/lib/types";
import type { ComboPlay, JevDecisionRow, PlayStats, StrategyConfig, StrategyTruth } from "@/lib/types";
import {
  fetchStrategyConfig, fetchStrategyJev, fetchStrategyPlays, fetchStrategyTruth,
} from "@/lib/api";
import { Badge, LoadingState, Panel } from "@/components/ui";
import { PlayBadge } from "@/components/RangeBar";
import { TokenSymbol } from "@/components/TokenSymbol";
import { fmtSol, fmtPct } from "@/lib/format";
import { shortTime } from "@/lib/utils";

const PLAYS: ComboPlay[] = ["eys_seat", "eys_breakout", "eys_tight", "eys_ape", "eys_dump_bonus"];

function num(cfg: StrategyConfig["combo"] | StrategyConfig["jev"], key: string): number | null {
  const v = cfg[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(cfg: StrategyConfig["combo"] | StrategyConfig["jev"], key: string): boolean {
  return cfg[key] === true;
}

/** Plain-English rule summary per play, built from the running [combo]/[jev] config. */
function playRules(play: ComboPlay, combo: StrategyConfig["combo"], jev: StrategyConfig["jev"]): string[] {
  const threshold = num(jev, `entry_threshold_${play}`);
  const thresholdLine = threshold != null ? `Jev composite score must clear ${threshold.toFixed(2)} to enter.` : null;
  const tp = num(combo, "eys_tp_pct");
  const hard = num(combo, "eys_vol_hard_usd_per_min") ?? num(combo, "eys_flow_usd_per_min_min");
  const mcap = num(combo, "eys_mcap_min_usd");
  const fees = num(combo, "eys_fees_earned_min_sol");
  const mult = num(combo, "eys_breakout_mult");
  const spike = num(combo, "eys_breakout_spike_pct");
  const k = (v: number) => `$${(v / 1000).toFixed(0)}k`;

  if (play === "eys_seat") {
    const floor = num(combo, "eys_vol_floor_usd_per_min");
    const accel = num(combo, "eys_vol_accel_min");
    const soft = num(combo, "jev_eys_soft_bar");
    const below = num(combo, "eys_seat_range_below_pct");
    const idle = num(combo, "eys_seat_idle_above_min");
    return [
      "The first entry on a qualifying token: Spot, SOL-side, the default range" + (below != null ? ` (~${below}% below price, top bin = the active bin)` : "") + ".",
      mcap != null && fees != null
        ? `Token must be >= ${k(mcap)} mcap with >= ${fees} SOL of lifetime pool fees, and the fees must scale with the mcap (the fake-volume red flag).`
        : "Token needs real mcap and lifetime fees, scaled to its mcap.",
      hard != null
        ? `Volume bar: >= ${k(hard)}/min is Eys's literal "ape immediately" tier. A softer, dynamic tier opens between a market-percentile floor${floor != null ? ` (never below ${k(floor)}/min)` : ""} and that bar only while volume is accelerating${accel != null ? ` (>= ${accel}x its trailing average)` : ""}, and Jev must then clear a stricter ${soft != null ? soft.toFixed(2) : "composite"} bar.`
        : "Per-minute volume must clear Eys's bar (a dynamic soft tier exists for accelerating volume).",
      tp != null ? `Exit when green by >= +${tp}% or when flow dies (held for a few minutes). Never a stop-loss.` : "Exit when green or when flow dies. Never a stop-loss.",
      idle != null ? `A seat that sits above its range for ${idle} min with no breakout leg open is idle and gets closed.` : null,
      thresholdLine,
    ].filter(Boolean) as string[];
  }

  if (play === "eys_breakout") {
    return [
      "A token-sided SECOND position on a token whose seat is open — the seat is never closed on a breakout; it stays as the backup that catches a dump.",
      `Fires only when price breaks above the top of the seat's range, volume is ${mult ?? 3}x the threshold the seat entered under (Eys: 100k -> 300k per minute) and the last 5m candle is up >= ${spike ?? 10}%.`,
      "Swap SOL for the token and deposit it above price (a fixed ticket; token-sided money is money you are okay losing).",
      tp != null ? `Exit when the range has fully converted to SOL, when green by >= +${tp}%, or when flow dies.` : "Exit when the range has fully converted to SOL, when green, or when flow dies.",
      thresholdLine,
    ].filter(Boolean) as string[];
  }

  if (play === "eys_tight") {
    const bins = num(combo, "eys_tight_bins");
    const obs = num(combo, "eys_tight_observe_min");
    const dump = num(combo, "eys_tight_dump_pct");
    const rng = num(combo, "eys_tight_range_max_pct");
    return [
      `Spot SOL-side tight range${bins != null ? ` (${bins} bins)` : ""} for a token still moving steadily inside a small pump-and-dump range.`,
      `Volume must clear the seat's threshold; the token must have been watched >= ${obs ?? 2} min with no major dump (no 5m candle at or below -${dump ?? 15}%) and its recent candles chopping inside ${rng ?? 25}%.`,
      tp != null ? `Exit when green by >= +${tp}% or when flow dies.` : "Exit when green or when flow dies.",
      "Taken as an extra entry on a token that already has its seat open.",
      thresholdLine,
    ].filter(Boolean) as string[];
  }

  if (play === "eys_dump_bonus") {
    const drop = num(combo, "eys_dump_peak_drop_pct");
    const ath = num(combo, "eys_dump_ath_within_pct");
    const downMin = num(combo, "eys_dump_down_min_pct");
    const downMax = num(combo, "eys_dump_down_max_pct");
    const idleH = num(combo, "eys_dump_idle_max_h");
    return [
      "A bonus play on a token you already hold an Eys position in, once its volume has peaked and is slowing.",
      `Per-minute volume at least ${drop ?? 50}% below its recent peak while price is still within ${ath ?? 20}% of its high.`,
      `Wide Bid-Ask SOL-side${downMin != null && downMax != null ? ` from -${downMin}% to -${downMax}%` : ""} — a trap for the dump.`,
      tp != null ? `Exit when green by >= +${tp}% on a real fill. Flow dying is its premise, not an exit.` : "Exit when green on a real fill.",
      idleH != null ? `A bonus ladder that never fills is closed after ${idleH}h.` : null,
      thresholdLine,
    ].filter(Boolean) as string[];
  }

  // eys_ape
  const sol = num(combo, "ape_sol");
  const feeMin = num(combo, "ape_fee_min_sol");
  const rangeUp = num(combo, "ape_range_up_pct");
  const live = bool(combo, "ape_live_enabled");
  return [
    "Token-sided ape on fresh coins (<= 48h, >= $100k mcap, >= 10 SOL fees) whose pool collects fees in SOL only (read from the pool's on-chain fee mode) — from the whole Meteora sweep, Stonks Launchpad coins get priority.",
    sol != null ? `Fixed ${sol} SOL ticket — not a % of the active budget.` : "Fixed-size ticket.",
    feeMin != null ? `Lifetime fee floor: >= ${feeMin} SOL, and the same fees-per-mcap fake-volume rule as the seat.` : null,
    rangeUp != null ? `Token-sided range up to +${rangeUp}% above price.` : null,
    "Max 1 concurrent. Can go to zero — no stop loss, by design.",
    live ? "Live trading is ON for token-sided plays." : "Live trading is OFF for token-sided plays (paper-only kill switch set).",
    thresholdLine,
  ].filter(Boolean) as string[];
}

const PLAY_TITLE: Record<ComboPlay, string> = {
  eys_seat: "Eys seat",
  eys_breakout: "Eys breakout",
  eys_tight: "Eys tight",
  eys_ape: "Eys ape",
  eys_dump_bonus: "Eys dump bonus",
};

function PlayCard({
  play, combo, jev, stats,
}: {
  play: ComboPlay;
  combo: StrategyConfig["combo"];
  jev: StrategyConfig["jev"];
  stats: PlayStats | undefined;
}) {
  const rules = playRules(play, combo, jev);
  const winRate = stats && stats.closed > 0 ? stats.wins / stats.closed : null;
  return (
    <Panel title={PLAY_TITLE[play]} right={<PlayBadge play={play} />}>
      <ul className="space-y-1 text-[12px] leading-snug text-muted">
        {rules.map((r, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="text-dim">›</span>
            <span>{r}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 grid grid-cols-4 gap-2 border-t border-grid pt-2 text-center">
        <div>
          <div className="text-[9px] tracking-wider text-dim uppercase">Open</div>
          <div className="text-[13px] font-semibold tabular-nums text-fg">{stats?.open ?? 0}</div>
        </div>
        <div>
          <div className="text-[9px] tracking-wider text-dim uppercase">Closed</div>
          <div className="text-[13px] font-semibold tabular-nums text-fg">{stats?.closed ?? 0}</div>
        </div>
        <div>
          <div className="text-[9px] tracking-wider text-dim uppercase">Win rate</div>
          <div className="text-[13px] font-semibold tabular-nums text-fg">{winRate != null ? fmtPct(winRate, 0) : "—"}</div>
        </div>
        <div>
          <div className="text-[9px] tracking-wider text-dim uppercase">Realized</div>
          <div className={`text-[13px] font-semibold tabular-nums ${(stats?.realized_sol ?? 0) >= 0 ? "text-ok" : "text-danger"}`}>
            {fmtSol(stats?.realized_sol ?? 0)}
          </div>
        </div>
      </div>
    </Panel>
  );
}

const OUTCOME_TONE: Record<string, "ok" | "danger" | "warn" | "muted" | "accent"> = {
  enter: "ok",
  exit: "ok",
  skip: "muted",
  hold: "muted",
  uncertain: "warn",
  fallback: "danger",
};

function DecisionRow({ row }: { row: JevDecisionRow }) {
  const tone = OUTCOME_TONE[row.outcome] ?? "muted";
  return (
    <tr className="border-t border-grid align-top">
      <td className="py-1.5 pr-2 text-muted whitespace-nowrap">{shortTime(row.at)}</td>
      <td className="py-1.5 pr-2"><TokenSymbol symbol={row.symbol ?? undefined} mint={row.mint ?? undefined} /></td>
      <td className="py-1.5 pr-2"><PlayBadge play={row.play} /></td>
      <td className="py-1.5 pr-2 text-muted uppercase">{row.lane}</td>
      <td className="py-1.5 pr-2"><Badge tone={tone}>{row.outcome}</Badge></td>
      <td className="py-1.5 pr-2 tabular-nums text-fg">{row.composite_score != null ? row.composite_score.toFixed(3) : "—"}</td>
      <td className="py-1.5 pr-2 text-muted">
        {row.chosen_play
          ? `${row.chosen_play}${row.chosen_play_probability != null ? ` (${(row.chosen_play_probability * 100).toFixed(0)}%)` : ""}`
          : "—"}
      </td>
      <td className="py-1.5 pr-2 tabular-nums text-dim">{row.latency_ms != null ? `${row.latency_ms}ms` : "—"}</td>
      <td className="py-1.5 pr-2 text-dim">{row.model ?? "—"}</td>
      <td className="py-1.5 text-right tabular-nums">
        {row.position_realized_sol != null ? (
          <span className={row.position_realized_sol >= 0 ? "text-ok" : "text-danger"}>{fmtSol(row.position_realized_sol)}</span>
        ) : "—"}
      </td>
    </tr>
  );
}

function TruthChart({ truth }: { truth: StrategyTruth }) {
  const data = useMemo(
    () => truth.rows.map((r) => ({
      t: r.ts,
      label: new Date(r.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      equity: r.equity_sol,
      deposits: r.net_deposits_sol,
    })),
    [truth.rows],
  );
  if (!data.length) {
    return <div className="py-8 text-center text-[12px] tracking-wider text-dim">No truth-pnl history yet</div>;
  }
  return (
    <div style={{ height: 220 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
          <CartesianGrid stroke="#2A2A2A" strokeDasharray="3 5" />
          <XAxis dataKey="label" stroke="#6B6B6B" fontSize={10} tick={{ fill: "#6B6B6B" }} minTickGap={40} />
          <YAxis stroke="#6B6B6B" fontSize={11} tick={{ fill: "#6B6B6B" }} width={56} tickFormatter={(v: number) => v.toFixed(2)} />
          <Tooltip
            contentStyle={{ background: "#141414", border: "1px solid #2A2A2A", fontSize: 12 }}
            formatter={(v, name) => [`${Number(v).toFixed(5)} SOL`, name === "equity" ? "Equity" : "Net deposits"]}
          />
          <Line type="monotone" dataKey="equity" name="equity" stroke="#00FF85" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="deposits" name="deposits" stroke="#1E90FF" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StrategyPage({ watch }: { watch: LiveWatch | null }) {
  const [config, setConfig] = useState<StrategyConfig | null>(null);
  const [plays, setPlays] = useState<PlayStats[]>([]);
  const [decisions, setDecisions] = useState<JevDecisionRow[]>([]);
  const [truth, setTruth] = useState<StrategyTruth | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [playFilter, setPlayFilter] = useState<string>("all");
  const [outcomeFilter, setOutcomeFilter] = useState<string>("all");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [c, p, d, t] = await Promise.all([
          fetchStrategyConfig(), fetchStrategyPlays(), fetchStrategyJev(100), fetchStrategyTruth(500),
        ]);
        if (cancelled) return;
        setConfig(c);
        setPlays(p);
        setDecisions(d);
        setTruth(t);
        setErr(null);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const statsByPlay = useMemo(() => Object.fromEntries(plays.map((p) => [p.play, p])), [plays]);

  const filteredDecisions = useMemo(
    () => decisions.filter((d) =>
      (playFilter === "all" || d.play === playFilter)
      && (outcomeFilter === "all" || d.outcome === outcomeFilter)),
    [decisions, playFilter, outcomeFilter],
  );

  const outcomes = useMemo(
    () => Array.from(new Set(decisions.map((d) => d.outcome))).sort(),
    [decisions],
  );

  const mode = (watch?.book_mode ?? watch?.heartbeat?.mode ?? "").toLowerCase();
  const modeLive = mode === "live";
  const canary = config ? bool(config.combo, "canary_mode") : false;
  const comboEnabled = config ? bool(config.combo, "enabled") : false;
  const jevModel = config?.jev.model ?? null;

  if (loading && !config) {
    return <LoadingState label="Loading strategy…" />;
  }

  return (
    <div className="space-y-3">
      <div>
        <h1 className="font-display text-lg font-semibold tracking-wide">Strategy</h1>
        <p className="text-[11px] text-dim">Read-only view of the combo plays and the Jev decision gate. Nothing here is editable.</p>
      </div>

      {err && (
        <div className="border border-danger/60 bg-panel px-3 py-2 text-danger text-[11px]">ERR // {err}</div>
      )}

      <Panel title="Combo: Eys-only (seat, breakout, tight, ape, dump bonus) — Jev master gate">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={comboEnabled ? "ok" : "muted"}>{comboEnabled ? "combo on" : "combo off"}</Badge>
          <Badge tone={modeLive ? "accent" : "muted"}>{modeLive ? "LIVE" : "PAPER"}</Badge>
          <Badge tone={canary ? "warn" : "muted"}>{canary ? "canary on" : "canary off"}</Badge>
          {jevModel && <Badge tone="fg">jev model {jevModel}</Badge>}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-dim">
          Every candidate must also pass Jev (Typesafe System One) — a composite-scoring gate whose
          thresholds live in code, never in the model. A red flag noul at or above{" "}
          {config ? (num(config.jev, "redflag_veto") ?? "—") : "—"} vetoes an entry outright; a composite
          score between {config ? (num(config.jev, "uncertain_low") ?? "—") : "—"} and{" "}
          {config ? (num(config.jev, "uncertain_high") ?? "—") : "—"} is treated as uncertain: SOL-side plays (Eys seat, tight, dump bonus) then follow their own rules and enter; the token-sided plays (Eys ape, breakout) skip. Slot priority is breakout (for an open seat), seat, tight, ape, dump bonus.
        </p>
      </Panel>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {config && PLAYS.map((play) => (
          <PlayCard key={play} play={play} combo={config.combo} jev={config.jev} stats={statsByPlay[play]} />
        ))}
      </div>

      <Panel
        title="Jev decision log"
        right={
          <div className="flex gap-1.5">
            <select
              value={playFilter}
              onChange={(e) => setPlayFilter(e.target.value)}
              className="border border-grid bg-bg px-1.5 py-0.5 text-[10px] text-muted uppercase tracking-wider"
            >
              <option value="all">All plays</option>
              {PLAYS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select
              value={outcomeFilter}
              onChange={(e) => setOutcomeFilter(e.target.value)}
              className="border border-grid bg-bg px-1.5 py-0.5 text-[10px] text-muted uppercase tracking-wider"
            >
              <option value="all">All outcomes</option>
              {outcomes.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        }
      >
        {!filteredDecisions.length ? (
          <div className="py-8 text-center text-[12px] tracking-wider text-dim">No decisions yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-[12px]">
              <thead className="text-dim">
                <tr>
                  <th className="pb-1.5 pr-2 font-normal">When</th>
                  <th className="pb-1.5 pr-2 font-normal">Token</th>
                  <th className="pb-1.5 pr-2 font-normal">Play</th>
                  <th className="pb-1.5 pr-2 font-normal">Lane</th>
                  <th className="pb-1.5 pr-2 font-normal">Outcome</th>
                  <th className="pb-1.5 pr-2 font-normal">Score</th>
                  <th className="pb-1.5 pr-2 font-normal">Jev chose</th>
                  <th className="pb-1.5 pr-2 font-normal">Latency</th>
                  <th className="pb-1.5 pr-2 font-normal">Model</th>
                  <th className="pb-1.5 font-normal text-right">Realized</th>
                </tr>
              </thead>
              <tbody>
                {filteredDecisions.map((row) => <DecisionRow key={row.id} row={row} />)}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Truth P&L">
        {truth && truth.latest && (
          <div className="mb-3 flex flex-wrap gap-4 text-[12px]">
            <div>
              <span className="text-dim">Equity </span>
              <span className="font-semibold tabular-nums text-fg">{fmtSol(truth.latest.equity_sol)}</span>
            </div>
            <div>
              <span className="text-dim">Net deposits </span>
              <span className="font-semibold tabular-nums text-fg">{fmtSol(truth.latest.net_deposits_sol)}</span>
            </div>
            <div>
              <span className="text-dim">P&L </span>
              <span className={`font-semibold tabular-nums ${truth.latest.pnl_sol >= 0 ? "text-ok" : "text-danger"}`}>
                {fmtSol(truth.latest.pnl_sol)} ({fmtPct(truth.latest.pnl_pct / 100, 1)})
              </span>
            </div>
            <div>
              <span className="text-dim">Unexplained outflow </span>
              <span className={`font-semibold tabular-nums ${truth.latest.unexplained_outflow_sol > 0 ? "text-danger" : "text-ok"}`}>
                {fmtSol(truth.latest.unexplained_outflow_sol)}
              </span>
            </div>
          </div>
        )}
        {truth && <TruthChart truth={truth} />}
      </Panel>
    </div>
  );
}
