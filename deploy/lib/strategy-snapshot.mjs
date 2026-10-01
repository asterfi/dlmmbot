/**
 * Read-only "Strategy" page data — the combo/jev running config, the jev
 * decision log, per-play stats, and the truth-pnl.jsonl history.
 *
 * [combo]/[jev] are deliberately NOT in config-edit.mjs's EDITABLE_SECTIONS
 * (Jev/combo tuning is a code+config review, not a Settings-page toggle), so
 * getFlatConfig()/the Settings API never surface them. This module reads the
 * same running config.toml read-only, for display only — nothing here can
 * write to it.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { runtimePaths } from "./runtime-paths.mjs";
import { parseConfig } from "./config-edit.mjs";
import { REALIZED_PNL } from "./live-book-snapshot.mjs";
import { resolveBotMode } from "./bot-mode.mjs";

const PLAYS = ["molu_ladder", "danko_trap", "eys_seat", "eys_ape"];

function openDb(root) {
  const require = createRequire(resolve(root, "package.json"));
  const Database = require("better-sqlite3");
  const dbPath = runtimePaths(root).dbPath;
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/** Flatten one TOML section to scalars only (no nested tables expected under combo/jev). */
function pickSection(parsed, section) {
  const body = parsed?.[section];
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (v != null && typeof v === "object") continue;
    out[k] = v;
  }
  return out;
}

/** [combo] and [jev] sections of the running config, as structured JSON. Never env values. */
export function getStrategyConfig(root) {
  const parsed = parseConfig(root);
  return { combo: pickSection(parsed, "combo"), jev: pickSection(parsed, "jev") };
}

function noul(answers, id) {
  const a = answers?.[id];
  return a && a.type === "noul" && typeof a.noul === "number" && Number.isFinite(a.noul) ? a.noul : null;
}

/** Mirrors strategy/jev/policy.ts compositeScore — read-only re-derivation for display. */
function compositeScore(positives, weights) {
  if (!positives || !weights) return null;
  const has = Object.values(positives).some((v) => v != null);
  if (!has) return null;
  return (
    (weights.fresh_flow ?? 0) * (positives.positive_fresh_flow ?? 0) +
    (weights.fee_generation ?? 0) * (positives.positive_fee_generation_sol ?? 0) +
    (weights.bounce ?? 0) * (positives.positive_bounce_confirmed ?? 0) +
    (weights.narrative ?? 0) * (positives.positive_narrative_strength ?? 0)
  );
}

/**
 * The richer approve/reject/uncertain decision (policy.ts) isn't stored as
 * its own column, but it's fully recoverable from the three columns
 * jevConsult *does* write (strategy/jev/index.ts recordRow): fallback=1 means
 * a transport failure (fail-open to the rule's own verdict); outcome="uncertain"
 * means a genuine-but-uncertain answer; otherwise the stored verdict (yes/no)
 * tells entry (enter/skip) or exit (exit/hold) apart.
 */
function decisionOutcome(row) {
  if (row.fallback) return "fallback";
  if (row.outcome === "uncertain") return "uncertain";
  if (row.lane === "enter") return row.verdict === "yes" ? "enter" : "skip";
  if (row.lane === "exit") return row.verdict === "yes" ? "exit" : "hold";
  return row.outcome;
}

/** Recent jev_decisions joined to their position (if any), newest first. */
export function getJevDecisions(root, limit = 100) {
  const db = openDb(root);
  try {
    const n = Math.min(500, Math.max(1, Number(limit) || 100));
    const jevCfg = getStrategyConfig(root).jev;
    const weights = {
      fresh_flow: jevCfg.weight_fresh_flow,
      fee_generation: jevCfg.weight_fee_generation,
      bounce: jevCfg.weight_bounce,
      narrative: jevCfg.weight_narrative,
    };
    const rows = db.prepare(
      `SELECT d.id, d.ts, d.position_id, d.lane, d.play, d.mint, d.pool,
              d.verdict, d.fallback, d.outcome, d.latency_ms, d.model, d.answers_json,
              p.symbol AS position_symbol, p.state AS position_state, p.exit_ts AS position_exit_ts,
              (${REALIZED_PNL}) AS position_realized_sol
       FROM jev_decisions d
       LEFT JOIN positions p ON p.id = d.position_id
       ORDER BY d.ts DESC
       LIMIT ?`
    ).all(n);

    return rows.map((r) => {
      let answers = null;
      try { answers = r.answers_json ? JSON.parse(r.answers_json) : null; } catch { /* malformed row */ }

      let redFlags = null;
      let compositeS = null;
      let chosenPlay = null;
      let chosenPlayProbability = null;
      let exit = null;

      if (answers && r.lane === "enter") {
        redFlags = {
          wash_volume: noul(answers, "redflag_wash_volume"),
          security: noul(answers, "redflag_security"),
          exhausted_spike: noul(answers, "redflag_exhausted_spike"),
          insider_dumping: noul(answers, "redflag_insider_dumping"),
        };
        const positives = {
          positive_fresh_flow: noul(answers, "positive_fresh_flow"),
          positive_fee_generation_sol: noul(answers, "positive_fee_generation_sol"),
          positive_bounce_confirmed: noul(answers, "positive_bounce_confirmed"),
          positive_narrative_strength: noul(answers, "positive_narrative_strength"),
        };
        compositeS = compositeScore(positives, weights);
        const playAns = answers.play;
        if (playAns?.type === "choice") {
          chosenPlay = playAns.choice ?? null;
          chosenPlayProbability = chosenPlay && playAns.probabilities
            ? (playAns.probabilities[chosenPlay] ?? null)
            : (playAns.confidence ?? null);
        }
      } else if (answers && r.lane === "exit") {
        exit = {
          thesis_broken: noul(answers, "redflag_thesis_broken"),
          flow_dead: noul(answers, "exit_flow_dead"),
          action_choice: answers.exit_action?.choice ?? null,
          action_confidence: answers.exit_action?.confidence ?? null,
        };
      }

      return {
        id: r.id,
        ts: r.ts,
        at: new Date(r.ts * 1000).toISOString(),
        lane: r.lane,
        play: r.play,
        mint: r.mint,
        pool: r.pool,
        symbol: r.position_symbol ?? null,
        position_id: r.position_id,
        verdict: r.verdict,
        fallback: !!r.fallback,
        outcome: decisionOutcome(r),
        latency_ms: r.latency_ms,
        model: r.model,
        red_flags: redFlags,
        composite_score: compositeS != null ? Math.round(compositeS * 1e4) / 1e4 : null,
        chosen_play: chosenPlay,
        chosen_play_probability: chosenPlayProbability != null ? Math.round(chosenPlayProbability * 1e4) / 1e4 : null,
        exit,
        position_realized_sol: r.position_exit_ts != null && r.position_realized_sol != null
          ? Math.round(Number(r.position_realized_sol) * 1e6) / 1e6
          : null,
      };
    });
  } finally {
    db.close();
  }
}

/** Per-play counts (open/closed/wins) + realized SOL, same REALIZED_PNL truth-math as the rest of the dash. */
export function getPlayStats(root) {
  const db = openDb(root);
  try {
    const bookMode = resolveBotMode(root);
    const rows = db.prepare(
      `SELECT play,
              SUM(CASE WHEN state IN ('open','pending','closing') THEN 1 ELSE 0 END) AS open_n,
              SUM(CASE WHEN exit_ts IS NOT NULL THEN 1 ELSE 0 END) AS closed_n,
              SUM(CASE WHEN exit_ts IS NOT NULL AND (${REALIZED_PNL}) > 0 THEN 1 ELSE 0 END) AS wins,
              ROUND(SUM(CASE WHEN exit_ts IS NOT NULL THEN (${REALIZED_PNL}) ELSE 0 END), 6) AS realized_sol
       FROM positions
       WHERE play IS NOT NULL AND mode = ?
       GROUP BY play`
    ).all(bookMode);
    const byPlay = Object.fromEntries(rows.map((r) => [r.play, r]));
    return PLAYS.map((play) => {
      const r = byPlay[play];
      return {
        play,
        open: r ? Number(r.open_n) || 0 : 0,
        closed: r ? Number(r.closed_n) || 0 : 0,
        wins: r ? Number(r.wins) || 0 : 0,
        realized_sol: r && r.realized_sol != null ? Number(r.realized_sol) : 0,
      };
    });
  } finally {
    db.close();
  }
}

/** Tail of truth-pnl.jsonl (scripts/truth-pnl.ts appends one line per run). */
export function getTruthPnl(root, limit = 500) {
  const path = join(runtimePaths(root).dataDir, "truth-pnl.jsonl");
  if (!existsSync(path)) return { rows: [], latest: null };
  const n = Math.min(2000, Math.max(1, Number(limit) || 500));
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (const line of lines.slice(-n)) {
    try { rows.push(JSON.parse(line)); } catch { /* skip malformed line */ }
  }
  return { rows, latest: rows.length ? rows[rows.length - 1] : null };
}
