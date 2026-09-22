import { dirname, join } from "node:path";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Boundary fixtures only: the Eys plugin, shared manager/risk/ledger and paper
// executor are real. No scanner/provider/RPC/alert or live executor is exercised.
vi.mock("../scanner/scan.js", () => ({ scan: vi.fn() }));
vi.mock("../scanner/meteora.js", () => ({ fetchPool: vi.fn() }));
vi.mock("../scanner/candles.js", () => ({ fetchCandlesDeep: vi.fn(async () => []) }));
vi.mock("../scanner/gmgn.js", async (original) => ({
  ...await original<typeof import("../scanner/gmgn.js")>(),
  trendingByMint: vi.fn(async () => new Map()),
  tokenInfoByMint: vi.fn(async () => new Map()),
}));
vi.mock("../market.js", () => ({ sol24hChangePct: vi.fn(async () => 0), solUsdPrice: vi.fn(async () => 200) }));
vi.mock("../vetting/vet.js", () => ({
  vetToken: vi.fn(async () => ({ verdict: "pass", softScore: 80, hardFailures: [], soft: {} })),
}));
vi.mock("../vetting/rugcheck.js", () => ({ fetchSummary: vi.fn(async () => null) }));
vi.mock("../alerts.js", () => ({ alert: vi.fn(async () => {}) }));
vi.mock("../executor/live.js", () => ({
  LiveExecutor: class { constructor() { throw new Error("Live executor forbidden in synthetic lifecycle"); } },
}));
vi.mock("../ranges/binRent.js", () => ({
  applyBinRentGate: vi.fn(async (a: { range: object }) => ({
    ok: true, range: { ...a.range, estBinRentSol: 0 },
    meta: { est: 0, actual: 0, tier: "normal", budget: 0, shrunk: false },
  })),
}));

import { scan } from "../scanner/scan.js";
import { fetchPool } from "../scanner/meteora.js";
import { tokenInfoByMint, type GmgnPresence, type GmgnTrendingToken } from "../scanner/gmgn.js";
import { applyBinRentGate } from "../ranges/binRent.js";
import { enterNewPositions, managePositions, resetManagerStateForTests } from "./loop.js";
import { PaperExecutor } from "../executor/paper.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useTempDb, resetTestDb } from "../test/db.js";
import { _resetDbForTests, getDb, REALIZED_PNL_SQL } from "../db/db.js";
import { config, currentMode, isLive } from "../config.js";
import { makePool } from "../test/pool.js";
import { priceToBinId } from "../ranges/planner.js";
import { _resetEysRuntimeForTests } from "../strategy/eys.js";
import { resetStrategyRegistryForTests } from "../strategy/registry.js";
import type { Candidate } from "../types.js";

const CLOCK = new Date("2026-09-22T12:00:00.000Z");
function candidate(pool = "AnchorPool", mint = "AnchorMint"): Candidate {
  const p = makePool({ address: pool, mintX: mint });
  return { pool: p, tokenMint: mint, symbol: "ANCHOR", score: 80, scoreParts: {}, gateFailures: [] };
}
function presence(c: Candidate): GmgnPresence {
  const token: GmgnTrendingToken = {
    address: c.tokenMint, symbol: c.symbol, priceChangePct1h: 30,
    volumeUsd: 120_000, liquidityUsd: 100_000, marketCapUsd: 250_000,
    holderCount: 1_000, top10HolderRate: 0.1, renouncedMint: true,
    renouncedFreeze: true, launchpad: "pump", creator: "FixtureCreator",
    openTimestamp: Math.floor(Date.now() / 1000) - 3600,
  };
  return { token, intervals: new Set(["1m"]), tokenByInterval: new Map([["1m", token]]),
    fetchedAtMsByInterval: new Map([["1m", Date.now()]]) };
}
function offer(...candidates: Candidate[]) {
  vi.mocked(scan).mockResolvedValue({ candidates, rejected: [], sweptPools: candidates.length,
    gmgnByMint: new Map(candidates.map((c) => [c.tokenMint, presence(c)])) });
  vi.mocked(fetchPool).mockImplementation(async (address) => candidates.find((c) => c.pool.address === address)?.pool as ReturnType<typeof makePool> ?? null);
}
function count(sql: string): number { return (getDb().prepare(sql).get() as { n: number }).n; }
function gates(): string[] {
  return (getDb().prepare("SELECT failed_gate FROM decisions WHERE action='skipped'").all() as Array<{ failed_gate: string }>).map((r) => r.failed_gate);
}

describe("synthetic Eys anchor → shared paper lifecycle (existing behavior characterization)", () => {
  let dir: string;
  let exec: PaperExecutor;
  let blockedFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(CLOCK);
    vi.stubEnv("FARMER_MODE", "paper");
    dir = dirname(useTempDb());
    vi.stubEnv("FARMER_PAUSE_PATH", join(dir, "PAUSE"));
    vi.stubEnv("FARMER_HALT_PATH", join(dir, "HALT"));
    blockedFetch = vi.fn(() => { throw new Error("Network forbidden in synthetic lifecycle"); });
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      if (url === "fixture://sol-price?ids=So11111111111111111111111111111111111111112") {
        return { json: async () => ({ So11111111111111111111111111111111111111112: { usdPrice: 200 } }) };
      }
      return blockedFetch();
    }));
    _resetEysRuntimeForTests();
    resetStrategyRegistryForTests();
    resetManagerStateForTests();
    installConfig((c) => {
      c.exec.mode = "paper";
      c.apis.jupiter_price = "fixture://sol-price";
      c.strategy.mode = "eys"; c.eys.enabled = true; c.eys.entry_sol = 0.1;
      c.eys.flow_floor_usd = 100_000; c.laya.mode = "off";
      c.sizing.kelly_enabled = false; c.sizing.max_positions = 1;
      c.rotation.alpha_slots = 0; c.rotation.displacement_enabled = false;
      c.entry.tranche_enabled = false; c.follow.enabled = false; c.majors.enabled = false;
      c.manage.max_age_h = 1; c.manage.house_money_rule = false;
      c.manage.give_back_enabled = false; c.manage.claim_min_sol = 100;
      c.manage.claim_interval_h = 100;
    });
    exec = new PaperExecutor();
    expect(currentMode()).toBe("paper");
    expect(isLive()).toBe(false);
  });

  afterEach(() => {
    const networkCalls = blockedFetch.mock.calls.slice();
    _resetEysRuntimeForTests();
    resetManagerStateForTests(); resetStrategyRegistryForTests();
    resetTestDb(); restoreConfig();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
    expect(networkCalls).toEqual([]);
  });

  it("opens SOL Spot through shared execution, reopens its ledger and closes by P2 age with paper accounting", async () => {
    const c = candidate();
    offer(c);
    const open = vi.spyOn(exec, "open");
    await enterNewPositions(exec);
    expect(open).toHaveBeenCalledTimes(1);
    const params = open.mock.calls[0]![0];
    expect(params).toMatchObject({ fundingSide: "sol", tokenMint: c.tokenMint, poolAddress: c.pool.address,
      sizeSol: 0.1, range: { shape: "spot", topPricePct: 0 } });
    expect(params.range.maxBinId).toBe(priceToBinId(c.pool.price, c.pool.binStep, c.pool.decimalsX));
    expect(params.range.minBinId).toBeLessThan(params.range.maxBinId);
    expect(applyBinRentGate).toHaveBeenCalledWith(expect.objectContaining({ fundingSide: "sol", range: expect.objectContaining({ shape: "spot" }) }));
    expect(tokenInfoByMint).not.toHaveBeenCalled(); // One fresh 1m row is sufficient.
    const position = await open.mock.results[0]!.value;
    const entry = getDb().prepare("SELECT features_json FROM decisions WHERE action='entered'").get() as { features_json: string };
    expect(JSON.parse(entry.features_json)).toMatchObject({ strategy: { id: "eys", stage: "anchor", fundingSide: "sol",
      evidence: { exactPool: c.pool.address, flowUsdPerMin: 120_000, flowObservedAtMs: CLOCK.getTime(),
        flowSource: "gmgn-market-trending", flowCadence: "1m" } }, range: { shape: "spot" } });

    await managePositions(exec); // real paper fee accrual + manager marks
    expect(count("SELECT COUNT(*) n FROM positions WHERE state='open'")).toBe(1);
    expect(count("SELECT COUNT(*) n FROM position_marks")).toBe(1);
    expect(count("SELECT COUNT(*) n FROM events WHERE type='deposit'")).toBe(1);

    // A cold object/DB-connection restart, not an OS process or on-chain reconcile.
    _resetDbForTests(); _resetEysRuntimeForTests(); resetManagerStateForTests(); resetStrategyRegistryForTests();
    exec = new PaperExecutor();
    expect(count("SELECT COUNT(*) n FROM positions WHERE state='open'")).toBe(1);
    expect(getDb().prepare("SELECT features_json FROM decisions WHERE action='entered'").get()).toEqual(entry);
    vi.setSystemTime(new Date(CLOCK.getTime() + 3_601_000));
    const close = vi.spyOn(exec, "close");
    await managePositions(exec);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close.mock.calls[0]![0].id).toBe(position.id);
    expect(close.mock.calls[0]![1]).toBe("P2_rotation"); // approved shared overlay, not an invented Eys weak-flow exit
    const row = getDb().prepare(`SELECT *, ${REALIZED_PNL_SQL} AS pnl FROM positions WHERE id=?`).get(position.id) as {
      state: string; exit_reason: string; entry_sol: number; exit_sol: number; open_cost_sol: number;
      close_return_sol: number; pnl: number; fees_measured_sol: number; rent_paid_sol: number;
    };
    expect(row).toMatchObject({ state: "closed_rotation", exit_reason: "P2_rotation", entry_sol: 0.1, rent_paid_sol: 0, fees_measured_sol: 0 });
    const accrued = (getDb().prepare("SELECT SUM(sol_delta) total FROM events WHERE type='deposit'").get() as { total: number }).total;
    expect(accrued).toBeGreaterThan(0);
    expect(row.exit_sol).toBeCloseTo(row.entry_sol + accrued, 12);
    expect(row.open_cost_sol).toBeCloseTo(row.entry_sol + 0.0006, 12);
    expect(row.close_return_sol).toBeCloseTo(row.exit_sol - 0.0006, 12);
    expect(row.pnl).toBeCloseTo(accrued - 0.0012, 12);
    expect(await exec.walletSol()).toBeCloseTo(10 + row.pnl, 12);
    expect(count("SELECT COUNT(*) n FROM decisions WHERE action='exited' AND failed_gate='P2_rotation_age'")).toBe(1);
    expect(count("SELECT COUNT(*) n FROM acquisition_intents")).toBe(0);
    await managePositions(exec);
    expect(close).toHaveBeenCalledTimes(1); // terminal close is not repeated
    const daily = getDb().prepare("SELECT realized_sol FROM pnl_daily WHERE mode='paper'").get() as { realized_sol: number };
    expect(daily.realized_sol).toBeCloseTo(row.pnl, 12);
  });

  it.each(["AnchorPool", "SiblingPool"])("rejects a same-token %s proposal after restart even with a free slot", async (pool) => {
    config().sizing.max_positions = 2; // distinguish duplicate protection from a full book
    // Neutralize the 24h re-entry ladder: at 0.75x the shrunk 0.075 SOL falls
    // under min_reentry_sol (0.1 at this equity) and `ladder_below_min` masks
    // the §5 same-token gate we are here to observe.
    config().manage.reentry_ladder_mult = 1;
    const first = candidate();
    offer(first);
    const open = vi.spyOn(exec, "open");
    await enterNewPositions(exec);
    expect(open).toHaveBeenCalledTimes(1);
    _resetDbForTests(); _resetEysRuntimeForTests(); resetManagerStateForTests(); resetStrategyRegistryForTests();
    exec = new PaperExecutor();
    const restartedOpen = vi.spyOn(exec, "open");
    offer(candidate(pool, first.tokenMint));
    await enterNewPositions(exec);
    expect(restartedOpen).not.toHaveBeenCalled();
    expect(gates()).toContain("already_positioned");
    expect(gates()).not.toContain("ladder_below_min"); // the duplicate gate, not the size floor, rejected it
    expect(count("SELECT COUNT(*) n FROM positions WHERE state='open'")).toBe(1);
    expect(count("SELECT COUNT(*) n FROM acquisition_intents")).toBe(0);
  });
});
