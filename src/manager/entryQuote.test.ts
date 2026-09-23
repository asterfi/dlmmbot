import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The entry pipeline reaches out to five services before it plans a range.
// None of them is what these tests are about — the guard between the scan's
// quote and the open is.
vi.mock("../scanner/scan.js", () => ({ scan: vi.fn(async () => ({ candidates: [], rejected: [], sweptPools: 0 })) }));
vi.mock("../scanner/meteora.js", () => ({ fetchPool: vi.fn(async () => null) }));
vi.mock("../scanner/candles.js", () => ({ fetchCandlesDeep: vi.fn(async () => []) }));
vi.mock("../scanner/gmgn.js", () => ({ trendingByMint: vi.fn(async () => new Map()) }));
vi.mock("../market.js", () => ({
  sol24hChangePct: vi.fn(async () => 0),
  solUsdPrice: vi.fn(async () => 200),
}));
vi.mock("../vetting/vet.js", () => {
  const vetToken = vi.fn(async (_mint: string, _poolCreatedAtMs: number | null) => ({ verdict: "pass", softScore: 80, hardFailures: [], soft: {} }));
  return {
    vetToken,
    vetWithRetry: (mint: string, poolCreatedAtMs: number | null) => vetToken(mint, poolCreatedAtMs),
  };
});
// Bin-array rent is an on-chain read; let the planned range through untouched.
vi.mock("../ranges/binRent.js", () => ({
  applyBinRentGate: vi.fn(async (a: { range: unknown }) => ({
    ok: true,
    range: a.range,
    meta: { est: 0, actual: 0, tier: "normal", budget: 0, shrunk: false },
  })),
}));

import { scan } from "../scanner/scan.js";
import { fetchPool } from "../scanner/meteora.js";
import { enterNewPositions, DEFAULT_MAX_QUOTE_DRIFT_BINS } from "./loop.js";
import { FakeExecutor } from "../test/fakeExecutor.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb } from "../test/db.js";
import { getDb } from "../db/db.js";
import { makePool } from "../test/pool.js";
import type { Candidate } from "../types.js";

/**
 * CatGPT, 2026-08-21. One pool at 100 bps (1% per bin): the scan quoted
 * 3.6176e-6 and by the time the bot opened, the pool was at 3.7645e-6 — four
 * bins up. The range top is planted at the quote, and every upside exit is
 * measured from the range top, so those four bins put P3's sustain and the
 * escape hatch's recovery band out of reach and left only the stop.
 */
const QUOTED = 3.6176e-6;
const DRIFTED = 3.7645e-6;   // +4.0 bins
const NUDGED = 3.6538e-6;    // +1.0 bin
// +11.0 bins: past the shipped tolerance, so "skips rather than chasing"
// keeps firing once the limit is widened beyond the original 3.
const RAN = 4.0361e-6;

/** A quote `bins` away from QUOTED, on the same 100-bp step. */
const atBins = (bins: number) => QUOTED * Math.pow(1.01, bins);

function candidate(price = QUOTED): Candidate {
  const pool = makePool({ address: "CatPool11111111111111111111111111111111", binStep: 100, price });
  return { pool, tokenMint: pool.mintX, symbol: "CatGPT", score: 80, scoreParts: {}, gateFailures: [] };
}

const skips = () =>
  (getDb().prepare("SELECT failed_gate, features_json FROM decisions WHERE action='skipped'").all() as
    Array<{ failed_gate: string; features_json: string }>);

describe("stale quote guard", () => {
  let exec: FakeExecutor;

  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.sizing.kelly_enabled = false;
      c.sizing.max_positions = 5;
      c.entry.tranche_enabled = false;
      c.follow.enabled = false;
      c.majors.enabled = false;
    });
    exec = new FakeExecutor("paper");
    vi.mocked(scan).mockResolvedValue({ candidates: [candidate()], rejected: [], sweptPools: 1 });
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.clearAllMocks();
  });

  it("skips rather than chasing when the pool has run since the scan", async () => {
    vi.mocked(fetchPool).mockResolvedValue({ ...candidate(RAN).pool, extras: {} } as never);

    await enterNewPositions(exec);

    expect(exec.opens).toHaveLength(0);
    const stale = skips().filter((s) => s.failed_gate === "quote_stale");
    expect(stale).toHaveLength(1);
    const f = JSON.parse(stale[0]!.features_json);
    expect(f.driftBins).toBeCloseTo(11.0, 1);
    expect(f.quotedPrice).toBe(QUOTED);
    expect(f.freshPrice).toBe(RAN);
  });

  /**
   * The pre-open re-quote must be measured from the price the range was
   * actually PLANNED at (entryPrice), not from the scan price.
   *
   * Without that, the two checks bookend each other and the total
   * misplacement they allow is 2x the limit: guard 1 accepts a quote 9 bins
   * below the scan and plans the range there, the pre-open check then
   * accepts a quote 10 bins above the scan — inside the limit — while the
   * position is actually being opened 19 bins away from where the range was
   * planted. That is the CatGPT failure mode the guard exists to prevent.
   */
  it("measures pre-open drift from the PLANNED price, not the scan price", async () => {
    const c = candidate();
    vi.mocked(scan).mockResolvedValue({ candidates: [c], rejected: [], sweptPools: 1 });
    // Pinned independently of the shipped tolerance so this test isolates the
    // BASELINE bug: what matters is which price each check is measured from.
    installConfig((ic) => {
      ic.entry.max_quote_drift_bins = 10;
      ic.entry.max_pre_open_drift_bins = 10;
    });

    let calls = 0;
    vi.mocked(fetchPool).mockImplementation(async () => {
      calls++;
      // guard 1: 9 bins BELOW the scan — inside the 10-bin limit, so the
      // range gets planned at entryPrice = atBins(-9).
      if (calls === 1) return { ...c.pool, price: atBins(-9), extras: {} } as never;
      // pre-open: 10 bins ABOVE the scan, i.e. 19 bins from entryPrice.
      return { ...c.pool, price: atBins(10), extras: {} } as never;
    });
    const open = vi.spyOn(exec, "open");

    await enterNewPositions(exec);

    const stale = skips().filter((s) => s.failed_gate === "quote_stale");
    expect(calls).toBe(2);
    expect(open).not.toHaveBeenCalled();
    expect(stale).toHaveLength(1);
    const f = JSON.parse(stale[0]!.features_json);
    expect(f.stage).toBe("pre_open");
    // 19 bins from the planned price, not 10 from the scan price.
    expect(Math.abs(f.driftBins)).toBeCloseTo(19.0, 0);
  });

  it("plans off the fresh quote, not the scan's, when the drift is tolerable", async () => {
    vi.mocked(fetchPool).mockResolvedValue({ ...candidate(NUDGED).pool, extras: {} } as never);

    await enterNewPositions(exec);

    expect(skips().map((s) => s.failed_gate)).not.toContain("quote_stale");
    expect(exec.opens).toHaveLength(1);
    expect(exec.opens[0]!.entryPrice).toBe(NUDGED); // the fresh price, not QUOTED
  });

  /**
   * The two checks are deliberately NOT the same tolerance.
   *
   * guard 1 can afford to be loose (10 bins = the observed median drift over
   * the ~60s scan pipeline) because it RE-PLANS the range off the fresh quote.
   * The pre-open check cannot: the range is already planted at entryPrice, so
   * anything it lets through is pure misplacement. That one stays at 3.
   */
  it("widens guard 1 for re-planning but keeps pre-open tight", async () => {
    const c = candidate();
    vi.mocked(scan).mockResolvedValue({ candidates: [c], rejected: [], sweptPools: 1 });
    installConfig((ic) => {
      ic.entry.max_quote_drift_bins = 10;   // loose: will be re-planned anyway
      ic.entry.max_pre_open_drift_bins = 3; // tight: range already planted
    });

    let calls = 0;
    vi.mocked(fetchPool).mockImplementation(async () => {
      calls++;
      // guard 1: 9 bins up — inside the loose limit, so planning proceeds at
      // entryPrice = atBins(9).
      if (calls === 1) return { ...c.pool, price: atBins(9), extras: {} } as never;
      // pre-open: 4 bins beyond the PLANTED price — over the 3-bin limit.
      return { ...c.pool, price: atBins(13), extras: {} } as never;
    });
    const open = vi.spyOn(exec, "open");

    await enterNewPositions(exec);

    expect(open).not.toHaveBeenCalled();
    const stale = skips().filter((s) => s.failed_gate === "quote_stale");
    expect(stale).toHaveLength(1);
    const f = JSON.parse(stale[0]!.features_json);
    expect(f.stage).toBe("pre_open");
    expect(f.driftLimit).toBe(3);          // pre-open's own limit, not guard 1's
    expect(Math.abs(f.driftBins)).toBeCloseTo(4.0, 1);
  });

  it("opens when pre-open drift stays inside its own (tighter) limit", async () => {
    const c = candidate();
    vi.mocked(scan).mockResolvedValue({ candidates: [c], rejected: [], sweptPools: 1 });
    installConfig((ic) => {
      ic.entry.max_quote_drift_bins = 10;
      ic.entry.max_pre_open_drift_bins = 3;
    });

    let calls = 0;
    vi.mocked(fetchPool).mockImplementation(async () => {
      calls++;
      if (calls === 1) return { ...c.pool, price: atBins(9), extras: {} } as never;
      // 2 bins past the planted price: inside 3, so the open goes out.
      return { ...c.pool, price: atBins(11), extras: {} } as never;
    });
    const open = vi.spyOn(exec, "open");

    await enterNewPositions(exec);

    expect(calls).toBe(2);
    expect(open).toHaveBeenCalledTimes(1);
    expect(skips().map((s) => s.failed_gate)).not.toContain("quote_stale");
    // Range was planted at guard 1's fresh quote, not the scan quote.
    expect(open.mock.calls[0]![0].entryPrice).toBeCloseTo(QUOTED * Math.pow(1.01, 9), 18);
  });

  it("falls through on the scan quote when the re-quote fails", async () => {
    // A datapi hiccup must not cost every entry — the old behaviour is the
    // fallback, not a skip.
    vi.mocked(fetchPool).mockRejectedValue(new Error("HTTP 503"));

    await enterNewPositions(exec);

    expect(skips().map((s) => s.failed_gate)).not.toContain("quote_stale");
    expect(exec.opens).toHaveLength(1);
    expect(exec.opens[0]!.entryPrice).toBe(QUOTED);
  });

  it("honours the configured tolerance, and 0 disables the guard", async () => {
    vi.mocked(fetchPool).mockResolvedValue({ ...candidate(DRIFTED).pool, extras: {} } as never);
    installConfig((c) => { c.entry.max_quote_drift_bins = 5; }); // 4 bins now inside
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(1);
    expect(exec.opens[0]!.entryPrice).toBe(DRIFTED);

    resetTestDb();
    useMemoryDb();
    exec = new FakeExecutor("paper");
    installConfig((c) => { c.entry.max_quote_drift_bins = 0; }); // guard off entirely
    vi.mocked(fetchPool).mockClear(); // count only this run
    await enterNewPositions(exec);
    expect(vi.mocked(fetchPool)).toHaveBeenCalledTimes(0); // not re-quoted at all
    expect(exec.opens[0]!.entryPrice).toBe(QUOTED);
  });

  it("defaults to a 3-bin tolerance when the config predates the key", () => {
    expect(DEFAULT_MAX_QUOTE_DRIFT_BINS).toBe(3);
  });
});
