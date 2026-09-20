import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config } from "../config.js";
import { mapLimit } from "../concurrent.js";
import { gmgnOneMinuteFlow, trendingByMint } from "../scanner/gmgn.js";
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
import { decideLayaGate, layaMode, requestLaya } from "./laya.js";

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
  flow_floor_usd: 100_000,
  flow_persistence: 3,
  observation_ttl_s: 180,
  exit_persistence: 3,
  entry_sol: 0.1,
  anchor_range_below_pct: 40,
  tight_price_change_pct: 10,
  token_breakout_pct: 25,
  dump_bonus_price_change_pct: 20,
  flow_refresh_s: 60,
};

function finiteAtLeast(value: unknown, fallback: number, minimum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum ? value : fallback;
}

function integerAtLeast(value: unknown, fallback: number, minimum: number): number {
  const number = finiteAtLeast(value, fallback, minimum);
  return Number.isInteger(number) ? number : fallback;
}

function settings() {
  const raw = config().eys ?? {};
  return {
    enabled: raw.enabled === true,
    flow_floor_usd: finiteAtLeast(raw.flow_floor_usd, DEFAULT_EYS.flow_floor_usd, 1),
    flow_persistence: integerAtLeast(raw.flow_persistence, DEFAULT_EYS.flow_persistence, 1),
    observation_ttl_s: finiteAtLeast(raw.observation_ttl_s, DEFAULT_EYS.observation_ttl_s, 1),
    exit_persistence: integerAtLeast(raw.exit_persistence, DEFAULT_EYS.exit_persistence, 1),
    entry_sol: finiteAtLeast(raw.entry_sol, DEFAULT_EYS.entry_sol, 0.000001),
    anchor_range_below_pct: finiteAtLeast(raw.anchor_range_below_pct, DEFAULT_EYS.anchor_range_below_pct, 0),
    tight_price_change_pct: finiteAtLeast(raw.tight_price_change_pct, DEFAULT_EYS.tight_price_change_pct, 0),
    token_breakout_pct: finiteAtLeast(raw.token_breakout_pct, DEFAULT_EYS.token_breakout_pct, 0),
    dump_bonus_price_change_pct: finiteAtLeast(raw.dump_bonus_price_change_pct, DEFAULT_EYS.dump_bonus_price_change_pct, 0),
    flow_refresh_s: finiteAtLeast(raw.flow_refresh_s, DEFAULT_EYS.flow_refresh_s, 1),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
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

export function recentFlowObservations(poolAddress: string, maxAgeS: number, nowMs = Date.now()): FlowObservation[] {
  const cutoff = nowMs - finiteAtLeast(maxAgeS, DEFAULT_EYS.observation_ttl_s, 1) * 1000;
  return loadRows().filter((r) => r.poolAddress === poolAddress && r.tsMs >= cutoff && r.tsMs <= nowMs);
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
  if (!(evidence.flowUsdPerMin != null && evidence.flowUsdPerMin >= cfg.flow_floor_usd)) {
    return { accepted: false, reason: "flow_floor" };
  }
  if (evidence.persistentObservations < cfg.flow_persistence) {
    return { accepted: false, reason: "flow_not_persistent" };
  }
  if (stage === "token") {
    // The proposal is retained for observability, but the host refuses token-side
    // mutation until a core-owned acquisition/accounting service is present.
    return { accepted: true };
  }
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

const lastRefresh = new Map<string, number>();

async function refreshPositionFlow(poolAddress: string, tokenMint: string): Promise<void> {
  const cfg = settings();
  const nowMs = Date.now();
  const previous = lastRefresh.get(poolAddress) ?? 0;
  if (nowMs - previous < cfg.flow_refresh_s * 1000) return;
  lastRefresh.set(poolAddress, nowMs);
  try {
    const flow = gmgnOneMinuteFlow(
      (await trendingByMint()).get(tokenMint),
      nowMs,
      cfg.observation_ttl_s * 1000,
    );
    if (flow) {
      recordFlowObservation({
        poolAddress,
        tokenMint,
        tsMs: flow.observedAtMs,
        flowUsdPerMin: flow.volumeUsd,
        source: flow.source,
        cadence: flow.cadence,
      });
    }
  } catch {
    // Strategy advice never overrides core safety; a missing flow mark simply
    // leaves the core P0-P5 manager in charge.
  }
}

export const eysPlugin: StrategyPlugin = {
  id: "eys",

  async discover(context: StrategyDiscoveryContext): Promise<StrategyProposal[]> {
    const cfg = settings();
    if (!cfg.enabled) return [];
    const intake = context.candidates.filter((candidate) => context.gmgnByMint.has(candidate.tokenMint));
    const evaluated = await mapLimit(intake, async (candidate): Promise<StrategyProposal | null> => {
      const presence = context.gmgnByMint.get(candidate.tokenMint);
      if (!presence) return null;
      const flow = gmgnOneMinuteFlow(presence, Date.now(), cfg.observation_ttl_s * 1000);
      if (!flow) return null;
      recordFlowObservation({
        poolAddress: candidate.pool.address,
        tokenMint: candidate.tokenMint,
        tsMs: flow.observedAtMs,
        flowUsdPerMin: flow.volumeUsd,
        source: flow.source,
        cadence: flow.cadence,
      });
      const recent = recentFlowObservations(candidate.pool.address, cfg.observation_ttl_s);
      const persistent = recent.filter((row) => row.flowUsdPerMin >= cfg.flow_floor_usd).length;
      const priceRow = presence.tokenByInterval.get("1h") ?? presence.token;
      const priceChange = Number.isFinite(priceRow.priceChangePct1h) ? priceRow.priceChangePct1h : 0;
      const stage = stageFor(priceChange, cfg);
      const evidence: StrategyEvidence = {
        exactPool: candidate.pool.address,
        flowUsdPerMin: flow.volumeUsd,
        flowObservedAtMs: flow.observedAtMs,
        flowSource: flow.source,
        persistentObservations: persistent,
        gmgnIntervals: [...presence.intervals],
        priceChangePct1h: priceChange,
      };
      const decision = evaluateEys(candidate, evidence, stage);
      if (!decision.accepted) return null;
      return {
        strategyId: "eys",
        candidate,
        stage,
        fundingSide: stage === "token" ? "token" : "sol",
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

    const evaluation = await requestLaya(modelSnapshot(input));
    const gate = decideLayaGate(mode, evaluation.result, config().laya.min_approval_probability);
    const expectedStage = input.proposal.stage === "token" ? "breakout" : input.proposal.stage;
    const stageMismatch = evaluation.result.stage != null && evaluation.result.stage !== expectedStage;
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
    };
    if (!gate.accepted) return { accepted: false, reason: gate.reason, detail };
    if (mode === "gate" && stageMismatch) {
      return { accepted: false, reason: "laya_stage_mismatch", detail };
    }
    return { accepted: true, reason: mode === "shadow" ? "laya_shadow" : "laya_approved", detail };
  },

  plan(input): StrategyPlan | null {
    if (input.proposal.fundingSide !== "sol") return null;
    return buildSpotRange(input);
  },

  async manage(input: StrategyMarkInput): Promise<ExitIntent | null> {
    const cfg = settings();
    await refreshPositionFlow(input.position.poolAddress, input.position.tokenMint);
    const recent = recentFlowObservations(input.position.poolAddress, cfg.observation_ttl_s);
    if (recent.length < cfg.exit_persistence) return null;
    const tail = recent.slice(-cfg.exit_persistence);
    if (tail.every((row) => row.flowUsdPerMin < cfg.flow_floor_usd)) {
      return {
        reason: "P2_rotation",
        code: "eys_flow_decay",
        detail: `Eys exact-pool flow decayed below $${cfg.flow_floor_usd.toFixed(0)}/min for ${tail.length} observations`,
      };
    }
    return null;
  },
};

export function _resetEysRuntimeForTests(): void {
  lastRefresh.clear();
  resetEysObservationStoreForTests();
}
