import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config, effectiveEysFlowFloorUsd, EYS_MAX_POOL_RESOLUTION_MINTS, EYS_MIN_FLOW_FLOOR_USD } from "../config.js";
import { recordDecision } from "../db/db.js";
import { mapLimit } from "../concurrent.js";
import { GMGN_ONE_MINUTE_FRESHNESS_MS, gmgnOneMinuteFlow, mergeGmgnPresenceMaps, tokenInfoByMint } from "../scanner/gmgn.js";
import type { GmgnPresence } from "../scanner/gmgn.js";
import type { Candidate } from "../types.js";
import { binArraysSpanned, binIdToPrice, priceToBinId } from "../ranges/planner.js";
import type {
  EysStage,
  ExitIntent,
  StrategyDecision,
  StrategyDiscoveryContext,
  StrategyModelInput,
  StrategyEvidence,
  StrategyMarkInput,
  StrategyPlan,
  StrategyPlanInput,
  StrategyPlugin,
  StrategyProposal,
} from "./plugin.js";
import {
  buildLayaRequest,
  decideLayaExit,
  decideLayaGate,
  exitAuthorityEnabled,
  layaMode,
  requestLaya,
  requestLayaExit,
  type LayaStage,
} from "./laya.js";
import { sleeveAtEntry, type Sleeve } from "../risk/sleeve.js";
import { manageForSleeve } from "../risk/majorsManage.js";

export interface FlowObservation {
  poolAddress: string;
  tokenMint: string;
  tsMs: number;
  flowUsdPerMin: number;
  source: "gmgn-market-trending";
  cadence: "1m";
}

const DEFAULT_EYS = {
  enabled: false,
  market_cap_floor_usd: 100_000,
  flow_floor_usd: EYS_MIN_FLOW_FLOOR_USD,
  entry_sol: 0.1,
  anchor_range_below_pct: 40,
  tight_price_change_pct: 10,
  token_breakout_pct: 25,
  dump_bonus_price_change_pct: 20,
  gmgn_pool_resolution_max_mints: 12,
  // Eys' "at least 10 SOL in fees" rule (post 2099817371372560521) ≈ $1,700.
  min_pool_fees_usd: 1_700,
  // Eys' "check fees against volume" fake-volume rule: fees24h/vol24h floor.
  // 0.0005 = p01 of fee-floor passers in pool_snapshots (p01 0.00037).
  min_fee_vol_ratio: 0.0005,
  // Entry floor == meme rotation exit floor: feeTvl30m × 48 ≥ 5%/d.
  min_fee_yield_daily_pct: 5,
  // Entry floor == meme rotation exit floor [manage] rotation_vol_30m_min_usd.
  // Never admit a pool whose 30m volume is already under the floor the P2
  // rotation exit uses: that position is born exit-eligible and churns out
  // minutes later having paid rent plus two transaction fees for nothing.
  min_pool_vol_30m_usd: 5_000,
};

function finiteAtLeast(value: unknown, fallback: number, minimum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum ? value : fallback;
}

function integerAtLeast(value: unknown, fallback: number, minimum: number): number {
  const number = finiteAtLeast(value, fallback, minimum);
  return Number.isInteger(number) ? number : fallback;
}

const EYS_REJECTION_DEDUPE_MS = 5 * 60_000;
const eysRejectionLoggedAt = new Map<string, number>();
/** mint:pool -> last selection-override consult, so one reject can't burn a scan. */
const selectionOverrideConsultedAt = new Map<string, number>();

/**
 * Exit-side consult budget: at most one Laya exit consult per position per
 * window. `manage()` runs every tick for every open position, and one consult
 * costs ~5s p50 on the int8 sidecar, so without this the exit lane would
 * monopolise the single-flight sidecar and stall the entry lane behind it.
 */
const EXIT_CONSULT_DEDUPE_MS = 10 * 60 * 1000;
const exitConsultAt = new Map<number, number>();

function recordEysRejection(candidate: Candidate, reason: string | undefined, evidence: unknown): void {
  const gate = `eys_${reason ?? "rejected"}`;
  const key = `${candidate.tokenMint}:${candidate.pool.address}:${gate}`;
  const nowMs = Date.now();
  const previous = eysRejectionLoggedAt.get(key);
  if (previous !== undefined && nowMs - previous < EYS_REJECTION_DEDUPE_MS) return;
  eysRejectionLoggedAt.set(key, nowMs);
  if (eysRejectionLoggedAt.size > 4096) {
    for (const [entryKey, tsMs] of eysRejectionLoggedAt) {
      if (nowMs - tsMs >= EYS_REJECTION_DEDUPE_MS) eysRejectionLoggedAt.delete(entryKey);
    }
  }
  recordDecision(
    candidate.tokenMint,
    candidate.pool.address,
    "skipped",
    gate,
    candidate.score,
    { strategy: "eys", symbol: candidate.symbol, evidence },
  );
}

function settings() {
  const raw = config().eys ?? {};
  return {
    enabled: raw.enabled === true,
    market_cap_floor_usd: finiteAtLeast(raw.market_cap_floor_usd, DEFAULT_EYS.market_cap_floor_usd, 1),
    flow_floor_usd: effectiveEysFlowFloorUsd(raw.flow_floor_usd),
    min_pool_fees_usd: finiteAtLeast(raw.min_pool_fees_usd, DEFAULT_EYS.min_pool_fees_usd, 0),
    min_fee_vol_ratio: finiteAtLeast(raw.min_fee_vol_ratio, DEFAULT_EYS.min_fee_vol_ratio, 0),
    min_fee_yield_daily_pct: finiteAtLeast(raw.min_fee_yield_daily_pct, DEFAULT_EYS.min_fee_yield_daily_pct, 0),
    min_pool_vol_30m_usd: finiteAtLeast(raw.min_pool_vol_30m_usd, DEFAULT_EYS.min_pool_vol_30m_usd, 0),
    entry_sol: finiteAtLeast(raw.entry_sol, DEFAULT_EYS.entry_sol, 0.000001),
    anchor_range_below_pct: finiteAtLeast(raw.anchor_range_below_pct, DEFAULT_EYS.anchor_range_below_pct, 0),
    tight_price_change_pct: finiteAtLeast(raw.tight_price_change_pct, DEFAULT_EYS.tight_price_change_pct, 0),
    token_breakout_pct: finiteAtLeast(raw.token_breakout_pct, DEFAULT_EYS.token_breakout_pct, 0),
    dump_bonus_price_change_pct: finiteAtLeast(raw.dump_bonus_price_change_pct, DEFAULT_EYS.dump_bonus_price_change_pct, 0),
    gmgn_pool_resolution_max_mints: Math.min(
      integerAtLeast(raw.gmgn_pool_resolution_max_mints, DEFAULT_EYS.gmgn_pool_resolution_max_mints, 1),
      EYS_MAX_POOL_RESOLUTION_MINTS,
    ),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

/**
 * Selection gates Laya may overrule when `[laya] selection_authority > 0`.
 *
 * FAIL-CLOSED BY CONSTRUCTION: only Eys' *taste* gates are listed — they say
 * "this setup isn't good enough for the strategy", never "this trade is
 * unsafe". Everything absent stays rule-based and can never be overruled here:
 * pool identity (`exact_pool_mismatch`), missing or stale flow evidence
 * (`flow_stale`, `flow_unavailable`), every scanner/vet/entry-score/sizing/follow
 * gate, and the whole exit ladder. A reason this set does not contain is
 * therefore treated as non-overridable too — unknown never unlocks.
 */
const SELECTION_OVERRIDABLE: ReadonlySet<string> = new Set([
  "flow_floor",
  "market_cap_floor",
  "pool_fees_below_min",
  "fee_vol_ratio_below_min",
  "fee_yield_below_floor",
  "pool_vol_below_floor",
]);

/** Stage values plan() can build for a first (anchor) entry. */
const ANCHOR_COMPATIBLE_STAGES: ReadonlySet<LayaStage> = new Set(["anchor", "tight", "breakout"]);

/**
 * Single source of truth for stage compatibility, shared by the modelGate veto
 * and the selection override. The 2026-09-25 probe relaxed anchor entries to
 * tight/breakout (168/215 historical mismatches were those two) and left
 * dump-bonus vetoed: it is the one shape plan() cannot build for a first entry.
 */
function stageMismatchFor(
  proposalStage: string,
  modelStage: LayaStage | null | undefined,
): boolean {
  if (modelStage == null) return false;
  const expected = proposalStage === "token" ? "breakout" : proposalStage;
  return proposalStage === "anchor"
    ? !ANCHOR_COMPATIBLE_STAGES.has(modelStage)
    : modelStage !== expected;
}

/** Per-discovery-run consult budget. 0/absent = selection stays rule-based. */
function selectionAuthorityBudget(): number {
  const value = config().laya?.selection_authority;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

/**
 * The metric that failed and the limit it missed, mirroring evaluateEys()
 * expression-for-expression so Laya judges the same numbers the rule did.
 */
function selectionGateContext(
  reason: string,
  candidate: Candidate,
  evidence: StrategyEvidence,
): Record<string, unknown> {
  const cfg = settings();
  const pool = candidate.pool;
  const feesUsd24h = (pool.tvlUsd * pool.feeTvl24hPct) / 100;
  const observed: Record<string, { observed: number | null; limit: number }> = {
    flow_floor: { observed: evidence.flowUsdPerMin, limit: cfg.flow_floor_usd },
    market_cap_floor: { observed: pool.marketCapUsd, limit: cfg.market_cap_floor_usd },
    pool_fees_below_min: { observed: feesUsd24h, limit: cfg.min_pool_fees_usd },
    fee_vol_ratio_below_min: {
      observed: pool.vol24hUsd > 0 ? feesUsd24h / pool.vol24hUsd : null,
      limit: cfg.min_fee_vol_ratio,
    },
    fee_yield_below_floor: { observed: pool.feeTvl30mPct * 48, limit: cfg.min_fee_yield_daily_pct },
    pool_vol_below_floor: { observed: pool.vol30mUsd, limit: cfg.min_pool_vol_30m_usd },
  };
  return { overruledGate: reason, ...(observed[reason] ?? {}) };
}

/** Why we did (or did not) put a rule-rejected candidate in front of Laya. */
interface SelectionOverrideOutcome {
  consulted: boolean;
  proposal: StrategyProposal | null;
  detail: {
    gate: string;
    atMs: number;
    approved: boolean;
    approvalProbability: number | null;
    modelStage: string | null;
    layaReason: string | null;
    latencyMs: number | null;
    error?: string;
  };
}

/**
 * Discovery-phase picture of a rule-rejected candidate.
 *
 * Vet, blended score, bankroll and range are all built AFTER discovery, so
 * those sections say so instead of carrying placeholder numbers the model
 * could mistake for measurements. Field layout mirrors modelSnapshot() so the
 * override consult and the later modelGate consult ask about the same shape.
 *
 * Return type is structural rather than LayaRequestSnapshot: that interface
 * omits `proposal`, yet modelSnapshot has always sent it and the model reads
 * stage/fundingSide/shape from state.proposal.
 */
function selectionSnapshot(input: {
  candidate: Candidate;
  proposal: StrategyProposal;
  reason: string;
  evidence: StrategyEvidence;
}) {
  return {
    strategy: "eys" as const,
    discovery: {
      phase: "selection_override",
      ...selectionGateContext(input.reason, input.candidate, input.evidence),
      note: "Rule gates rejected this candidate on selection taste alone. Vetting, entry score, sizing and the exit ladder still apply if you approve.",
    },
    candidate: asRecord({
      mint: input.candidate.tokenMint,
      symbol: input.candidate.symbol,
      score: input.candidate.score,
      scoreParts: input.candidate.scoreParts,
      pool: input.candidate.pool,
    }),
    proposal: {
      stage: input.proposal.stage,
      fundingSide: input.proposal.fundingSide,
      shape: input.proposal.shape,
    },
    evidence: asRecord(input.evidence),
    hardGates: {
      candidateGateFailures: input.candidate.gateFailures,
      vetting: { phase: "not_run_yet" },
    },
    risk: {
      score: input.candidate.score,
      requestedSizeSol: input.proposal.requestedSizeSol,
      bankroll: { phase: "not_run_yet" },
      positionContext: {},
    },
    range: { plan: { phase: "not_run_yet" }, quote: {}, rent: {} },
  };
}

/**
 * Ask Laya to overrule a rule-based selection rejection.
 *
 * Consults are bounded twice: by the per-run budget and by a 5-minute
 * mint:pool dedupe, so one persistent reject cannot burn the scan on repeated
 * 1-9s round trips. Any non-consult path returns `consulted: false` and the
 * caller falls back to the ordinary rule-based rejection. Approval still has
 * to survive vetting, entry score, sizing and the exit ladder downstream —
 * this widens WHO GETS JUDGED, not what has to be safe.
 */
async function selectionOverride(input: {
  candidate: Candidate;
  evidence: StrategyEvidence;
  stage: EysStage;
  reason: string;
  proposal: StrategyProposal;
  budget: { left: number };
}): Promise<SelectionOverrideOutcome> {
  const decline = (detail: Partial<SelectionOverrideOutcome["detail"]>): SelectionOverrideOutcome => ({
    consulted: false,
    proposal: null,
    detail: { gate: input.reason, atMs: Date.now(), approved: false,
      approvalProbability: null, modelStage: null, layaReason: null, latencyMs: null, ...detail },
  });

  const mode = layaMode();
  if (mode !== "gate") return decline({ layaReason: "mode_not_gate" });
  if (!SELECTION_OVERRIDABLE.has(input.reason)) return decline({ layaReason: "gate_not_overridable" });
  if (selectionAuthorityBudget() <= 0) return decline({ layaReason: "budget_disabled" });
  if (input.budget.left <= 0) return decline({ layaReason: "budget_exhausted" });

  // Same mint:pool consulted recently? Skip the model, keep the rule verdict.
  const dedupeKey = `${input.candidate.tokenMint}:${input.candidate.pool.address}`;
  const nowMs = Date.now();
  const previous = selectionOverrideConsultedAt.get(dedupeKey);
  if (previous !== undefined && nowMs - previous < EYS_REJECTION_DEDUPE_MS) {
    return decline({ layaReason: "recently_consulted" });
  }
  selectionOverrideConsultedAt.set(dedupeKey, nowMs);
  if (selectionOverrideConsultedAt.size > 4096) {
    for (const [key, ts] of selectionOverrideConsultedAt) {
      if (nowMs - ts >= EYS_REJECTION_DEDUPE_MS) selectionOverrideConsultedAt.delete(key);
    }
  }
  input.budget.left -= 1;

  const snapshot = selectionSnapshot({
    candidate: input.candidate,
    proposal: input.proposal,
    reason: input.reason,
    evidence: input.evidence,
  });

  const cfg = config().laya;
  const evaluation = await requestLaya(snapshot);
  const gate = decideLayaGate(mode, evaluation.result, cfg.min_approval_probability);
  const modelStage = evaluation.result.stage ?? null;
  const mismatch = stageMismatchFor(input.stage, modelStage);
  const approved = gate.accepted && !mismatch;

  const detail: SelectionOverrideOutcome["detail"] = {
    gate: input.reason,
    atMs: nowMs,
    approved,
    approvalProbability: evaluation.result.approvalProbability ?? null,
    modelStage,
    layaReason: approved ? null : (gate.reason ?? (mismatch ? "laya_stage_mismatch" : "laya_rejected")),
    latencyMs: evaluation.latencyMs,
    ...(evaluation.error ? { error: evaluation.error } : {}),
  };

  // The only line that makes this authority measurable: approvals never write
  // a decisions row (a proposal that proceeds isn't a skip), so grep this.
  console.log(
    `[laya] selection_override consult gate=${input.reason} approved=${approved}` +
      ` p=${detail.approvalProbability ?? "na"} stage=${modelStage ?? "na"}` +
      ` reason=${detail.layaReason ?? "-"} latency=${evaluation.latencyMs}ms` +
      ` mint=${input.candidate.tokenMint.slice(0, 8)} budget_left=${input.budget.left}`,
  );

  if (!approved) return { consulted: true, proposal: null, detail };

  return {
    consulted: true,
    proposal: {
      ...input.proposal,
      evidence: { ...input.evidence, layaSelectionOverride: detail },
    },
    detail,
  };
}

function modelSnapshot(input: StrategyModelInput) {
  return {
    strategy: "eys" as const,
    discovery: input.discovery,
    candidate: asRecord({
      mint: input.candidate.tokenMint,
      symbol: input.candidate.symbol,
      score: input.candidate.score,
      scoreParts: input.candidate.scoreParts,
      pool: input.candidate.pool,
    }),
    proposal: {
      stage: input.proposal.stage,
      fundingSide: input.proposal.fundingSide,
      shape: input.proposal.shape,
    },
    evidence: asRecord(input.proposal.evidence),
    hardGates: {
      candidateGateFailures: input.candidate.gateFailures,
      vetting: asRecord(input.vetting),
      ...(input.hardGates ?? {}),
    },
    risk: {
      score: input.score,
      requestedSizeSol: input.requestedSizeSol,
      bankroll: input.bankroll,
      positionContext: input.positionContext ?? {},
    },
    range: {
      plan: asRecord(input.range),
      quote: input.quote ?? {},
      rent: input.rent ?? {},
    },
  };
}

function observationPath(): string {
  const dbPath = process.env.FARMER_DB_PATH ?? resolve(process.cwd(), "data", "farmer.db");
  return join(dirname(resolve(dbPath)), "eys-observations.json");
}

let loaded: { path: string; rows: FlowObservation[] } | null = null;

function loadRows(): FlowObservation[] {
  const path = observationPath();
  if (loaded?.path === path) return loaded.rows;
  let rows: FlowObservation[] = [];
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        rows = parsed.filter((r): r is FlowObservation =>
          !!r && typeof r === "object" &&
          typeof (r as FlowObservation).poolAddress === "string" &&
          typeof (r as FlowObservation).tokenMint === "string" &&
          Number.isFinite((r as FlowObservation).tsMs) &&
          Number.isFinite((r as FlowObservation).flowUsdPerMin) &&
          (r as FlowObservation).source === "gmgn-market-trending" &&
          (r as FlowObservation).cadence === "1m",
        );
      }
    } catch {
      // Corrupt evidence is not trusted; the next observation rebuilds it.
      rows = [];
    }
  }
  loaded = { path, rows };
  return rows;
}

function persistRows(rows: FlowObservation[]): void {
  const path = observationPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rows.slice(-2048)), { mode: 0o600 });
  renameSync(tmp, path);
}

export function recordFlowObservation(observation: FlowObservation): void {
  if (
    !observation.poolAddress || !observation.tokenMint ||
    !Number.isFinite(observation.tsMs) || !Number.isFinite(observation.flowUsdPerMin) ||
    observation.flowUsdPerMin <= 0 ||
    observation.source !== "gmgn-market-trending" || observation.cadence !== "1m"
  ) return;
  const rows = loadRows();
  const duplicate = rows.some((r) =>
    r.poolAddress === observation.poolAddress && r.tsMs === observation.tsMs,
  );
  if (duplicate) return;
  rows.push(observation);
  rows.sort((a, b) => a.tsMs - b.tsMs);
  persistRows(rows);
}

export function resetEysObservationStoreForTests(): void {
  loaded = null;
}

function stageFor(priceChangePct1h: number, cfg: ReturnType<typeof settings>): EysStage {
  if (priceChangePct1h <= -Math.abs(cfg.dump_bonus_price_change_pct)) return "dump-bonus";
  if (priceChangePct1h >= cfg.token_breakout_pct) return "token";
  if (priceChangePct1h >= cfg.tight_price_change_pct) return "tight";
  return "anchor";
}

export function evaluateEys(
  candidate: Candidate,
  evidence: StrategyEvidence,
  stage: EysStage,
): StrategyDecision {
  const cfg = settings();
  if (!cfg.enabled) return { accepted: false, reason: "eys_disabled" };
  if (evidence.exactPool !== candidate.pool.address) return { accepted: false, reason: "exact_pool_mismatch" };
  const nowMs = Date.now();
  if (
    evidence.flowObservedAtMs == null ||
    !Number.isFinite(evidence.flowObservedAtMs) ||
    evidence.flowObservedAtMs > nowMs ||
    nowMs - evidence.flowObservedAtMs > GMGN_ONE_MINUTE_FRESHNESS_MS
  ) {
    return { accepted: false, reason: "flow_stale" };
  }
  if (!(Number.isFinite(candidate.pool.marketCapUsd) && candidate.pool.marketCapUsd >= cfg.market_cap_floor_usd)) {
    return { accepted: false, reason: "market_cap_floor" };
  }
  if (!(evidence.flowUsdPerMin != null && evidence.flowUsdPerMin >= cfg.flow_floor_usd)) {
    return { accepted: false, reason: "flow_floor" };
  }
  // Eys' selection rules (post 2099817371372560521): "at least 10 SOL in
  // fees" — thin fees on busy volume is bought volume — plus self-consistency
  // with our own exit ladder: never enter a pool whose 30m fee yield is
  // already under the rotation floor (PAID pos#2: entered at ~2%/d, rotated
  // out in 47s for −1.1% because fees could never cover the round trip).
  const feesUsd24h = (candidate.pool.tvlUsd * candidate.pool.feeTvl24hPct) / 100;
  if (!(feesUsd24h >= cfg.min_pool_fees_usd)) return { accepted: false, reason: "pool_fees_below_min" };
  // Eys' stated fake-volume check: "check fees against volume." Ratio =
  // fees24h / vol24h; the 0.0005 floor sits at p01 of fee-floor passers in
  // pool_snapshots (p01 = 0.00037), so it trims only the degenerate tail of
  // pools whose busy volume produces no real fee take. vol24h = 0 is missing
  // evidence, not proof of fakeness — skip, never reject on unknown.
  const vol24hUsd = candidate.pool.vol24hUsd;
  if (vol24hUsd > 0 && !(feesUsd24h / vol24hUsd >= cfg.min_fee_vol_ratio)) return { accepted: false, reason: "fee_vol_ratio_below_min" };
  const feeYieldDailyPct = candidate.pool.feeTvl30mPct * 48;
  if (!(feeYieldDailyPct >= cfg.min_fee_yield_daily_pct)) return { accepted: false, reason: "fee_yield_below_floor" };
  // Self-consistency with the exit ladder, same argument as the fee-yield
  // floor above: P2 rotation exits once pool vol30m drops under $5,000 (3
  // consecutive polls), so admitting under that floor opens a position that is
  // already exit-eligible. Measured on the first 30 live entries, 8 entered
  // with vol30m under the floor and 6 of those churned out inside 5 minutes.
  if (!(candidate.pool.vol30mUsd >= cfg.min_pool_vol_30m_usd)) return { accepted: false, reason: "pool_vol_below_floor" };
  if (stage !== "anchor") return { accepted: false, reason: "child_stage_unsupported" };
  return { accepted: true };
}

function buildSpotRange(input: StrategyPlanInput): StrategyPlan {
  const cfg = settings();
  const entry = config().entry;
  const safetyCap = Math.max(
    entry.min_down_pct,
    Math.abs(config().manage.safety_price_crash_pct) - 10,
  );
  const downPct = Math.max(
    entry.min_down_pct,
    Math.min(cfg.anchor_range_below_pct, entry.max_down_pct, safetyCap),
  );
  const maxBinId = priceToBinId(input.entryPrice, input.candidate.pool.binStep, input.candidate.pool.decimalsX);
  let minBinId = priceToBinId(
    input.entryPrice * (1 - downPct / 100),
    input.candidate.pool.binStep,
    input.candidate.pool.decimalsX,
  );
  const maxBins = 69 * entry.max_position_accounts;
  if (maxBinId - minBinId + 1 > maxBins) minBinId = maxBinId - maxBins + 1;
  const binCount = maxBinId - minBinId + 1;
  return {
    fundingSide: "sol",
    shape: "spot",
    range: {
      minBinId,
      maxBinId,
      binCount,
      positionAccounts: Math.ceil(binCount / 69),
      bottomPricePct: (binIdToPrice(minBinId, input.candidate.pool.binStep, input.candidate.pool.decimalsX) / input.entryPrice - 1) * 100,
      topPricePct: 0,
      shape: "spot",
      fibAnchor: null,
      estBinRentSol: binArraysSpanned(minBinId, maxBinId) * 0.075,
    },
  };
}

function buildTokenRange(input: StrategyPlanInput): StrategyPlan {
  const cfg = settings();
  const entry = config().entry;
  const minBinId = priceToBinId(input.entryPrice, input.candidate.pool.binStep, input.candidate.pool.decimalsX);
  // Eys' token-side stage is a Spot deposit above the active bin. Reuse the
  // configured Eys range width; do not invent a second breakout/persistence
  // threshold or change the existing max-account cap.
  const maxByPrice = priceToBinId(
    input.entryPrice * (1 + cfg.anchor_range_below_pct / 100),
    input.candidate.pool.binStep,
    input.candidate.pool.decimalsX,
  );
  const maxBins = 69 * entry.max_position_accounts;
  const maxBinId = Math.max(minBinId + 1, Math.min(maxByPrice, minBinId + maxBins - 1));
  const binCount = maxBinId - minBinId + 1;
  return {
    fundingSide: "token",
    shape: "spot",
    range: {
      minBinId,
      maxBinId,
      binCount,
      positionAccounts: Math.ceil(binCount / 69),
      bottomPricePct: 0,
      topPricePct: (binIdToPrice(maxBinId, input.candidate.pool.binStep, input.candidate.pool.decimalsX) / input.entryPrice - 1) * 100,
      shape: "spot",
      fibAnchor: null,
      estBinRentSol: binArraysSpanned(minBinId, maxBinId) * 0.075,
    },
  };
}

/**
 * Budget for the bounded direct-enrichment path, in distinct mints per cycle.
 *
 * Measured 2026-09-22: the scan cycle runs ~65s against the 60s 1m freshness
 * window, so most of a ~140-candidate board reaches evaluation with an
 * expired row, and a 5-mint budget covered about 3% of it. Eight mints fit
 * the GMGN spend window once the 1m trending intake is down to four bands
 * (18 weight/min against a 36 weight/min window).
 */
/** Widened 8 -> 12 (09-22) -> 30 (09-23): flow_unavailable was 86% of all
 * rejections (564/658 in 30m); ~19% of scanned pools clear the 5% yield gate
 * but never got a 1m reading under a 12-slot budget, then 30 slots still fell
 * short once candidates ran 35-40/cycle (8-10 never selected). Direct-info
 * cache-miss cap (MAX_DIRECT_INFO_CALLS) moved 8 -> 16 -> 20 alongside; the
 * spend ceiling itself (SPEND_WINDOW_MAX 36/min) is unchanged, so this
 * redistributes existing budget rather than adding rate-limit risk. */
export const EYS_REFRESH_MAX_MINTS = 40;

/**
 * Freshness headroom required at SELECTION time only.
 *
 * `selectEysRefreshMints` runs before `await tokenInfoByMint(...)`, and
 * `evaluateEys` re-checks freshness with a fresh `Date.now()` AFTER that await
 * — measured 2026-09-23: the await costs ~20s, so a row 50s old at selection
 * was 70s old at evaluation. Line 374 skipped it as "already fresh", it was
 * never refreshed, and it was rejected `eys_flow_stale`: 66.9% of those rows
 * carried full [1m,5m,1h] intervals with refreshRequested=false.
 *
 * Only the selection window shrinks. Evaluation still enforces the full 60s
 * against the real clock, so this cannot admit stale evidence — it only spends
 * a refresh slot on rows that would otherwise expire mid-cycle.
 */
export const EYS_REFRESH_SLACK_MS = 25_000;

/** Last known 1m volume at any age; 0 when the mint carries no 1m row. */
function lastKnownOneMinuteVolume(presence?: GmgnPresence): number {
  const volumeUsd = Number(presence?.tokenByInterval.get("1m")?.volumeUsd);
  return Number.isFinite(volumeUsd) && volumeUsd > 0 ? volumeUsd : 0;
}

interface EysRefreshRow {
  candidate: Candidate;
  mint: string;
  lastFlowUsd: number;
  observedAtMs: number;
}

/**
 * Which distinct mints receive the refresh budget this cycle, highest priority
 * first:
 *   1. qualifier — a stale 1m row whose last reading already cleared the flow
 *      floor: one refresh turns it into a proposal this cycle;
 *   2. observed — no presence this cycle but a session observation inside the
 *      freshness window: recent proof the token was trading;
 *   3. coverage — never seen at all: without a slot it stays
 *      `flow_unavailable` forever;
 *   4. known-low — present but sub-floor: refreshed last, only if slots remain.
 *
 * Sibling pools collapse to one mint so no slot is spent twice.
 */
export function selectEysRefreshMints(input: {
  candidates: readonly Candidate[];
  gmgnByMint: ReadonlyMap<string, GmgnPresence>;
  observedAtByPool: ReadonlyMap<string, number>;
  floorUsd: number;
  nowMs?: number;
  budget?: number;
}): string[] {
  const nowMs = input.nowMs ?? Date.now();
  const budget = input.budget ?? EYS_REFRESH_MAX_MINTS;
  const byMint = new Map<string, EysRefreshRow>();
  for (const candidate of input.candidates) {
    if (gmgnOneMinuteFlow(input.gmgnByMint.get(candidate.tokenMint), nowMs, GMGN_ONE_MINUTE_FRESHNESS_MS - EYS_REFRESH_SLACK_MS)) continue;
    const row: EysRefreshRow = {
      candidate,
      mint: candidate.tokenMint,
      lastFlowUsd: lastKnownOneMinuteVolume(input.gmgnByMint.get(candidate.tokenMint)),
      observedAtMs: input.observedAtByPool.get(candidate.pool.address) ?? 0,
    };
    const previous = byMint.get(row.mint);
    if (
      !previous
      || row.lastFlowUsd > previous.lastFlowUsd
      || (row.lastFlowUsd === previous.lastFlowUsd && row.observedAtMs > previous.observedAtMs)
    ) {
      byMint.set(row.mint, row);
    }
  }
  const distinct = [...byMint.values()];
  const qualifier = distinct.filter((row) => row.lastFlowUsd >= input.floorUsd)
    .sort((a, b) => b.lastFlowUsd - a.lastFlowUsd || b.observedAtMs - a.observedAtMs);
  const observed = distinct.filter((row) => row.lastFlowUsd === 0 && row.observedAtMs > 0)
    .sort((a, b) => b.observedAtMs - a.observedAtMs);
  const coverage = distinct.filter((row) => row.lastFlowUsd === 0 && row.observedAtMs === 0)
    .sort((a, b) => b.candidate.score - a.candidate.score);
  const knownLow = distinct.filter((row) => row.lastFlowUsd > 0 && row.lastFlowUsd < input.floorUsd)
    .sort((a, b) => b.observedAtMs - a.observedAtMs || b.candidate.score - a.candidate.score);
  return [...qualifier, ...observed, ...coverage, ...knownLow]
    .slice(0, budget)
    .map((row) => row.mint);
}

export const eysPlugin: StrategyPlugin = {
  id: "eys",
  admissionClass: "strategy",

  async discover(context: StrategyDiscoveryContext): Promise<StrategyProposal[]> {
    const cfg = settings();
    if (!cfg.enabled) return [];

    // Exact candidates may be absent from trending, or their 1m evidence may
    // sit near the window edge and cross it while the batch refresh await runs
    // (every candidate waits it out). Refresh a budgeted, prioritised set of
    // unique mints through the existing provider path; never re-stamp an old row.
    const nowMs = Date.now();
    const recentObservedAtByPool = new Map<string, number>();
    const observationCutoff = nowMs - GMGN_ONE_MINUTE_FRESHNESS_MS;
    for (const row of loadRows()) {
      if (row.tsMs < observationCutoff || row.tsMs > nowMs) continue;
      const previous = recentObservedAtByPool.get(row.poolAddress) ?? 0;
      if (row.tsMs > previous) recentObservedAtByPool.set(row.poolAddress, row.tsMs);
    }
    const refreshMints = selectEysRefreshMints({
      candidates: context.candidates,
      gmgnByMint: context.gmgnByMint,
      observedAtByPool: recentObservedAtByPool,
      floorUsd: effectiveEysFlowFloorUsd(cfg.flow_floor_usd),
      nowMs,
    });
    let direct = new Map<string, import("../scanner/gmgn.js").GmgnPresence>();
    if (refreshMints.length > 0) {
      try {
        direct = await tokenInfoByMint(refreshMints);
      } catch {
        // Missing enrichment is not trusted; candidates without a 1m mark stay out.
      }
    }
    const gmgnByMint = mergeGmgnPresenceMaps(context.gmgnByMint, direct);
    // One consult budget per discovery run: bounds scan latency (each Laya call
    // costs 1-9s) and how many rule verdicts a single cycle may hand over.
    const selectionBudget = { left: selectionAuthorityBudget() };
    const evaluated = await mapLimit(context.candidates, async (candidate): Promise<StrategyProposal | null> => {
      const presence = gmgnByMint.get(candidate.tokenMint);
      const flow = gmgnOneMinuteFlow(presence, Date.now(), GMGN_ONE_MINUTE_FRESHNESS_MS);
      if (!flow || !presence) {
        const observedAtMs = presence?.fetchedAtMsByInterval.get("1m");
        const row = presence?.tokenByInterval.get("1m");
        const stale = row != null && Number.isFinite(row.volumeUsd) && row.volumeUsd > 0 &&
          observedAtMs != null && Number.isFinite(observedAtMs) &&
          (observedAtMs > Date.now() || Date.now() - observedAtMs > GMGN_ONE_MINUTE_FRESHNESS_MS);
        recordEysRejection(candidate, stale ? "flow_stale" : "flow_unavailable", {
          exactPool: candidate.pool.address,
          flowObservedAtMs: observedAtMs ?? null,
          gmgnIntervals: [...(presence?.intervals ?? [])],
          refreshRequested: refreshMints.includes(candidate.tokenMint),
        });
        return null;
      }
      recordFlowObservation({
        poolAddress: candidate.pool.address,
        tokenMint: candidate.tokenMint,
        tsMs: flow.observedAtMs,
        flowUsdPerMin: flow.volumeUsd,
        source: flow.source,
        cadence: flow.cadence,
      });
      const priceRow = presence.tokenByInterval.get("1h") ?? presence.token;
      const priceChange = Number.isFinite(priceRow.priceChangePct1h) ? priceRow.priceChangePct1h : 0;
      // Single-position canary supports the first SOL anchor only. Hourly
      // return is evidence, never proof of an owned-anchor breakout.
      const stage: EysStage = "anchor";
      const evidence: StrategyEvidence = {
        exactPool: candidate.pool.address,
        flowUsdPerMin: flow.volumeUsd,
        flowObservedAtMs: flow.observedAtMs,
        flowSource: flow.source,
        flowCadence: flow.cadence,
        gmgnIntervals: [...presence.intervals],
        priceChangePct1h: priceChange,
      };
      const decision = evaluateEys(candidate, evidence, stage);
      if (!decision.accepted) {
        // Record EVERY rejection, including below-floor flow. An earlier guard
        // persisted only official-flow crossings, fearing the ledger would
        // drown — but recordEysRejection already dedupes per mint+pool+gate for
        // 5 min, so volume was never unbounded. The guard made the funnel lie:
        // logs reported `flow-qualified mints 2-3`/cycle while the ledger showed
        // 0 eys_flow_floor rows, hiding the actual bottleneck (fresh flow below
        // the floor) behind an apparently clean "0 past flow".
        const reason = decision.reason ?? "rejected";
        const override = await selectionOverride({
          candidate,
          evidence,
          stage,
          reason,
          proposal: {
            strategyId: "eys",
            candidate,
            stage,
            fundingSide: "sol",
            shape: "spot",
            requestedSizeSol: cfg.entry_sol,
            evidence,
          },
          budget: selectionBudget,
        });
        if (override.proposal) return override.proposal;
        if (override.consulted) {
          // The model saw it and declined to overrule: the rule's rejection
          // stands, recorded with the consult outcome for measurement.
          recordDecision(
            candidate.tokenMint,
            candidate.pool.address,
            "skipped",
            `eys_${reason}`,
            candidate.score,
            { strategy: "eys", symbol: candidate.symbol, evidence, layaSelectionOverride: override.detail },
          );
          return null;
        }
        recordEysRejection(candidate, decision.reason, evidence);
        return null;
      }
      return {
        strategyId: "eys",
        candidate,
        stage,
        fundingSide: "sol",
        shape: "spot",
        requestedSizeSol: cfg.entry_sol,
        evidence,
      };
    }, 3);
    return evaluated.filter((proposal): proposal is StrategyProposal => proposal !== null);
  },

  evaluate(input): StrategyDecision {
    if (!input.proposal || input.proposal.strategyId !== "eys") return { accepted: false, reason: "not_eys" };
    return evaluateEys(input.candidate, input.proposal.evidence, input.proposal.stage as EysStage);
  },

  async modelGate(input: StrategyModelInput) {
    const mode = layaMode();
    if (mode === "off") return { accepted: true, reason: "laya_disabled" };

    const snapshot = modelSnapshot(input);
    const evaluation = await requestLaya(snapshot);
    const gate = decideLayaGate(mode, evaluation.result, config().laya.min_approval_probability);
    const expectedStage = input.proposal.stage === "token" ? "breakout" : input.proposal.stage;
    // Stage compatibility lives in stageMismatchFor() (shared with the
    // selection override). Source-grounded relaxation: his first entry on a
    // fresh token is the default SOL anchor regardless of the token's recent
    // motion — tight / breakout label upward motion he ENTERS on ("strong
    // upward spikes"), not a different geometry. Only dump-bonus implies a
    // position shape plan() cannot build for a first entry (wide bid-ask
    // near ATH), so it alone remains a mismatch. Probe: 168/215 historical
    // laya_stage_mismatch rows were tight/breakout and now clear; 47
    // dump-bonus rows stay vetoed.
    const modelStage = evaluation.result.stage;
    const stageMismatch = stageMismatchFor(input.proposal.stage, modelStage);
    const detail = {
      mode,
      attempted: evaluation.attempted,
      latencyMs: evaluation.latencyMs,
      model: evaluation.result.model ?? null,
      approved: evaluation.result.approved,
      approvalProbability: evaluation.result.approvalProbability ?? null,
      stage: evaluation.result.stage ?? null,
      confidence: evaluation.result.confidence ?? null,
      reason: evaluation.result.reason ?? null,
      error: evaluation.error ?? null,
      expectedStage,
      stageMismatch,
      // Domain-training label payload: the exact snapshot + questions Laya
      // saw. Persisted by the manager only for entries that actually open;
      // finalized with gold at close (laya_labels).
      state: snapshot,
      questions: buildLayaRequest(snapshot).questions,
    };
    if (!gate.accepted) return { accepted: false, reason: gate.reason, detail };
    if (mode === "gate" && stageMismatch) {
      return { accepted: false, reason: "laya_stage_mismatch", detail };
    }
    return { accepted: true, reason: mode === "shadow" ? "laya_shadow" : "laya_approved", detail };
  },

  plan(input): StrategyPlan | null {
    if (input.proposal.strategyId !== "eys" || input.proposal.stage !== "anchor" ||
        input.proposal.fundingSide !== "sol" || input.proposal.shape !== "spot") return null;
    return buildSpotRange(input);
  },

  /**
   * Exit-side hook. Called every tick for every open position, BEFORE the core
   * exit ladder.
   *
   * Three properties, in order of importance:
   *
   * 1. FAIL-CLOSED TO TODAY'S BEHAVIOR. With `[laya] exit_authority` absent or
   *    0 — the default, and what we ship — this returns null after logging, so
   *    the rule-based ladder stays the only thing that can close a position.
   *    A timeout, invalid JSON or malformed answer also returns null. Nothing
   *    about enabling the log path can move money.
   * 2. BOUNDED COST. Consulted only when the core P2 rotation condition
   *    (fee dead OR volume dead on meme, AND on majors) is actually present,
   *    and at most once per position per 10 minutes, because one consult is
   *    ~5s p50 on the single-flight sidecar.
   * 3. THE PLUGIN NEVER EXECUTES A CLOSE. Returning an ExitIntent only asks;
   *    loop.ts performs the close through the same core path every other exit
   *    uses (see "A plugin may request a close, but it never performs the
   *    close itself").
   *
   * Semantics when authority IS enabled: Laya may ask for the close as soon as
   * decay is present, i.e. faster than the core's `rotation_polls` streak —
   * that is the point of the feature (rotate out the moment decay looks real
   * instead of waiting out the streak). It can never prevent a core exit, since
   * advice to "hold" simply leaves the ladder in charge.
   */
  async manage({ position, mark }: StrategyMarkInput): Promise<ExitIntent | null> {
    const mode = layaMode();
    if (mode === "off") return null;

    // --- 1. Is there a rotation-shaped decision to make at all? ------------
    const sleeve = sleeveAtEntry(position);
    const pm = manageForSleeve(sleeve);
    const feeDaily = mark.feeTvl30mPct * 48;
    const feeDead = feeDaily < pm.rotation_fee_daily_min_pct;
    const volDead = mark.vol30mUsd < pm.rotation_vol_30m_min_usd;
    // Expression mirrors loop.ts P2 exactly so the model judges the same
    // condition the rule would act on.
    const decayed = sleeve === "majors" ? feeDead && volDead : feeDead || volDead;
    if (!decayed) return null;

    // --- 2. Budget: one consult per position per window --------------------
    const nowMs = Date.now();
    const last = exitConsultAt.get(position.id);
    if (last !== undefined && nowMs - last < EXIT_CONSULT_DEDUPE_MS) return null;
    exitConsultAt.set(position.id, nowMs);

    // --- 3. Ask with the full live context -------------------------------
    const ageMin = Math.round((nowMs / 1000 - position.entryTs) / 60);
    const entrySol = position.entrySol;
    const state: Record<string, unknown> = {
      strategy: "eys",
      phase: "exit_review",
      position: {
        id: position.id,
        symbol: position.symbol,
        mint: position.tokenMint,
        pool: position.poolAddress,
        ageMin,
        entrySol,
        valueSol: mark.valueSol,
        valueFrac: entrySol > 0 ? mark.valueSol / entrySol : 1,
        price: mark.price,
        inRange: mark.inRange,
        aboveRange: mark.aboveRange,
        belowRange: mark.belowRange,
      },
      poolHealth: {
        sleeve,
        feeDailyPct: feeDaily,
        feeDead,
        vol30mUsd: mark.vol30mUsd,
        volDead,
        decayed,
        tvlUsd: mark.tvlUsd,
        unclaimedFeesSol: mark.unclaimedFeesSol,
      },
      thresholds: {
        rotation_fee_daily_min_pct: pm.rotation_fee_daily_min_pct,
        rotation_vol_30m_min_usd: pm.rotation_vol_30m_min_usd,
        rotation_polls: pm.rotation_polls,
        max_age_h: pm.max_age_h,
      },
      note: "The rule-based exit ladder stays in charge unless [laya] exit_authority > 0.",
    };

    const evaluation = await requestLayaExit(state);
    const advice = evaluation.advice;
    const authority = exitAuthorityEnabled();
    console.log(
      `[laya] exit_advice pos#${position.id} ${position.symbol} sleeve=${sleeve} ` +
      `action=${advice.action ?? "na"} p=${advice.probability ?? "na"} ` +
      `conf=${advice.confidence ?? "na"} latency=${evaluation.latencyMs ?? "n/a"}ms ` +
      `authority=${authority ? 1 : 0} reason=${advice.reason ?? "-"} ` +
      `feeDaily=${feeDaily.toFixed(3)}% vol30m=$${mark.vol30mUsd.toFixed(0)} ageMin=${ageMin.toFixed(0)}`,
    );

    const decision = decideLayaExit(mode, authority, advice);
    if (!decision.act) return null;

    return {
      reason: "P2_rotation",
      code: "laya_exit",
      detail:
        `Laya exit advice: fee ${feeDaily.toFixed(3)}%/d, vol30m $${mark.vol30mUsd.toFixed(0)}, ` +
        `age ${ageMin.toFixed(0)}m (p=${advice.probability ?? "na"})`,
    };
  },
};

export function _resetEysRuntimeForTests(): void {
  resetEysObservationStoreForTests();
  selectionOverrideConsultedAt.clear();
}
