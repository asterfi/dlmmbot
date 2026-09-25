import type { PositionMark, Executor } from "../executor/executor.js";
import type { GmgnPresence } from "../scanner/gmgn.js";
import type { Candle } from "../scanner/meteora.js";
import type { Candidate, ExitReason, Position, RangePlan, RangeShape } from "../types.js";

export type StrategyFundingSide = "sol" | "token";
export type EysStage = "anchor" | "tight" | "token" | "dump-bonus";

export interface StrategyEvidence {
  exactPool: string;
  flowUsdPerMin: number | null;
  flowObservedAtMs: number | null;
  flowSource: "gmgn-market-trending" | "helius-exact-pool" | null;
  /** Provider cadence the flow value was observed at; only "1m" satisfies Eys. */
  flowCadence: "1m" | null;
  gmgnIntervals: string[];
  priceChangePct1h: number | null;
  /** Present only when Laya overruled a selection gate at discovery time. */
  layaSelectionOverride?: {
    gate: string;
    atMs: number;
    approved: boolean;
    approvalProbability: number | null;
    modelStage: string | null;
    layaReason: string | null;
  };
}

export interface StrategyProposal {
  strategyId: string;
  candidate: Candidate;
  stage: EysStage | "core";
  fundingSide: StrategyFundingSide;
  shape: RangeShape;
  requestedSizeSol: number | null;
  evidence: StrategyEvidence;
}

export interface StrategyDiscoveryContext {
  candidates: readonly Candidate[];
  gmgnByMint: ReadonlyMap<string, GmgnPresence>;
}

export interface StrategyInput {
  candidate: Candidate;
  proposal?: StrategyProposal;
  evidence?: StrategyEvidence;
}

export interface StrategyDecision {
  accepted: boolean;
  reason?: string;
}

export interface StrategyPlanInput {
  candidate: Candidate;
  proposal: StrategyProposal;
  entryPrice: number;
  candles: Candle[];
  requestedSizeSol: number;
}

export interface StrategyPlan {
  range: RangePlan;
  fundingSide: StrategyFundingSide;
  shape: RangeShape;
}

export interface StrategyModelInput {
  candidate: Candidate;
  proposal: StrategyProposal;
  discovery: Record<string, unknown>;
  vetting: unknown;
  score: number;
  requestedSizeSol: number;
  bankroll: Record<string, unknown>;
  range: RangePlan;
  /** Explicit host-side checks supplied after sizing/rent/quote validation. */
  hardGates?: Record<string, unknown>;
  quote?: Record<string, unknown>;
  rent?: Record<string, unknown>;
  positionContext?: Record<string, unknown>;
}

export interface StrategyModelDecision {
  accepted: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
}

export interface StrategyMarkInput {
  executor: Executor;
  position: Position;
  mark: PositionMark;
}

export interface ExitIntent {
  reason: ExitReason;
  code: string;
  detail: string;
}

/**
 * Hosted strategy boundary.
 *
 * A plugin may discover and propose. It never owns wallet keys, quotes,
 * position accounts, transactions, reconciliation, or accounting.
 */
export interface StrategyPlugin {
  readonly id: string;
  /** Core uses score/alpha admission; hosted strategies own their source admission. */
  readonly admissionClass: "core" | "strategy";
  discover(context: StrategyDiscoveryContext): Promise<StrategyProposal[]>;
  evaluate(input: StrategyInput): StrategyDecision;
  plan(input: StrategyPlanInput): StrategyPlan | null;
  modelGate?(input: StrategyModelInput): Promise<StrategyModelDecision>;
  manage(input: StrategyMarkInput): Promise<ExitIntent | null> | ExitIntent | null;
}