import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installConfig, restoreConfig } from "../test/config.js";
import { makePool } from "../test/pool.js";
import type { Candidate } from "../types.js";
import type { GmgnPresence } from "../scanner/gmgn.js";

const mocks = vi.hoisted(() => ({ tokenInfoByMint: vi.fn(), recordDecision: vi.fn() }));
vi.mock("../scanner/gmgn.js", async (original) => ({
  ...await original<typeof import("../scanner/gmgn.js")>(),
  tokenInfoByMint: mocks.tokenInfoByMint,
}));
vi.mock("../db/db.js", () => ({ recordDecision: mocks.recordDecision }));
import { eysPlugin, _resetEysRuntimeForTests, selectEysRefreshMints, EYS_REFRESH_MAX_MINTS } from "./eys.js";

function candidate(mint = "FreshnessMint", score = 90, poolAddress = mint + "Pool"): Candidate {
  const pool = makePool({ address: poolAddress, mintX: mint, marketCapUsd: 250_000 });
  return { pool, tokenMint: mint, symbol: "TST", score, scoreParts: {}, gateFailures: [] };
}
function presence(mint: string, at: number, volumeUsd = 120_000): GmgnPresence {
  const token = {
    address: mint, symbol: "TST", priceChangePct1h: 2, volumeUsd,
    liquidityUsd: 100_000, marketCapUsd: 250_000, holderCount: 1000,
    top10HolderRate: 0.1, renouncedMint: true, renouncedFreeze: true,
    launchpad: "pump", creator: "creator", openTimestamp: 1,
  };
  return { token, intervals: new Set(["1m"]), tokenByInterval: new Map([["1m", token]]),
    fetchedAtMsByInterval: new Map([["1m", at]]) };
}
let dir: string;
let oldPath: string | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  dir = mkdtempSync(join(tmpdir(), "eys-freshness-"));
  oldPath = process.env.FARMER_DB_PATH;
  process.env.FARMER_DB_PATH = join(dir, "farmer.db");
  _resetEysRuntimeForTests();
  installConfig((c) => { c.strategy.mode = "eys"; c.eys.enabled = true; c.eys.flow_floor_usd = 100_000; });
  mocks.tokenInfoByMint.mockReset().mockResolvedValue(new Map());
  mocks.recordDecision.mockClear();
});
afterEach(() => {
  restoreConfig();
  _resetEysRuntimeForTests();
  if (oldPath === undefined) delete process.env.FARMER_DB_PATH;
  else process.env.FARMER_DB_PATH = oldPath;
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

it.each(["missing", "stale", "wrong-cadence"])("records explicit flow diagnostic for %s evidence", async (kind) => {
  const c = candidate(`Diagnostic-${kind}`);
  const p = presence(c.tokenMint, Date.now() - 61_000);
  if (kind === "wrong-cadence") {
    p.tokenByInterval = new Map([["5m", p.token]]);
    p.intervals = new Set(["5m"]);
    p.fetchedAtMsByInterval = new Map([["5m", Date.now()]]);
  }
  const proposals = await eysPlugin.discover({ candidates: [c], gmgnByMint: kind === "missing" ? new Map() : new Map([[c.tokenMint, p]]) });
  expect(proposals).toEqual([]);
  expect(mocks.recordDecision).toHaveBeenCalledWith(c.tokenMint, c.pool.address, "skipped",
    kind === "stale" ? "eys_flow_stale" : "eys_flow_unavailable", c.score,
    expect.objectContaining({ strategy: "eys", evidence: expect.objectContaining({ exactPool: c.pool.address }) }));
});

it("uses the refresh budget for distinct exact candidates, not sibling pools", async () => {
  const siblings = Array.from({ length: 5 }, (_, i) => candidate("Sibling", 100, `SiblingPool${i}`));
  const others = Array.from({ length: 10 }, (_, i) => candidate(`Other${i}`, 90 - i));
  const candidates = [...siblings, ...others];
  const gmgnByMint = new Map(candidates.map((c) => [c.tokenMint, presence(c.tokenMint, Date.now() - 61_000)]));
  mocks.tokenInfoByMint.mockImplementation(async (mints: string[]) => new Map(mints.map((mint) => [mint, presence(mint, Date.now())])));
  const proposals = await eysPlugin.discover({ candidates, gmgnByMint });
  // 11 distinct mints compete for the 12-slot default budget; dedupe collapses
  // the 5 sibling pools to one mint so no slot is spent twice.
  expect(mocks.tokenInfoByMint).toHaveBeenCalledExactlyOnceWith([
    "Sibling", "Other0", "Other1", "Other2", "Other3", "Other4",
    "Other5", "Other6", "Other7", "Other8", "Other9",
  ]);
  expect(proposals).toHaveLength(15);
  expect(mocks.recordDecision).not.toHaveBeenCalled();
});

it.each([9_999, 10_000])("clamps a sub-floor config to the $10k noise floor with volume %s", async (volume) => {
  installConfig((c) => { c.strategy.mode = "eys"; c.eys.enabled = true; c.eys.flow_floor_usd = 1; });
  const c = candidate(`NoiseFloor-${volume}`);
  mocks.tokenInfoByMint.mockResolvedValue(new Map([[c.tokenMint, presence(c.tokenMint, Date.now(), volume)]]));
  const proposals = await eysPlugin.discover({ candidates: [c], gmgnByMint: new Map() });
  expect(proposals).toHaveLength(volume >= 10_000 ? 1 : 0);
});

it.each([24_999, 25_000])("honours the configured flow floor with refreshed volume %s", async (volume) => {
  installConfig((c) => { c.strategy.mode = "eys"; c.eys.enabled = true; c.eys.flow_floor_usd = 25_000; });
  const c = candidate(`ConfiguredFloor-${volume}`);
  mocks.tokenInfoByMint.mockResolvedValue(new Map([[c.tokenMint, presence(c.tokenMint, Date.now(), volume)]]));
  const proposals = await eysPlugin.discover({ candidates: [c], gmgnByMint: new Map() });
  expect(proposals).toHaveLength(volume >= 25_000 ? 1 : 0);
});

it("ranks a stale proven qualifier ahead of a higher-scored never-seen candidate", () => {
  // The money case: one slot, and the stale mint already read 40k/min last
  // cycle — refreshing it can produce a proposal; refreshing the unseen
  // high-score mint cannot prove anything about flow this cycle.
  const qualifier = candidate("StaleQualifier", 10);
  const unseen = candidate("NeverSeen", 99);
  const gmgnByMint = new Map([[qualifier.tokenMint, presence(qualifier.tokenMint, Date.now() - 61_000, 40_000)]]);

  const mints = selectEysRefreshMints({
    candidates: [unseen, qualifier],
    gmgnByMint,
    observedAtByPool: new Map(),
    floorUsd: 25_000,
    budget: 1,
  });

  expect(mints).toEqual(["StaleQualifier"]);
});

it("default refresh budget covers the coverage-starved funnel (12 mints)", () => {
  // Widened 2026-09-22: budget 8 with a 5-call direct-info cap left most
  // candidates permanently flow_unavailable; 12 keeps the tiered priority
  // order while letting more never-seen mints get a real 1m reading.
  expect(EYS_REFRESH_MAX_MINTS).toBe(12);
  const candidates = Array.from({ length: 20 }, (_, i) => candidate(`Default${i}`, 90 - i));
  const mints = selectEysRefreshMints({
    candidates,
    gmgnByMint: new Map(),
    observedAtByPool: new Map(),
    floorUsd: 25_000,
  });
  expect(mints).toHaveLength(12);
});

it("never returns more mints than the budget allows", () => {
  const candidates = Array.from({ length: 20 }, (_, i) => candidate(`Budget${i}`, 90 - i));
  const mints = selectEysRefreshMints({
    candidates,
    gmgnByMint: new Map(),
    observedAtByPool: new Map(),
    floorUsd: 100_000,
    budget: 8,
  });
  expect(mints).toHaveLength(8);
  expect(new Set(mints).size).toBe(8);
  // Coverage tier: with no evidence at all, score decides the order.
  expect(mints[0]).toBe("Budget0");
});

it("does not refresh a genuine fresh 1m row", async () => {
  const c = candidate("AlreadyFresh");
  const proposals = await eysPlugin.discover({ candidates: [c], gmgnByMint: new Map([[c.tokenMint, presence(c.tokenMint, Date.now())]]) });
  expect(proposals).toHaveLength(1);
  expect(mocks.tokenInfoByMint).not.toHaveBeenCalled();
});

it("does not relabel fresh 5m evidence returned by refresh as 1m", async () => {
  const c = candidate("RefreshWrongCadence");
  const p = presence(c.tokenMint, Date.now());
  p.intervals = new Set(["5m"]);
  p.tokenByInterval = new Map([["5m", p.token]]);
  p.fetchedAtMsByInterval = new Map([["5m", Date.now()]]);
  mocks.tokenInfoByMint.mockResolvedValue(new Map([[c.tokenMint, p]]));
  expect(await eysPlugin.discover({ candidates: [c], gmgnByMint: new Map() })).toEqual([]);
  expect(mocks.recordDecision.mock.calls[0]?.[3]).toBe("eys_flow_unavailable");
});

it("fails closed without retrying when provider refresh fails", async () => {
  const c = candidate("ProviderFailure");
  mocks.tokenInfoByMint.mockRejectedValue(new Error("budget exhausted"));
  expect(await eysPlugin.discover({ candidates: [c], gmgnByMint: new Map() })).toEqual([]);
  expect(mocks.tokenInfoByMint).toHaveBeenCalledTimes(1);
  expect(mocks.recordDecision.mock.calls[0]?.[3]).toBe("eys_flow_unavailable");
});

it("rechecks the timestamp after slow refresh without widening the provider budget", async () => {
  const c = candidate("AgedDuringRefresh");
  const p = presence(c.tokenMint, Date.now());
  mocks.tokenInfoByMint.mockImplementation(async () => {
    vi.setSystemTime(Date.now() + 61_000);
    return new Map([[c.tokenMint, p]]);
  });
  expect(await eysPlugin.discover({ candidates: [c], gmgnByMint: new Map() })).toEqual([]);
  expect(mocks.tokenInfoByMint).toHaveBeenCalledTimes(1);
  expect(mocks.recordDecision.mock.calls[0]?.[3]).toBe("eys_flow_stale");
});

it("refreshes present-but-stale exact candidate 1m evidence after scan enrichment", async () => {
  const c = candidate();
  const stale = presence(c.tokenMint, Date.now() - 61_000);
  const fresh = presence(c.tokenMint, Date.now(), 130_000);
  mocks.tokenInfoByMint.mockResolvedValue(new Map([[c.tokenMint, fresh]]));
  const proposals = await eysPlugin.discover({ candidates: [c], gmgnByMint: new Map([[c.tokenMint, stale]]) });
  expect(mocks.tokenInfoByMint).toHaveBeenCalledExactlyOnceWith([c.tokenMint]);
  expect(proposals).toHaveLength(1);
  expect(proposals[0]!.evidence).toMatchObject({ flowUsdPerMin: 130_000, flowObservedAtMs: Date.now(), flowSource: "gmgn-market-trending", flowCadence: "1m" });
  expect(stale.fetchedAtMsByInterval.get("1m")).toBe(Date.now() - 61_000);
});
