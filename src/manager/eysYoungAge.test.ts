/**
 * Eys-only young-age carve-out (owner, 2026-10-02): live GMGN 5m trending
 * showed hot tokens 6-36min old that upstream's 45min age_min floor rejected
 * before combo classification ever ran. A candidate aged in
 * [eys_age_min_minutes, age_min_minutes) is let through vetToken's age_min
 * gate (facts.ageEysOnly=true) ONLY to be considered for eys_seat/eys_ape —
 * the hard-fail floor below eys_age_min_minutes is unchanged. Every play is an Eys play now
 * (the molu/danko 45-minute floor exception no longer exists).
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
  gmgnOneMinutePeakUsd: vi.fn(async () => null),
}));
vi.mock("../strategy/combo/feeMode.js", () => ({ readOnchainCollectFeeMode: vi.fn(async () => 1) }));
vi.mock("../scanner/stonkfun.js", () => ({ fetchStonkTokens: vi.fn(async () => []) }));
vi.mock("../market.js", () => ({
  sol24hChangePct: vi.fn(async () => 0),
  solUsdPrice: vi.fn(async () => 200),
}));
vi.mock("../vetting/vet.js", () => ({ vetToken: vi.fn() }));
vi.mock("../ranges/binRent.js", () => ({
  applyBinRentGate: vi.fn(async (a: { range: unknown }) => ({
    ok: true,
    range: a.range,
    meta: { est: 0, actual: 0, tier: "normal", budget: 0, shrunk: false },
  })),
}));

import { scan } from "../scanner/scan.js";
import { fetchCandlesDeep } from "../scanner/candles.js";
import { vetToken } from "../vetting/vet.js";
import { enterNewPositions } from "./loop.js";
import { FakeExecutor } from "../test/fakeExecutor.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb } from "../test/db.js";
import { getDb } from "../db/db.js";
import { makePool } from "../test/pool.js";
import type { Candidate } from "../types.js";
import type { Candle } from "../scanner/meteora.js";

const candle = (high: number, low: number): Candle => ({ timestamp: 0, open: high, high, low, close: low, volume: 1 });
const MOLU_CANDLES = [
  candle(1, 0.9), candle(0.95, 0.8), candle(0.9, 0.75), candle(0.85, 0.7),
  candle(0.8, 0.72), candle(0.78, 0.73),
]; // swing high=1, low=0.7 -> dip 30%; current 0.77 -> bounce 10%

function eysCandidate(): Candidate {
  const pool = makePool({
    address: "Pool1111111111111111111111111111111111111",
    marketCapUsd: 200_000, tvlUsd: 200_000, feeTvl24hPct: 50, vol30mUsd: 3_500_000,
  });
  return { pool, tokenMint: pool.mintX, symbol: "YOUNG", score: 90, scoreParts: {}, gateFailures: [] };
}

const skipped = () =>
  (getDb().prepare("SELECT failed_gate FROM decisions WHERE action='skipped'").all() as Array<{ failed_gate: string }>)
    .map((d) => d.failed_gate);

describe("Eys-only young-age carve-out", () => {
  let exec: FakeExecutor;

  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.sizing.kelly_enabled = false;
      c.sizing.max_positions = 5;
      c.entry.tranche_enabled = false;
      c.entry.max_quote_drift_bins = 0;
      c.follow.enabled = false;
      c.majors.enabled = false;
      c.gates.min_entry_score = 60;
      c.combo!.enabled = true;
      c.combo!.eys_age_min_minutes = 10;
      // Big enough fixed ticket to clear eys_seat's cost-skip floor; sizing
      // mechanics aren't what this test is about.
      c.combo!.canary_mode = true;
      c.combo!.canary_position_sol = 0.5;
    });
    exec = new FakeExecutor("paper");
    vi.mocked(fetchCandlesDeep).mockResolvedValue([]);
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.clearAllMocks();
  });

  it("a 20-min-old candidate that fits eys_seat proceeds to open (ageEysOnly does not block it)", async () => {
    vi.mocked(scan).mockResolvedValue({ candidates: [eysCandidate()], rejected: [], sweptPools: 1 });
    vi.mocked(vetToken).mockResolvedValue({
      verdict: "pass", softScore: 50, hardFailures: [],
      facts: { tokenAgeMinutes: 20, ageEysOnly: true },
    } as any);

    await enterNewPositions(exec);

    expect(exec.opens).toHaveLength(1);
    expect(exec.opens[0]!.play).toBe("eys_seat");
    expect(skipped()).not.toContain("age_min");
  });

  it("a 5-min-old candidate (under eys_age_min_minutes) is an unconditional age_min hard fail upstream — never reaches combo", async () => {
    vi.mocked(scan).mockResolvedValue({ candidates: [eysCandidate()], rejected: [], sweptPools: 1 });
    // Below eys_age_min_minutes: vetToken itself hard-fails, same as today.
    vi.mocked(vetToken).mockResolvedValue({
      verdict: "fail", softScore: 50,
      hardFailures: [{ gate: "age_min", value: "5m", limit: "45m" }],
      facts: { tokenAgeMinutes: 5, ageEysOnly: false },
    } as any);

    await enterNewPositions(exec);

    expect(exec.opens).toHaveLength(0);
    expect(skipped()).toContain("age_min");
  });
});
