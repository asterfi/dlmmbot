import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Same isolation as entryQuote.test.ts: the score floor is what is under test,
// not the services the pipeline calls before it.
vi.mock("../scanner/scan.js", () => ({ scan: vi.fn(async () => ({ candidates: [], rejected: [], sweptPools: 0 })) }));
vi.mock("../scanner/meteora.js", () => ({ fetchPool: vi.fn(async () => null) }));
vi.mock("../scanner/candles.js", () => ({ fetchCandlesDeep: vi.fn(async () => []) }));
vi.mock("../scanner/gmgn.js", () => ({ trendingByMint: vi.fn(async () => new Map()) }));
vi.mock("../market.js", () => ({
  sol24hChangePct: vi.fn(async () => 0),
  solUsdPrice: vi.fn(async () => 200),
}));
vi.mock("../vetting/vet.js", () => {
  const vetToken = vi.fn(async () => ({ verdict: "pass", softScore: 50, hardFailures: [], soft: {} }));
  return {
    vetToken,
    // Our enter path calls vetWithRetry (bounded transient retry), which
    // upstream's mock does not define — without it every candidate died as
    // vet_error before ever reaching the score floor under test.
    vetWithRetry: () => vetToken(),
  };
});
vi.mock("../ranges/binRent.js", () => ({
  applyBinRentGate: vi.fn(async (a: { range: unknown }) => ({
    ok: true,
    range: a.range,
    meta: { est: 0, actual: 0, tier: "normal", budget: 0, shrunk: false },
  })),
}));
// The entry loop drops any candidate with no strategy proposal
// (`if (!proposal) continue;`) before any gate — including the score floor
// under test — so the plugin must be stubbed for the candidate to arrive.
vi.mock("../strategy/registry.js", () => ({ activeStrategyPlugin: vi.fn() }));

import { scan } from "../scanner/scan.js";
import { activeStrategyPlugin } from "../strategy/registry.js";
import { enterNewPositions, DEFAULT_MIN_ENTRY_SCORE } from "./loop.js";
import type { StrategyPlugin, StrategyProposal } from "../strategy/plugin.js";
import { FakeExecutor } from "../test/fakeExecutor.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb } from "../test/db.js";
import { getDb } from "../db/db.js";
import { makePool } from "../test/pool.js";
import type { Candidate, RangePlan } from "../types.js";

// softScore 50 is the neutral point of the vetting re-blend, so the final
// score equals the scan score (no flow data in tests → no bonus/penalty).
function candidate(score: number): Candidate {
  const pool = makePool({ address: "ScorePool111111111111111111111111111111", binStep: 100, price: 1e-5 });
  return { pool, tokenMint: pool.mintX, symbol: "SCORE", score, scoreParts: {}, gateFailures: [] };
}

const RANGE: RangePlan = {
  minBinId: 100,
  maxBinId: 140,
  binCount: 41,
  positionAccounts: 1,
  bottomPricePct: 0,
  topPricePct: 40,
  shape: "spot",
  fibAnchor: null,
  estBinRentSol: 0.075,
};

function proposal(cand: Candidate): StrategyProposal {
  return {
    strategyId: "eys",
    candidate: cand,
    stage: "token",
    fundingSide: "token",
    shape: "spot",
    requestedSizeSol: 0.1,
    evidence: {
      exactPool: cand.pool.address,
      flowUsdPerMin: 105_000,
      flowObservedAtMs: Date.now(),
      flowSource: "gmgn-market-trending",
      flowCadence: "1m",
      gmgnIntervals: ["1m"],
      priceChangePct1h: 12,
    },
  };
}

const skipped = () =>
  (getDb().prepare("SELECT failed_gate, score, features_json FROM decisions WHERE action='skipped'").all() as
    Array<{ failed_gate: string; score: number; features_json: string }>);

describe("entry score floor", () => {
  let exec: FakeExecutor;

  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.sizing.kelly_enabled = false;
      // Drop the viability floor below the test's 0.1 SOL request: the floor
      // defaults to 0.2 (equity-scaled), which rejected every candidate as
      // ladder_below_min before the open assertions could run. Same keys our
      // other entry tests use — sizing is not what this file exercises.
      c.sizing.min_position_sol = 0.01;
      c.sizing.min_position_pct = 0;
      c.sizing.min_position_floor_sol = 0.01;
      c.sizing.max_positions = 5;
      c.entry.tranche_enabled = false;
      c.entry.max_quote_drift_bins = 0;
      c.follow.enabled = false;
      c.majors.enabled = false;
      c.gates.min_entry_score = 80;
    });
    const plugin: StrategyPlugin = {
      id: "eys",
      admissionClass: "strategy",
      discover: vi.fn(async ({ candidates }) => candidates.map(proposal)),
      evaluate: vi.fn(() => ({ accepted: true })),
      plan: vi.fn(() => ({ range: RANGE, fundingSide: "token" as const, shape: "spot" as const })),
      manage: vi.fn(() => null),
    };
    vi.mocked(activeStrategyPlugin).mockReturnValue(plugin);
    exec = new FakeExecutor("paper");
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.clearAllMocks();
  });

  it("skips a candidate whose final score is under the floor", async () => {
    vi.mocked(scan).mockResolvedValue({ candidates: [candidate(78)], rejected: [], sweptPools: 1 });

    await enterNewPositions(exec);

    expect(exec.opens).toHaveLength(0);
    const s = skipped().filter((d) => d.failed_gate === "score_min");
    expect(s).toHaveLength(1);
    expect(s[0]!.score).toBeCloseTo(78, 5);
    expect(JSON.parse(s[0]!.features_json).required).toBe(80);
  });

  it("enters a candidate at or above the floor", async () => {
    vi.mocked(scan).mockResolvedValue({ candidates: [candidate(82)], rejected: [], sweptPools: 1 });

    await enterNewPositions(exec);

    expect(skipped().map((d) => d.failed_gate)).not.toContain("score_min");
    expect(exec.opens).toHaveLength(1);
  });

  it("falls back to the sizing floor when the config predates the key", async () => {
    expect(DEFAULT_MIN_ENTRY_SCORE).toBe(60);
    installConfig((c) => { delete (c.gates as { min_entry_score?: number }).min_entry_score; });
    vi.mocked(scan).mockResolvedValue({ candidates: [candidate(65)], rejected: [], sweptPools: 1 });

    await enterNewPositions(exec);

    expect(skipped().map((d) => d.failed_gate)).not.toContain("score_min");
    expect(exec.opens).toHaveLength(1);
  });
});
