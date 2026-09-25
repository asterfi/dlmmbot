import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installConfig, restoreConfig } from "../test/config.js";
import { makePool } from "../test/pool.js";
import type { Candidate } from "../types.js";
import type { GmgnPresence, GmgnTrendingToken } from "../scanner/gmgn.js";

const gmgnMocks = vi.hoisted(() => ({
  GMGN_ONE_MINUTE_FRESHNESS_MS: 120_000,
  gmgnOneMinuteFlow: vi.fn(),
  mergeGmgnPresenceMaps: vi.fn(),
  tokenInfoByMint: vi.fn(),
  trendingByMint: vi.fn(),
}));
vi.mock("../scanner/gmgn.js", () => gmgnMocks);
vi.mock("./laya.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./laya.js")>()),
  requestLaya: vi.fn(),
}));

import {
  _resetEysRuntimeForTests,
  eysPlugin,
  evaluateEys,
  recordFlowObservation,
} from "./eys.js";
import { activeStrategyPlugin, resetStrategyRegistryForTests } from "./registry.js";
import { requestLaya, type LayaStage } from "./laya.js";
import type { StrategyModelInput } from "./plugin.js";

function makeGmgnPresence(mint: string, flow: number, observedAtMs: number): GmgnPresence {
  const token: GmgnTrendingToken = {
    address: mint,
    symbol: "TST",
    priceChangePct1h: 2,
    volumeUsd: flow,
    liquidityUsd: 100_000,
    marketCapUsd: 250_000,
    holderCount: 1_000,
    top10HolderRate: 0.1,
    renouncedMint: true,
    renouncedFreeze: true,
    launchpad: "pump",
    creator: "Creator1111111111111111111111111111111111111",
    openTimestamp: Math.floor(observedAtMs / 1000) - 3_600,
  };
  return {
    token,
    intervals: new Set(["1m", "1h"]),
    tokenByInterval: new Map([["1m", token], ["1h", token]]),
    fetchedAtMsByInterval: new Map([["1m", observedAtMs], ["1h", observedAtMs]]),
  };
}

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
    });
    gmgnMocks.mergeGmgnPresenceMaps.mockImplementation((primary: ReadonlyMap<string, GmgnPresence>, supplemental: ReadonlyMap<string, GmgnPresence>) => new Map([...primary, ...supplemental]));
    gmgnMocks.gmgnOneMinuteFlow.mockImplementation((presence: GmgnPresence | undefined) => {
      const row = presence?.tokenByInterval.get("1m");
      const observedAtMs = presence?.fetchedAtMsByInterval.get("1m");
      if (!row || observedAtMs == null) return null;
      return { source: "gmgn-market-trending", cadence: "1m", volumeUsd: row.volumeUsd, observedAtMs };
    });
    gmgnMocks.tokenInfoByMint.mockResolvedValue(new Map());
  });

  afterEach(() => {
    vi.clearAllMocks();
    restoreConfig();
    _resetEysRuntimeForTests();
    if (priorDbPath === undefined) delete process.env.FARMER_DB_PATH;
    else process.env.FARMER_DB_PATH = priorDbPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("reserves coverage slots for never-seen candidates and still refreshes proven in-session qualifiers", async () => {
    const makeCandidate = (index: number, score: number): Candidate => {
      const pool = makePool({
        address: `Pool${index}`,
        mintX: `Tok${index}`,
      });
      return {
        pool,
        tokenMint: pool.mintX,
        symbol: `TST${index}`,
        score,
        scoreParts: {},
        gateFailures: [],
      };
    };
    const recentCandidate = makeCandidate(0, 1);
    const competitors = Array.from({ length: 5 }, (_, index) => makeCandidate(index + 1, 100 + index));
    const observedAtMs = Date.now();
    for (const offsetMs of [30_000, 45_000]) {
      recordFlowObservation({
        poolAddress: recentCandidate.pool.address,
        tokenMint: recentCandidate.tokenMint,
        tsMs: observedAtMs - offsetMs,
        flowUsdPerMin: 120_000,
        source: "gmgn-market-trending",
        cadence: "1m",
      });
    }
    gmgnMocks.tokenInfoByMint.mockImplementation(async (mints: string[]) => new Map(
      mints.map((mint) => [mint, makeGmgnPresence(mint, 120_000, Date.now())]),
    ));

    const proposals = await eysPlugin.discover({
      candidates: [recentCandidate, ...competitors],
      gmgnByMint: new Map(),
    });
    const requestedMints = gmgnMocks.tokenInfoByMint.mock.calls[0]?.[0] as string[];

    // 6 candidates fit the 8-mint budget, so neither tier is starved: the
    // never-seen competitors get coverage slots and the proven in-session
    // qualifier still gets refreshed instead of ageing out.
    expect(requestedMints).toHaveLength(6);
    expect(requestedMints).toContain(recentCandidate.tokenMint);
    for (const competitor of competitors) expect(requestedMints).toContain(competitor.tokenMint);
    expect(proposals).toHaveLength(6);
    expect(proposals.some((proposal) => proposal.candidate.pool.address === recentCandidate.pool.address)).toBe(true);
  });

  it("accepts one fresh exact-pool flow observation without invented persistence", () => {
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
    recordFlowObservation({
      poolAddress: pool.address,
      tokenMint: pool.mintX,
      tsMs: now,
      flowUsdPerMin: 110_000,
      source: "gmgn-market-trending",
      cadence: "1m",
    });
    const evidence = {
      exactPool: pool.address,
      flowUsdPerMin: 110_000,
      flowObservedAtMs: now,
      flowSource: "gmgn-market-trending" as const,
      flowCadence: "1m" as const,
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
      flowObservedAtMs: Date.now() - 121_000,
      flowSource: "gmgn-market-trending" as const,
      flowCadence: "1m" as const,
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
      flowCadence: "1m" as const,
      gmgnIntervals: ["1m", "5m", "1h"],
      priceChangePct1h: 2,
    };
    expect(evaluateEys(candidate, evidence, "anchor")).toEqual({ accepted: false, reason: "market_cap_floor" });
  });

  it("rejects a pool under Eys' fee floor — thin fees on busy volume are bought volume", () => {
    // Eys' selection rule (post 2099817371372560521): "at least 10 SOL in
    // fees". $1,700 ≈ 10 SOL; a $50k pool earning 2%/d is only $1,000/24h.
    const pool = makePool({ tvlUsd: 50_000, feeTvl24hPct: 2 });
    const candidate: Candidate = { pool, tokenMint: pool.mintX, symbol: "TST", score: 90, scoreParts: {}, gateFailures: [] };
    const evidence = {
      exactPool: pool.address,
      flowUsdPerMin: 110_000,
      flowObservedAtMs: Date.now(),
      flowSource: "gmgn-market-trending" as const,
      flowCadence: "1m" as const,
      gmgnIntervals: ["1m"],
      priceChangePct1h: 2,
    };
    expect(evaluateEys(candidate, evidence, "anchor")).toEqual({ accepted: false, reason: "pool_fees_below_min" });
  });

  it("never enters a pool whose 30m fee yield is already under the rotation exit floor", () => {
    // Self-consistency: the meme rotation gate exits below 5%/d, so entering
    // there guarantees an exit before fees can cover round-trip friction —
    // the exact failure of PAID pos#2 (47s, −1.1%).
    const pool = makePool({ feeTvl30mPct: 0.04 }); // 0.04 × 48 = 1.92%/d < 5%/d
    const candidate: Candidate = { pool, tokenMint: pool.mintX, symbol: "TST", score: 90, scoreParts: {}, gateFailures: [] };
    const evidence = {
      exactPool: pool.address,
      flowUsdPerMin: 110_000,
      flowObservedAtMs: Date.now(),
      flowSource: "gmgn-market-trending" as const,
      flowCadence: "1m" as const,
      gmgnIntervals: ["1m"],
      priceChangePct1h: 2,
    };
    expect(evaluateEys(candidate, evidence, "anchor")).toEqual({ accepted: false, reason: "fee_yield_below_floor" });
  });

  it("never enters a pool whose 30m volume is already under the rotation exit floor", () => {
    // Self-consistency, the same argument as min_fee_yield_daily_pct: P2
    // rotation exits when pool vol30m drops under $5,000 after 3 polls, so
    // admitting under that floor opens a position that is born exit-eligible.
    // Measured on the first 30 live entries: 8 entered with vol30m under the
    // floor and 6 of those churned out inside 5 minutes, paying rent plus two
    // transaction fees for nothing (combined −0.00333 SOL).
    const pool = makePool({ vol30mUsd: 3_000 });
    const candidate: Candidate = { pool, tokenMint: pool.mintX, symbol: "TST", score: 90, scoreParts: {}, gateFailures: [] };
    const evidence = {
      exactPool: pool.address,
      flowUsdPerMin: 110_000,
      flowObservedAtMs: Date.now(),
      flowSource: "gmgn-market-trending" as const,
      flowCadence: "1m" as const,
      gmgnIntervals: ["1m"],
      priceChangePct1h: 2,
    };
    expect(evaluateEys(candidate, evidence, "anchor")).toEqual({ accepted: false, reason: "pool_vol_below_floor" });
  });

  it("rejects a pool whose fees are negligible against 24h volume — Eys' fake-volume ratio check", () => {
    // Eys: "check fees against volume to detect fake volume." $2,000 fees on
    // $10M 24h volume = ratio 0.0002 — busy volume, no real fee take. Probe of
    // pool_snapshots: p01 ratio among fee-floor passers = 0.00037, so the
    // 0.0005 floor trims only the degenerate bottom tail.
    const pool = makePool({ tvlUsd: 100_000, feeTvl24hPct: 2, vol24hUsd: 10_000_000 });
    const candidate: Candidate = { pool, tokenMint: pool.mintX, symbol: "TST", score: 90, scoreParts: {}, gateFailures: [] };
    const evidence = {
      exactPool: pool.address,
      flowUsdPerMin: 110_000,
      flowObservedAtMs: Date.now(),
      flowSource: "gmgn-market-trending" as const,
      flowCadence: "1m" as const,
      gmgnIntervals: ["1m"],
      priceChangePct1h: 2,
    };
    expect(evaluateEys(candidate, evidence, "anchor")).toEqual({ accepted: false, reason: "fee_vol_ratio_below_min" });
  });

  it("keeps a pool whose 24h fees track its 24h volume", () => {
    // $2,000 fees / $2M volume = 0.001 ≥ 0.0005 — normal fee take passes.
    const pool = makePool({ tvlUsd: 100_000, feeTvl24hPct: 2, vol24hUsd: 2_000_000 });
    const candidate: Candidate = { pool, tokenMint: pool.mintX, symbol: "TST", score: 90, scoreParts: {}, gateFailures: [] };
    const evidence = {
      exactPool: pool.address,
      flowUsdPerMin: 110_000,
      flowObservedAtMs: Date.now(),
      flowSource: "gmgn-market-trending" as const,
      flowCadence: "1m" as const,
      gmgnIntervals: ["1m"],
      priceChangePct1h: 2,
    };
    expect(evaluateEys(candidate, evidence, "anchor")).toEqual({ accepted: true });
  });

  it("does not invent a fake-volume verdict when 24h volume is absent", () => {
    // vol24h = 0 is missing evidence, not proof of fakeness — the ratio gate
    // must skip rather than reject (unknown never becomes a fail).
    const pool = makePool({ tvlUsd: 100_000, feeTvl24hPct: 2, vol24hUsd: 0 });
    const candidate: Candidate = { pool, tokenMint: pool.mintX, symbol: "TST", score: 90, scoreParts: {}, gateFailures: [] };
    const evidence = {
      exactPool: pool.address,
      flowUsdPerMin: 110_000,
      flowObservedAtMs: Date.now(),
      flowSource: "gmgn-market-trending" as const,
      flowCadence: "1m" as const,
      gmgnIntervals: ["1m"],
      priceChangePct1h: 2,
    };
    expect(evaluateEys(candidate, evidence, "anchor")).toEqual({ accepted: true });
  });

  it("proposes core-clamped SOL Spot and token-side Spot plans", () => {
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
        flowCadence: "1m" as const,
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

    const tokenPlan = eysPlugin.plan({
      candidate,
      proposal: { ...base, stage: "token", fundingSide: "token" },
      entryPrice: pool.price,
      candles: [],
      requestedSizeSol: 0.1,
    });
    expect(tokenPlan).toBeNull();
    expect(evaluateEys(candidate, base.evidence, "token")).toEqual({ accepted: false, reason: "child_stage_unsupported" });
  });

  it.each([-90, -20, 0, 10, 25, 1000])("starts with a SOL anchor at hourly return %s", async (change) => {
    const pool = makePool();
    const candidate: Candidate = { pool, tokenMint: pool.mintX, symbol: "TST", score: 90, scoreParts: {}, gateFailures: [] };
    const presence = makeGmgnPresence(pool.mintX, 400_000, Date.now());
    presence.token.priceChangePct1h = change;
    const proposals = await eysPlugin.discover({ candidates: [candidate], gmgnByMint: new Map([[pool.mintX, presence]]) });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ stage: "anchor", fundingSide: "sol", shape: "spot" });
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

describe("Eys modelGate stage compatibility (relaxed per source)", () => {
  let dir: string;
  let priorDbPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dlmmbot-eys-gate-"));
    priorDbPath = process.env.FARMER_DB_PATH;
    process.env.FARMER_DB_PATH = join(dir, "farmer.db");
    _resetEysRuntimeForTests();
    resetStrategyRegistryForTests();
    installConfig((c) => {
      c.strategy.mode = "eys";
      c.eys.enabled = true;
      c.laya.mode = "gate";
      c.laya.min_approval_probability = 0.5;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    restoreConfig();
    _resetEysRuntimeForTests();
    if (priorDbPath === undefined) delete process.env.FARMER_DB_PATH;
    else process.env.FARMER_DB_PATH = priorDbPath;
    rmSync(dir, { recursive: true, force: true });
  });

  function gateInput(): StrategyModelInput {
    const pool = makePool();
    const candidate: Candidate = { pool, tokenMint: pool.mintX, symbol: "TST", score: 90, scoreParts: {}, gateFailures: [] };
    const evidence = {
      exactPool: pool.address,
      flowUsdPerMin: 110_000,
      flowObservedAtMs: Date.now(),
      flowSource: "gmgn-market-trending" as const,
      flowCadence: "1m" as const,
      gmgnIntervals: ["1m"],
      priceChangePct1h: 2,
    };
    return {
      candidate,
      proposal: { strategyId: "eys", candidate, stage: "anchor", fundingSide: "sol", shape: "spot", requestedSizeSol: 0.1, evidence },
      discovery: {},
      vetting: {},
      score: 90,
      requestedSizeSol: 0.1,
      bankroll: {},
      range: { minBinId: 1, maxBinId: 11, binCount: 11, positionAccounts: 1, bottomPricePct: -40, shape: "spot", fibAnchor: null, estBinRentSol: 0.001 },
    };
  }

  function approveWith(stage: LayaStage | null) {
    vi.mocked(requestLaya).mockResolvedValue({
      attempted: true,
      latencyMs: 5,
      result: { approved: true, approvalProbability: 0.6, ...(stage != null ? { stage } : {}) },
    });
  }

  // Source-grounded relaxation: his first entry on a fresh token is the default
  // SOL anchor REGARDLESS of how the token moved in the last hour — tight /
  // breakout describe the token's recent motion (which he enters on: "strong
  // upward spikes"), not a different geometry we must build. Only dump-bonus
  // implies a different position shape (wide bid-ask near ATH) that plan()
  // cannot build, so it alone must still veto an anchor proposal.
  it("accepts an approved anchor proposal when the model labels the stage tight", async () => {
    approveWith("tight");
    const out = await eysPlugin.modelGate!(gateInput());
    expect(out).toMatchObject({ accepted: true, reason: "laya_approved" });
  });

  it("accepts an approved anchor proposal when the model labels the stage breakout", async () => {
    approveWith("breakout");
    const out = await eysPlugin.modelGate!(gateInput());
    expect(out).toMatchObject({ accepted: true, reason: "laya_approved" });
  });

  it("accepts when the model returns no stage at all", async () => {
    approveWith(null);
    const out = await eysPlugin.modelGate!(gateInput());
    expect(out).toMatchObject({ accepted: true, reason: "laya_approved" });
  });

  it("still vetoes dump-bonus: plan() cannot build that geometry for a first entry", async () => {
    approveWith("dump-bonus");
    const out = await eysPlugin.modelGate!(gateInput());
    expect(out).toMatchObject({ accepted: false, reason: "laya_stage_mismatch" });
  });

  it("still honors the probability floor regardless of stage", async () => {
    vi.mocked(requestLaya).mockResolvedValue({
      attempted: true,
      latencyMs: 5,
      result: { approved: true, approvalProbability: 0.3, stage: "tight" },
    });
    const out = await eysPlugin.modelGate!(gateInput());
    expect(out).toMatchObject({ accepted: false, reason: "laya_probability_below_threshold" });
  });
});
