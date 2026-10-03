/**
 * Jev re-seat range SHADOW test (owner, 2026-10-03). When a seat is repositioned
 * above its range, the rule picks the range (pump origin, clamped). This asks Jev
 * which of three candidate ranges it would pick and only LOGS the answer to its
 * own table (jev_shadow) — never to jev_decisions, never back into the trade.
 * Fire-and-forget: the caller does not await it, every error is swallowed.
 * After enough repositions, compare Jev's picks against the rule's on realized
 * P&L before letting Jev choose for real.
 */
import { config } from "../../config.js";
import { getDb, now } from "../../db/db.js";
import { jevRequest } from "./client.js";
import type { JevQuestion } from "./types.js";

export interface RangeOption {
  bins: number;
  /** Range bottom vs current price, % (negative). */
  bottomPct: number;
}

export interface ReseatShadowInput {
  mint: string;
  pool: string;
  symbol: string;
  /** Which option the rule actually used. */
  ruleChoice: string;
  options: Record<string, RangeOption>;
  context: Record<string, unknown>;
}

let tableReady = false;
function ensureTable(): void {
  if (tableReady) return;
  getDb().exec(`
CREATE TABLE IF NOT EXISTS jev_shadow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  mint TEXT, pool TEXT, symbol TEXT,
  rule_choice TEXT,
  jev_choice TEXT,
  jev_confidence REAL,
  options_json TEXT, state_json TEXT, answers_json TEXT,
  ok INTEGER NOT NULL, error TEXT, latency_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jev_shadow_ts ON jev_shadow(ts DESC);
`);
  tableReady = true;
}

function question(options: Record<string, RangeOption>): Record<string, JevQuestion> {
  const criteria: Record<string, string> = {};
  for (const [id, o] of Object.entries(options)) {
    criteria[id] = `${o.bins} bins, Spot SOL-side from the current price down to ${o.bottomPct.toFixed(1)}%.`;
  }
  return {
    reseat_range: {
      type: "choice",
      instructions: {
        question: "A SOL-side Spot LP seat on this token was just moved up under the current price after the token pumped above the old range. Which range below the current price will earn the most fees from the coming pullback without the price falling through its bottom? Judge `candidate`, `pool` and `pump`.",
        focus: "Narrower ranges earn more per SOL while price trades inside them; deeper ranges survive a bigger dump.",
      },
      criteria,
    },
  };
}

export function jevReseatRangeShadow(input: ReseatShadowInput): void {
  void (async () => {
    try {
      const j = config().jev;
      if (!j || j.enabled === false || !(j as { reseat_range_shadow?: boolean }).reseat_range_shadow) return;
      if (!process.env.TYPESAFE_API_KEY) return;
      ensureTable();
      const state = { candidate: { symbol: input.symbol }, ...input.context };
      const res = await jevRequest(
        { state, model: j.model ?? "jev-1.13.0", questions: question(input.options) },
        { timeoutMs: Math.min(j.timeout_ms ?? 4000, 6000), maxResponseBytes: j.max_response_bytes ?? 131_072 },
      );
      const ans = res.ok ? (res.answers.reseat_range as { choice?: string; confidence?: number } | undefined) : undefined;
      getDb().prepare(
        `INSERT INTO jev_shadow (ts, kind, mint, pool, symbol, rule_choice, jev_choice, jev_confidence,
           options_json, state_json, answers_json, ok, error, latency_ms)
         VALUES (?, 'reseat_range', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        now(), input.mint, input.pool, input.symbol, input.ruleChoice,
        ans?.choice ?? null, ans?.confidence ?? null,
        JSON.stringify(input.options), JSON.stringify(state),
        res.ok ? JSON.stringify(res.answers) : null,
        res.ok ? 1 : 0, res.ok ? null : res.error, res.latencyMs,
      );
      console.log(`[jev-shadow] reseat range ${input.symbol}: rule=${input.ruleChoice} jev=${ans?.choice ?? `n/a (${res.ok ? "no answer" : res.error})`}`);
    } catch (e) {
      console.error("[jev-shadow] reseat range failed (ignored):", (e as Error).message);
    }
  })();
}
