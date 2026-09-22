import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginTokenAcquisition, getDb } from "../db/db.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { resetTestDb, useMemoryDb } from "../test/db.js";
import { makePool } from "../test/pool.js";
import type { Candidate, RangePlan } from "../types.js";
import type { StrategyPlugin, StrategyProposal } from "../strategy/plugin.js";
import { FakeExecutor } from "../test/fakeExecutor.js";

vi.mock("../scanner/scan.js", () => ({ scan: vi.fn() }));
vi.mock("../scanner/candles.js", () => ({ fetchCandlesDeep: vi.fn(async () => []) }));
vi.mock("../scanner/meteora.js", () => ({ fetchPool: vi.fn(async () => null) }));
vi.mock("../scanner/gmgn.js", () => ({ trendingByMint: vi.fn(async () => new Map()) }));
vi.mock("../market.js", () => ({
  sol24hChangePct: vi.fn(async () => 0),
  solUsdPrice: vi.fn(async () => 200),
}));
vi.mock("../vetting/vet.js", () => ({
  vetToken: vi.fn(async () => ({ verdict: "pass", softScore: 100, hardFailures: [], soft: {} })),
}));
vi.mock("../ranges/binRent.js", () => ({
  applyBinRentGate: vi.fn(async (input: { range: RangePlan }) => ({
    ok: true,
    range: input.range,
    meta: { est: 0, actual: 0, tier: "normal", budget: 0, shrunk: false },
  })),
}));
vi.mock("../strategy/registry.js", () => ({ activeStrategyPlugin: vi.fn() }));

import { scan } from "../scanner/scan.js";
import { activeStrategyPlugin } from "../strategy/registry.js";
import { enterNewPositions } from "./loop.js";

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

function candidate(address: string): Candidate {
  const pool = makePool({ address, price: 0.001 });
  return { pool, tokenMint: pool.mintX, symbol: address.slice(0, 4), score: 90, scoreParts: {}, gateFailures: [] };
}

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
      gmgnIntervals: ["1m"],
      priceChangePct1h: 12,
    },
  };
}

class QuarantineOnOpenExecutor extends FakeExecutor {
  constructor() {
    super("live");
  }

  override async open(params: Parameters<FakeExecutor["open"]>[0]): Promise<never> {
    this.opens.push(params);
    const id = beginTokenAcquisition("live", params.poolAddress, params.tokenMint);
    getDb().prepare("UPDATE acquisition_intents SET status = 'quarantined', swap_sig = ? WHERE id = ?")
      .run("ambiguous-open", id);
    throw new Error("ambiguous token-side open");
  }
}

describe("entry scan freeze after token-side open failure", () => {
  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.sizing.kelly_enabled = false;
      c.sizing.min_position_sol = 0.01;
      c.sizing.min_position_pct = 0;
      c.sizing.min_position_floor_sol = 0.01;
      c.sizing.max_positions = 2;
      c.rotation.alpha_slots = 0;
      c.entry.tranche_enabled = true;
      c.entry.max_quote_drift_bins = 0;
      c.follow.enabled = false;
      c.majors.enabled = false;
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
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.clearAllMocks();
  });

  it("stops before the next candidate when the first token open becomes unresolved", async () => {
    const first = candidate("PoolFirst111111111111111111111111111111111");
    const second = candidate("PoolSecond11111111111111111111111111111111");
    vi.mocked(scan).mockResolvedValue({ candidates: [first, second], rejected: [], sweptPools: 2 });
    const exec = new QuarantineOnOpenExecutor();
    exec.wallet = 100;

    await enterNewPositions(exec);

    expect(exec.opens).toHaveLength(1);
    expect((getDb().prepare("SELECT COUNT(*) AS c FROM positions").get() as { c: number }).c).toBe(0);
    expect((getDb().prepare("SELECT status FROM acquisition_intents").get() as { status: string }).status)
      .toBe("quarantined");
  });
});
