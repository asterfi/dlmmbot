/**
 * Combo exclusivity (owner's blocker fix, 2026-10-01): while [combo].enabled,
 * the plays' own sizing must be the ONLY way a new position opens — no
 * fallthrough to upstream's normal Kelly entry, and no other entry lane
 * (follow re-entry, majors, tranches) may open one either.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../scanner/scan.js", () => ({ scan: vi.fn(async () => ({ candidates: [], rejected: [], sweptPools: 0 })) }));
vi.mock("../scanner/meteora.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scanner/meteora.js")>();
  return { ...actual, fetchPool: vi.fn(async () => null) };
});
vi.mock("../scanner/candles.js", () => ({ fetchCandlesDeep: vi.fn(async () => []) }));
vi.mock("../scanner/gmgn.js", () => ({ trendingByMint: vi.fn(async () => new Map()), gmgnPerMinuteVolumeUsd: vi.fn(() => null) }));
vi.mock("../scanner/stonkfun.js", () => ({ fetchStonkTokens: vi.fn(async () => []) }));
vi.mock("../market.js", () => ({
  sol24hChangePct: vi.fn(async () => 0),
  solUsdPrice: vi.fn(async () => 200),
}));
vi.mock("../vetting/vet.js", () => ({
  vetToken: vi.fn(async () => ({ verdict: "pass", softScore: 50, hardFailures: [], soft: {}, facts: { tokenAgeMinutes: 5000 } })),
}));
vi.mock("../ranges/binRent.js", () => ({
  applyBinRentGate: vi.fn(async (a: { range: unknown }) => ({
    ok: true,
    range: a.range,
    meta: { est: 0, actual: 0, tier: "normal", budget: 0, shrunk: false },
  })),
}));

import { scan } from "../scanner/scan.js";
import { enterNewPositions, managePositions } from "./loop.js";
import { FakeExecutor } from "../test/fakeExecutor.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb, insertOpenPosition } from "../test/db.js";
import { getDb } from "../db/db.js";
import { makePool } from "../test/pool.js";
import type { Candidate } from "../types.js";
import { resetFollowStateForTests, hasActiveFollowChain } from "./follow.js";

// Clears none of upstream's own gates (mcap 250k, vol30m 80k are the test
// pool's defaults, same as entryScore.test.ts) but fits NONE of the four
// combo plays: mcap is below molu_ladder/danko_trap's $1M floor, and
// eys_seat's flow floor (vol30mUsd/30 >= $100k/min => vol30mUsd >= $3M) is
// nowhere close at the default 80k. eys_ape never matches (stonkfun mocked
// to an empty list).
function unclassifiableCandidate(): Candidate {
  const pool = makePool({ address: "ComboPool1111111111111111111111111111111" });
  return { pool, tokenMint: pool.mintX, symbol: "NOFIT", score: 90, scoreParts: {}, gateFailures: [] };
}

const skipped = () =>
  (getDb().prepare("SELECT failed_gate FROM decisions WHERE action='skipped'").all() as Array<{ failed_gate: string }>);

describe("combo exclusivity — entry pipeline", () => {
  let exec: FakeExecutor;

  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.sizing.kelly_enabled = false;
      c.sizing.max_positions = 5;
      c.entry.tranche_enabled = false;
      c.entry.max_quote_drift_bins = 0;
      c.follow.enabled = true; // still true in config — the CODE guard must be what stops it
      c.majors.enabled = false;
      c.gates.min_entry_score = 60;
      c.combo!.enabled = true;
    });
    exec = new FakeExecutor("paper");
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.clearAllMocks();
  });

  it("an unclassified candidate opens nothing and logs combo_no_play — no fallthrough to Kelly sizing", async () => {
    vi.mocked(scan).mockResolvedValue({ candidates: [unclassifiableCandidate()], rejected: [], sweptPools: 1 });

    await enterNewPositions(exec);

    expect(exec.opens).toHaveLength(0);
    expect(skipped().map((d) => d.failed_gate)).toContain("combo_no_play");
  });
});

describe("combo sizing seed — upstream cold-start size never pre-empts combo", () => {
  let exec: FakeExecutor;

  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      // Kelly cold start that sizes far under the floor — the live 2026-10-01
      // failure: 3% of a 0.34 SOL wallet = 0.01 SOL < 0.05 floor -> size_zero.
      c.sizing.kelly_enabled = true;
      c.sizing.kelly_cold_start_frac = 0.0001;
      c.sizing.max_positions = 5;
      c.entry.tranche_enabled = false;
      c.entry.max_quote_drift_bins = 0;
      c.majors.enabled = false;
      c.gates.min_entry_score = 60;
      c.combo!.enabled = true;
      c.combo!.canary_mode = true;
    });
    exec = new FakeExecutor("paper");
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.clearAllMocks();
  });

  it("upstream's per-token wallet-% cap does not pre-empt a combo candidate", async () => {
    installConfig((c) => {
      c.sizing.kelly_enabled = false;
      c.sizing.per_token_max_pct = 0.001; // would block any non-zero size
      c.sizing.max_positions = 5;
      c.entry.tranche_enabled = false;
      c.entry.max_quote_drift_bins = 0;
      c.majors.enabled = false;
      c.gates.min_entry_score = 60;
      c.combo!.enabled = true;
      c.combo!.canary_mode = true;
    });
    vi.mocked(scan).mockResolvedValue({ candidates: [unclassifiableCandidate()], rejected: [], sweptPools: 1 });

    await enterNewPositions(exec);

    const gates = skipped().map((d) => d.failed_gate);
    expect(gates).not.toContain("per_token_cap");
    expect(gates).toContain("combo_no_play");
  });

  it("a gate-passing candidate reaches combo classification instead of dying as size_zero", async () => {
    vi.mocked(scan).mockResolvedValue({ candidates: [unclassifiableCandidate()], rejected: [], sweptPools: 1 });

    await enterNewPositions(exec);

    const gates = skipped().map((d) => d.failed_gate);
    expect(gates).not.toContain("size_zero");
    expect(gates).toContain("combo_no_play");
  });
});

describe("combo exclusivity — follow chain never arms", () => {
  let exec: FakeExecutor;

  beforeEach(() => {
    useMemoryDb();
    resetFollowStateForTests();
    installConfig((c) => {
      c.follow.enabled = true;
      c.follow.min_vol_30m_usd = 1; // trivially clears — isolate the combo guard, not the volume floor
      c.combo!.enabled = true;
    });
    exec = new FakeExecutor("paper");
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.clearAllMocks();
  });

  it("a P3 close that would normally arm a follow chain does not, while combo is enabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T12:00:00Z"));
    const id = insertOpenPosition({ entrySol: 0.3, everInRange: 1, minBinId: 100, maxBinId: 200 });
    const mark = {
      valueSol: 0.4,
      price: 1.2,
      activeBinId: 220,
      aboveRange: true,
      inRange: false,
      belowRange: false,
      vol30mUsd: 999_999,
    };
    exec.setMark(id, mark);
    await managePositions(exec); // arms the above_range_since timer
    expect(exec.closed).toHaveLength(0);

    // Clear the win sustain window (10 min default) and close.
    vi.setSystemTime(new Date("2026-08-13T12:12:00Z"));
    await managePositions(exec);
    expect(exec.closed).toEqual([{ id, reason: "P3_above" }]);

    // The P3 close is real; the chain it would otherwise arm must not exist.
    expect(hasActiveFollowChain("mint1", "paper")).toBe(false);
    expect((getDb().prepare("SELECT COUNT(*) AS c FROM follow_chains").get() as { c: number }).c).toBe(0);
    vi.useRealTimers();
  });
});
