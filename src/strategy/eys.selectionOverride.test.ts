import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installConfig, restoreConfig } from "../test/config.js";
import { makePool } from "../test/pool.js";
import type { Candidate } from "../types.js";
import type { GmgnPresence } from "../scanner/gmgn.js";
import type { LayaEvaluation } from "./laya.js";

const mocks = vi.hoisted(() => ({
  tokenInfoByMint: vi.fn(),
  recordDecision: vi.fn(),
  requestLaya: vi.fn(),
}));
vi.mock("../scanner/gmgn.js", async (original) => ({
  ...await original<typeof import("../scanner/gmgn.js")>(),
  tokenInfoByMint: mocks.tokenInfoByMint,
}));
vi.mock("../db/db.js", () => ({ recordDecision: mocks.recordDecision }));
vi.mock("./laya.js", async (original) => ({
  ...await original<typeof import("./laya.js")>(),
  requestLaya: mocks.requestLaya,
}));
import { eysPlugin, _resetEysRuntimeForTests } from "./eys.js";

function candidate(mint: string, score = 90, poolAddress = mint + "Pool"): Candidate {
  const pool = makePool({ address: poolAddress, mintX: mint, marketCapUsd: 250_000 });
  return { pool, tokenMint: mint, symbol: "TST", score, scoreParts: {}, gateFailures: [] };
}

/** Fresh 1m flow at `volumeUsd` — below the 100k floor installed below. */
function presence(mint: string, volumeUsd = 50_000): GmgnPresence {
  const at = Date.now() - 5_000;
  const token = {
    address: mint, symbol: "TST", priceChangePct1h: 2, volumeUsd,
    liquidityUsd: 100_000, marketCapUsd: 250_000, holderCount: 1000,
    top10HolderRate: 0.1, renouncedMint: true, renouncedFreeze: true,
    launchpad: "pump", creator: "creator", openTimestamp: 1,
  };
  return {
    token, intervals: new Set(["1m"]),
    tokenByInterval: new Map([["1m", token]]),
    fetchedAtMsByInterval: new Map([["1m", at]]),
  };
}

function approval(overrides: Partial<NonNullable<LayaEvaluation["result"]>> = {}): LayaEvaluation {
  return {
    attempted: true,
    latencyMs: 12,
    result: { approved: true, approvalProbability: 0.62, stage: "anchor", confidence: 0.8, ...overrides },
  };
}

function discover(c: Candidate) {
  return eysPlugin.discover({ candidates: [c], gmgnByMint: new Map([[c.tokenMint, presence(c.tokenMint)]]) });
}

/** Features of the decisions row recorded for one specific mint. */
function featuresFor(mint: string): Record<string, unknown> | undefined {
  const call = mocks.recordDecision.mock.calls.find((args) => args[0] === mint);
  return call?.[5] as Record<string, unknown> | undefined;
}

let dir: string;
let oldPath: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  dir = mkdtempSync(join(tmpdir(), "eys-override-"));
  oldPath = process.env.FARMER_DB_PATH;
  process.env.FARMER_DB_PATH = join(dir, "farmer.db");
  _resetEysRuntimeForTests();
  installConfig((c) => {
    c.strategy.mode = "eys";
    c.eys.enabled = true;
    c.eys.flow_floor_usd = 100_000;
    c.eys.market_cap_floor_usd = 100_000;
    c.laya.mode = "gate";
    c.laya.base_url = "http://127.0.0.1:18150";
    c.laya.min_approval_probability = 0.5;
    c.laya.selection_authority = 0;
  });
  mocks.tokenInfoByMint.mockReset().mockResolvedValue(new Map());
  mocks.recordDecision.mockClear();
  mocks.requestLaya.mockReset().mockResolvedValue(approval());
});
afterEach(() => {
  restoreConfig();
  _resetEysRuntimeForTests();
  if (oldPath === undefined) delete process.env.FARMER_DB_PATH;
  else process.env.FARMER_DB_PATH = oldPath;
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

it("keeps selection rule-based when selection_authority is 0 (default)", async () => {
  const c = candidate("AuthorityOff");
  const proposals = await discover(c);
  expect(proposals).toEqual([]);
  expect(mocks.requestLaya).not.toHaveBeenCalled();
  expect(mocks.recordDecision).toHaveBeenCalledWith(c.tokenMint, c.pool.address, "skipped",
    "eys_flow_floor", c.score,
    expect.objectContaining({ strategy: "eys" }));
  // No consult outcome in the features: this was a plain rule rejection.
  expect(featuresFor(c.tokenMint)?.layaSelectionOverride).toBeUndefined();
});

it("lets an approving model overrule the flow floor and marks the proposal", async () => {
  installConfig((c) => { c.laya.selection_authority = 2; });
  const c = candidate("Overruled");
  const proposals = await discover(c);
  expect(proposals).toHaveLength(1);
  expect(proposals[0]!.evidence.layaSelectionOverride).toMatchObject({
    gate: "flow_floor", approved: true, approvalProbability: 0.62, modelStage: "anchor",
  });
  // Nothing recorded as skipped — the rule's rejection was reversed.
  expect(mocks.recordDecision).not.toHaveBeenCalled();
});

it("passes the failing metric and its limit to the model", async () => {
  installConfig((c) => { c.laya.selection_authority = 2; });
  await discover(candidate("GateContext"));
  expect(mocks.requestLaya).toHaveBeenCalledTimes(1);
  const snapshot = mocks.requestLaya.mock.calls[0]![0] as Record<string, any>;
  expect(snapshot.discovery).toMatchObject({
    phase: "selection_override",
    overruledGate: "flow_floor",
    observed: 50_000,
    limit: 100_000,
  });
  // Everything downstream of discovery has not run yet — and must say so.
  expect(snapshot.hardGates.vetting).toEqual({ phase: "not_run_yet" });
  expect(snapshot.range.plan).toEqual({ phase: "not_run_yet" });
});

it("keeps the rule's rejection when the model declines, recording why", async () => {
  installConfig((c) => { c.laya.selection_authority = 2; });
  mocks.requestLaya.mockResolvedValue(approval({ approved: false, approvalProbability: 0.31, reason: "laya_rejected" }));
  const c = candidate("Declined");
  const proposals = await discover(c);
  expect(proposals).toEqual([]);
  expect(mocks.recordDecision).toHaveBeenCalledWith(c.tokenMint, c.pool.address, "skipped",
    "eys_flow_floor", c.score,
    expect.objectContaining({ layaSelectionOverride: expect.objectContaining({ approved: false }) }));
});

it("fails closed when the model is unavailable", async () => {
  installConfig((c) => { c.laya.selection_authority = 2; });
  mocks.requestLaya.mockResolvedValue({
    attempted: true, latencyMs: 9_000, result: { approved: false, reason: "laya_unavailable" }, error: "timeout",
  });
  const c = candidate("ModelDown");
  expect(await discover(c)).toEqual([]);
  expect(featuresFor(c.tokenMint)?.layaSelectionOverride).toMatchObject({ approved: false, layaReason: "laya_unavailable" });
});

it("rejects an approving model whose stage plan() cannot build", async () => {
  installConfig((c) => { c.laya.selection_authority = 2; });
  mocks.requestLaya.mockResolvedValue(approval({ stage: "dump-bonus" }));
  const c = candidate("BadStage");
  expect(await discover(c)).toEqual([]);
  expect(featuresFor(c.tokenMint)?.layaSelectionOverride).toMatchObject({ approved: false });
});

it("never consults the model when flow evidence is missing", async () => {
  installConfig((c) => { c.laya.selection_authority = 5; });
  const c = candidate("NoFlowData");
  const proposals = await eysPlugin.discover({
    candidates: [c], gmgnByMint: new Map([[c.tokenMint, presence(c.tokenMint, 999_999)]]),
  }).then(() => eysPlugin.discover({ candidates: [c], gmgnByMint: new Map() }));
  expect(proposals).toEqual([]);
  expect(mocks.requestLaya).not.toHaveBeenCalled();
  expect(featuresFor(c.tokenMint)?.layaSelectionOverride).toBeUndefined();
});

it("stops at the per-run budget: first reject consults, second does not", async () => {
  installConfig((c) => { c.laya.selection_authority = 1; });
  // Declining model so BOTH candidates are rejected and the budget — not the
  // approval outcome — is the only difference between them.
  mocks.requestLaya.mockResolvedValue(approval({ approved: false, approvalProbability: 0.31, reason: "laya_rejected" }));
  const first = candidate("BudgetA");
  const second = candidate("BudgetB");
  const proposals = await eysPlugin.discover({
    candidates: [first, second],
    gmgnByMint: new Map([[first.tokenMint, presence(first.tokenMint)], [second.tokenMint, presence(second.tokenMint)]]),
  });
  expect(proposals).toEqual([]);
  expect(mocks.requestLaya).toHaveBeenCalledTimes(1);
  expect(featuresFor(first.tokenMint)?.layaSelectionOverride).toMatchObject({ approved: false });
  // Budget gone: never reached the model, so no consult outcome was recorded.
  expect(featuresFor(second.tokenMint)?.layaSelectionOverride).toBeUndefined();
});

it("consults the same mint:pool at most once per 5 minutes", async () => {
  installConfig((c) => { c.laya.selection_authority = 9; });
  const c = candidate("Deduped");
  await discover(c);
  await discover(c);
  expect(mocks.requestLaya).toHaveBeenCalledTimes(1);
});
