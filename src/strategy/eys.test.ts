import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installConfig, restoreConfig } from "../test/config.js";
import { makePool } from "../test/pool.js";
import type { Candidate } from "../types.js";
import {
  _resetEysRuntimeForTests,
  eysPlugin,
  evaluateEys,
  recentFlowObservations,
  recordFlowObservation,
} from "./eys.js";
import { activeStrategyPlugin, resetStrategyRegistryForTests } from "./registry.js";

describe("hosted Eys strategy boundary", () => {
  let dir: string;
  let priorDbPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dlmmbot-eys-test-"));
    priorDbPath = process.env.FARMER_DB_PATH;
    process.env.FARMER_DB_PATH = join(dir, "farmer.db");
    _resetEysRuntimeForTests();
    resetStrategyRegistryForTests();
    installConfig((c) => {
      c.strategy.mode = "eys";
      c.eys.enabled = true;
      c.eys.flow_floor_usd = 100_000;
      c.eys.flow_persistence = 3;
      c.eys.exit_persistence = 3;
    });
  });

  afterEach(() => {
    restoreConfig();
    _resetEysRuntimeForTests();
    if (priorDbPath === undefined) delete process.env.FARMER_DB_PATH;
    else process.env.FARMER_DB_PATH = priorDbPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("requires persistent exact-pool observations before accepting", () => {
    const pool = makePool();
    const candidate: Candidate = {
      pool,
      tokenMint: pool.mintX,
      symbol: "TST",
      score: 90,
      scoreParts: {},
      gateFailures: [],
    };
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      recordFlowObservation({
        poolAddress: pool.address,
        tokenMint: pool.mintX,
        tsMs: now - (2 - i) * 60_000,
        flowUsdPerMin: 110_000,
        source: "gmgn-market-trending",
        cadence: "1m",
      });
    }
    const evidence = {
      exactPool: pool.address,
      flowUsdPerMin: 110_000,
      flowObservedAtMs: now,
      flowSource: "gmgn-market-trending" as const,
      persistentObservations: recentFlowObservations(pool.address, 180, now).length,
      gmgnIntervals: ["5m", "1h"],
      priceChangePct1h: 2,
    };
    expect(evaluateEys(candidate, evidence, "anchor")).toEqual({ accepted: true });
    expect(evaluateEys(candidate, { ...evidence, exactPool: "wrong" }, "anchor")).toEqual({
      accepted: false,
      reason: "exact_pool_mismatch",
    });
  });

  it("rejects a flow observation that expires before final evaluation", () => {
    const pool = makePool();
    const candidate: Candidate = { pool, tokenMint: pool.mintX, symbol: "TST", score: 90, scoreParts: {}, gateFailures: [] };
    const evidence = {
      exactPool: pool.address,
      flowUsdPerMin: 110_000,
      flowObservedAtMs: Date.now() - 181_000,
      flowSource: "gmgn-market-trending" as const,
      persistentObservations: 3,
      gmgnIntervals: ["1m", "5m", "1h"],
      priceChangePct1h: 2,
    };
    expect(evaluateEys(candidate, evidence, "anchor")).toEqual({ accepted: false, reason: "flow_stale" });
  });

  it("applies the Eys market-cap floor after broad intake", () => {
    const pool = makePool({ marketCapUsd: 99_999 });
    const candidate: Candidate = { pool, tokenMint: pool.mintX, symbol: "TST", score: 90, scoreParts: {}, gateFailures: [] };
    const evidence = {
      exactPool: pool.address,
      flowUsdPerMin: 110_000,
      flowObservedAtMs: Date.now(),
      flowSource: "gmgn-market-trending" as const,
      persistentObservations: 3,
      gmgnIntervals: ["1m", "5m", "1h"],
      priceChangePct1h: 2,
    };
    expect(evaluateEys(candidate, evidence, "anchor")).toEqual({ accepted: false, reason: "market_cap_floor" });
  });

  it("proposes a core-clamped Spot plan and refuses token-side mutation", () => {
    const pool = makePool();
    const candidate: Candidate = {
      pool,
      tokenMint: pool.mintX,
      symbol: "TST",
      score: 90,
      scoreParts: {},
      gateFailures: [],
    };
    const base = {
      strategyId: "eys",
      candidate,
      stage: "anchor" as const,
      fundingSide: "sol" as const,
      shape: "spot" as const,
      requestedSizeSol: 0.1,
      evidence: {
        exactPool: pool.address,
        flowUsdPerMin: 120_000,
        flowObservedAtMs: Date.now(),
        flowSource: "gmgn-market-trending" as const,
        persistentObservations: 3,
        gmgnIntervals: ["5m"],
        priceChangePct1h: 1,
      },
    };
    const plan = eysPlugin.plan({
      candidate,
      proposal: base,
      entryPrice: pool.price,
      candles: [],
      requestedSizeSol: 0.1,
    });
    expect(plan?.fundingSide).toBe("sol");
    expect(plan?.shape).toBe("spot");
    expect(plan?.range.minBinId).toBeLessThan(plan!.range.maxBinId);

    expect(eysPlugin.plan({
      candidate,
      proposal: { ...base, stage: "token", fundingSide: "token" },
      entryPrice: pool.price,
      candles: [],
      requestedSizeSol: 0.1,
    })).toBeNull();
  });

  it("marks Eys proposals as strategy-admitted rather than core-score admitted", () => {
    expect(eysPlugin.admissionClass).toBe("strategy");
  });

  it("keeps core as the default and as the disabled-Eys fallback", () => {
    installConfig((c) => {
      c.strategy.mode = "core";
      c.eys.enabled = false;
    });
    expect(activeStrategyPlugin().id).toBe("core");

    installConfig((c) => {
      c.strategy.mode = "eys";
      c.eys.enabled = false;
    });
    expect(activeStrategyPlugin().id).toBe("core");

    installConfig((c) => {
      c.strategy.mode = "eys";
      c.eys.enabled = true;
    });
    expect(activeStrategyPlugin().id).toBe("eys");
  });
});
