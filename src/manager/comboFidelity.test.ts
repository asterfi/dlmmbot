/**
 * Strategy-fidelity round (owner, 2026-10-03; molu's "Be the House" Book 1):
 *  1. P0 price-crash (-60%) must not stop-loss a combo position (other P0 triggers still do)
 *  2. molu ladder: ~110 bins below price, real position-account count priced
 *  3. molu pool choice for young tokens: 5-10% fee pool with volume, else highest 30m volume
 *  4. never-filled ladders the market left behind close after 30 min (combo_left_behind)
 *  + within-candidate play resolution follows config play_priority; qualifying_plays recorded
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../scanner/scan.js", () => ({ scan: vi.fn() }));
vi.mock("../scanner/meteora.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scanner/meteora.js")>();
  return { ...actual, fetchPool: vi.fn(async () => null) };
});
vi.mock("../scanner/candles.js", () => ({ fetchCandlesDeep: vi.fn(async () => []) }));
vi.mock("../scanner/gmgn.js", () => ({
  trendingByMint: vi.fn(async () => new Map()),
  gmgnPerMinuteVolumeUsd: vi.fn(() => null),
}));
vi.mock("../scanner/stonkfun.js", () => ({ fetchStonkTokens: vi.fn(async () => []) }));
vi.mock("../scanner/priceGate.js", () => ({ priceDivergenceGate: vi.fn(async () => null) }));
vi.mock("../market.js", () => ({
  sol24hChangePct: vi.fn(async () => 0),
  solUsdPrice: vi.fn(async () => 200),
}));
vi.mock("../vetting/vet.js", () => ({ vetToken: vi.fn() }));
vi.mock("../vetting/rugcheck.js", () => ({ fetchSummary: vi.fn(async () => null) }));
vi.mock("../ranges/binRent.js", () => ({
  applyBinRentGate: vi.fn(async (a: { range: unknown }) => ({
    ok: true,
    range: a.range,
    meta: { est: 0, actual: 0, tier: "normal", budget: 0, shrunk: false },
  })),
}));

import { scan } from "../scanner/scan.js";
import { fetchPool, type Candle } from "../scanner/meteora.js";
import { fetchCandlesDeep } from "../scanner/candles.js";
import { vetToken } from "../vetting/vet.js";
import { enterNewPositions, managePositions, resetManagerStateForTests } from "./loop.js";
import { FakeExecutor } from "../test/fakeExecutor.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb, insertOpenPosition } from "../test/db.js";
import { getDb, isBlacklisted, now } from "../db/db.js";
import { makePool } from "../test/pool.js";
import type { Candidate } from "../types.js";

const T0 = new Date("2026-10-03T06:00:00Z");

// ---------------------------------------------------------------- P0 crash
describe("P0 price-crash does not stop-loss combo positions (owner's NO stop-loss rule)", () => {
  let exec: FakeExecutor;
  // entry price in insertOpenPosition defaults to 1 -> price 0.3 is -70% (threshold -60%)
  const crashMark = { valueSol: 0.03, price: 0.3, activeBinId: 150, aboveRange: false, inRange: true, belowRange: false, vol30mUsd: 999_999, tvlUsd: 100_000 };

  beforeEach(() => {
    useMemoryDb();
    resetManagerStateForTests();
    installConfig((c) => { c.combo!.enabled = true; });
    exec = new FakeExecutor("paper");
  });
  afterEach(() => { resetTestDb(); restoreConfig(); vi.clearAllMocks(); });

  it("a combo position at -70% is NOT closed by the crash trigger, and the skip is logged once", async () => {
    const id = insertOpenPosition({ entrySol: 0.1 });
    getDb().prepare("UPDATE positions SET play='danko_trap', ever_filled=1 WHERE id=?").run(id);
    exec.setMark(id, crashMark);
    await managePositions(exec);
    await managePositions(exec);
    expect(exec.closed).toHaveLength(0);
    const rows = getDb().prepare("SELECT COUNT(*) AS c FROM decisions WHERE failed_gate='p0_crash_skipped_combo'").get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it("the same combo position is still closed by a TVL drain (other P0 triggers untouched)", async () => {
    const id = insertOpenPosition({ entrySol: 0.1 });
    getDb().prepare("UPDATE positions SET play='danko_trap', ever_filled=1 WHERE id=?").run(id);
    // pool death (valueSol === 0) is one of the P0 triggers that must still fire.
    exec.setMark(id, { ...crashMark, valueSol: 0 });
    await managePositions(exec);
    expect(exec.closed).toEqual([{ id, reason: "P0_safety" }]);
  });

  it("a NON-combo position at -70% is still crash-closed", async () => {
    const id = insertOpenPosition({ entrySol: 0.1 });
    exec.setMark(id, crashMark);
    await managePositions(exec);
    expect(exec.closed).toEqual([{ id, reason: "P0_safety" }]);
  });
});

// ------------------------------------------------------------- left behind
describe("combo_left_behind: never-filled ladder the market left behind", () => {
  let exec: FakeExecutor;
  const baseMark = { valueSol: 0.1, activeBinId: 300, aboveRange: true, inRange: false, belowRange: false, vol30mUsd: 999_999, tvlUsd: 100_000 };

  beforeEach(() => {
    useMemoryDb();
    resetManagerStateForTests();
    installConfig((c) => {
      c.combo!.enabled = true;
      c.combo!.left_behind_pct = 20;
      c.combo!.left_behind_min = 30;
      c.combo!.molu_idle_max_h = 2;
      c.combo!.danko_idle_max_h = 6;
    });
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    exec = new FakeExecutor("paper");
  });
  afterEach(() => { vi.useRealTimers(); resetTestDb(); restoreConfig(); vi.clearAllMocks(); });

  function open(play: string, everFilled = 0) {
    // young position (well under the idle timeouts), entry price 1
    const id = insertOpenPosition({ entrySol: 0.1, entryTs: Math.floor(T0.getTime() / 1000) - 60 });
    getDb().prepare("UPDATE positions SET play=?, ever_filled=? WHERE id=?").run(play, everFilled, id);
    return id;
  }

  it("price 49% above the top bin for 30 minutes closes a molu ladder as combo_left_behind (pos#8's case)", async () => {
    const id = open("molu_ladder");
    exec.setMark(id, { ...baseMark, price: 1.49 });
    await managePositions(exec);
    vi.setSystemTime(new Date(T0.getTime() + 29 * 60_000));
    await managePositions(exec);
    expect(exec.closed).toHaveLength(0);
    vi.setSystemTime(new Date(T0.getTime() + 30 * 60_000 + 1000));
    await managePositions(exec);
    expect(exec.closed).toEqual([{ id, reason: "combo_left_behind" }]);
    expect(isBlacklisted("mint1")).not.toBeNull();
  });

  it("applies to danko_trap too", async () => {
    const id = open("danko_trap");
    exec.setMark(id, { ...baseMark, price: 1.3 });
    await managePositions(exec);
    vi.setSystemTime(new Date(T0.getTime() + 31 * 60_000));
    await managePositions(exec);
    expect(exec.closed).toEqual([{ id, reason: "combo_left_behind" }]);
  });

  it("does NOT fire when price is only 19% above the top (hovering — idle timeouts cover it)", async () => {
    const id = open("molu_ladder");
    exec.setMark(id, { ...baseMark, price: 1.19 });
    await managePositions(exec);
    vi.setSystemTime(new Date(T0.getTime() + 45 * 60_000));
    await managePositions(exec);
    expect(exec.closed).toHaveLength(0);
  });

  it("does NOT fire for a ladder that has filled", async () => {
    const id = open("molu_ladder", 1);
    exec.setMark(id, { ...baseMark, price: 1.6 });
    await managePositions(exec);
    vi.setSystemTime(new Date(T0.getTime() + 45 * 60_000));
    await managePositions(exec);
    expect(exec.closed.find((c) => c.reason === "combo_left_behind")).toBeUndefined();
  });

  it("a dip back under the threshold resets the 30-minute timer", async () => {
    const id = open("molu_ladder");
    exec.setMark(id, { ...baseMark, price: 1.5 });
    await managePositions(exec);
    vi.setSystemTime(new Date(T0.getTime() + 20 * 60_000));
    exec.setMark(id, { ...baseMark, price: 1.1 });
    await managePositions(exec);
    vi.setSystemTime(new Date(T0.getTime() + 25 * 60_000));
    exec.setMark(id, { ...baseMark, price: 1.5 });
    await managePositions(exec);
    vi.setSystemTime(new Date(T0.getTime() + 50 * 60_000)); // only 25 min since re-arming
    await managePositions(exec);
    expect(exec.closed).toHaveLength(0);
  });
});

// --------------------------------------------- entry: molu range + pool + priority
const candle = (high: number, low: number): Candle => ({ timestamp: 0, open: high, high, low, close: low, volume: 1 });
const MOLU_CANDLES = [
  candle(1, 0.9), candle(0.95, 0.8), candle(0.9, 0.75), candle(0.85, 0.7),
  candle(0.8, 0.72), candle(0.78, 0.73),
]; // swing high 1, low 0.7 -> dip 30%; at price 0.77 bounce 10%

const POOL_A = "PoolAAAA1111111111111111111111111111111111";
const POOL_B = "PoolBBBB1111111111111111111111111111111111";
const POOL_C = "PoolCCCC1111111111111111111111111111111111";

function moluPool(address: string, over: Record<string, unknown> = {}) {
  return makePool({
    address, marketCapUsd: 1_500_000, price: 0.77, binStep: 100, tvlUsd: 100_000,
    vol30mUsd: 80_000, baseFeePct: 1, ...over,
  } as never);
}

function candidateFor(pool: ReturnType<typeof moluPool>, siblings?: ReturnType<typeof moluPool>[]): Candidate {
  return { pool, tokenMint: pool.mintX, symbol: "MOLU", score: 90, scoreParts: {}, gateFailures: [], siblings };
}

describe("molu entry: ~110-bin ladder and pool choice", () => {
  let exec: FakeExecutor;

  beforeEach(() => {
    useMemoryDb();
    resetManagerStateForTests();
    installConfig((c) => {
      c.sizing.kelly_enabled = false;
      c.sizing.max_positions = 5;
      c.entry.tranche_enabled = false;
      c.entry.max_quote_drift_bins = 0;
      c.follow.enabled = false;
      c.majors.enabled = false;
      c.gates.min_entry_score = 60;
      c.combo!.enabled = true;
      c.combo!.canary_mode = true;
      c.combo!.canary_position_sol = 0.5;
      c.combo!.molu_bins_target = 110;
      c.combo!.molu_bins_min = 100;
      c.combo!.molu_bins_max = 125;
      c.combo!.molu_fee_pool_min_vol30m_usd = 10_000;
    });
    exec = new FakeExecutor("paper");
    vi.mocked(fetchCandlesDeep).mockResolvedValue(MOLU_CANDLES);
    vi.mocked(vetToken).mockResolvedValue({
      verdict: "pass", softScore: 50, hardFailures: [],
      facts: { tokenAgeMinutes: 600 }, // 10h: young (< 48h), not Eys-young
    } as never);
  });
  afterEach(() => { resetTestDb(); restoreConfig(); vi.clearAllMocks(); });

  it("builds a 110-bin ladder across 2 position accounts, top bin = active bin", async () => {
    const a = moluPool(POOL_A);
    vi.mocked(scan).mockResolvedValue({ candidates: [candidateFor(a)], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(1);
    const o = exec.opens[0]!;
    expect(o.play).toBe("molu_ladder");
    expect(o.range.binCount).toBe(110);
    expect(o.range.positionAccounts).toBe(2);
    expect(o.range.maxBinId - o.range.minBinId + 1).toBe(110);
  });

  it("picks the 5-10% base-fee sibling when it has >= $10k 30m volume", async () => {
    const a = moluPool(POOL_A, { baseFeePct: 1, vol30mUsd: 200_000 });
    const b = moluPool(POOL_B, { baseFeePct: 5, vol30mUsd: 15_000 });
    vi.mocked(fetchPool).mockImplementation((async (addr: string) => (addr === POOL_B ? b : null)) as never);
    vi.mocked(scan).mockResolvedValue({ candidates: [candidateFor(a, [a, b])], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(1);
    expect(exec.opens[0]!.poolAddress).toBe(POOL_B);
    const row = getDb().prepare("SELECT features_json FROM decisions WHERE failed_gate='molu_pool_choice'").get() as { features_json?: string } | undefined;
    expect(row).toBeDefined();
    expect(String(row!.features_json)).toContain("fee_tier_5_10");
  });

  it("falls back to the highest-30m-volume pool when the fee-tier pool is too quiet", async () => {
    const a = moluPool(POOL_A, { baseFeePct: 1, vol30mUsd: 50_000, tvlUsd: 500_000 });
    const b = moluPool(POOL_B, { baseFeePct: 5, vol30mUsd: 9_999 });
    const c = moluPool(POOL_C, { baseFeePct: 2, vol30mUsd: 120_000, tvlUsd: 60_000 });
    vi.mocked(fetchPool).mockImplementation((async (addr: string) => (addr === POOL_C ? c : null)) as never);
    vi.mocked(scan).mockResolvedValue({ candidates: [candidateFor(a, [a, b, c])], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens[0]!.poolAddress).toBe(POOL_C);
  });

  it("keeps the scanner's pool for a token OLDER than 48h", async () => {
    vi.mocked(vetToken).mockResolvedValue({ verdict: "pass", softScore: 50, hardFailures: [], facts: { tokenAgeMinutes: 60 * 60 } } as never);
    const a = moluPool(POOL_A, { vol30mUsd: 50_000 });
    const b = moluPool(POOL_B, { baseFeePct: 5, vol30mUsd: 90_000 });
    vi.mocked(fetchPool).mockImplementation((async (addr: string) => (addr === POOL_B ? b : null)) as never);
    vi.mocked(scan).mockResolvedValue({ candidates: [candidateFor(a, [a, b])], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    // 60h-old token cannot be molu (>= molu_age_max_h) — and nothing swapped pools.
    for (const o of exec.opens) expect(o.poolAddress).toBe(POOL_A);
  });
});

describe("within-candidate play resolution follows play_priority", () => {
  let exec: FakeExecutor;

  beforeEach(() => {
    useMemoryDb();
    resetManagerStateForTests();
    installConfig((c) => {
      c.sizing.kelly_enabled = false;
      c.sizing.max_positions = 5;
      c.entry.tranche_enabled = false;
      c.entry.max_quote_drift_bins = 0;
      c.follow.enabled = false;
      c.majors.enabled = false;
      c.gates.min_entry_score = 60;
      c.combo!.enabled = true;
      c.combo!.canary_mode = true;
      c.combo!.canary_position_sol = 0.5;
      c.combo!.play_priority = ["eys_seat", "eys_ape", "molu_ladder", "danko_trap"];
    });
    exec = new FakeExecutor("paper");
    vi.mocked(fetchCandlesDeep).mockResolvedValue(MOLU_CANDLES);
    vi.mocked(vetToken).mockResolvedValue({ verdict: "pass", softScore: 50, hardFailures: [], facts: { tokenAgeMinutes: 600 } } as never);
  });
  afterEach(() => { resetTestDb(); restoreConfig(); vi.clearAllMocks(); });

  it("a candidate fitting BOTH molu_ladder and eys_seat is entered as eys_seat; qualifying_plays lists both", async () => {
    // molu shape (mcap>=1M, young, dip+bounce) AND eys fees/flow (big tvl x fee/tvl, vol30m>=3M)
    const p = moluPool(POOL_A, { tvlUsd: 400_000, feeTvl24hPct: 60, vol30mUsd: 4_000_000 });
    // eys flow reads the freshest 5m candle: make the last one a $700k/5m (=$140k/min) spike
    vi.mocked(fetchCandlesDeep).mockResolvedValue(MOLU_CANDLES.map((c, i) => (i === MOLU_CANDLES.length - 1 ? { ...c, volume: 700_000 } : c)));
    vi.mocked(scan).mockResolvedValue({ candidates: [candidateFor(p)], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(1);
    expect(exec.opens[0]!.play).toBe("eys_seat");
    const row = getDb().prepare("SELECT features_json FROM decisions WHERE action='entered'").get() as { features_json: string };
    const feats = JSON.parse(row.features_json) as { qualifyingPlays: string[]; play: string };
    expect(feats.play).toBe("eys_seat");
    expect(feats.qualifyingPlays).toEqual(expect.arrayContaining(["molu_ladder", "eys_seat"]));
  });

  it("a candidate fitting molu_ladder but NOT eys is entered as molu_ladder", async () => {
    const p = moluPool(POOL_A); // vol30m 80k -> no eys flow
    vi.mocked(scan).mockResolvedValue({ candidates: [candidateFor(p)], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens[0]!.play).toBe("molu_ladder");
  });
});
