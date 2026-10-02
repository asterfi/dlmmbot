/**
 * Entry pipeline for the Eys-only combo (owner, 2026-10-03): each play's trigger
 * through enterNewPositions, the dynamic volume bar into Jev, slots/affordability,
 * the breakout keeping its seat open, Token-2022 and stale-data gates, and the
 * on-chain quote-only fee read for eys_ape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../scanner/scan.js", () => ({ scan: vi.fn() }));
vi.mock("../scanner/meteora.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scanner/meteora.js")>();
  return { ...actual, fetchPool: vi.fn(async () => null) };
});
vi.mock("../scanner/candles.js", () => ({ fetchCandlesDeep: vi.fn(async () => []) }));
vi.mock("../scanner/gmgn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scanner/gmgn.js")>();
  return { ...actual, trendingByMint: vi.fn(async () => new Map()) };
});
vi.mock("../scanner/stonkfun.js", () => ({ fetchStonkTokens: vi.fn(async () => []) }));
vi.mock("../market.js", () => ({
  sol24hChangePct: vi.fn(async () => 0),
  solUsdPrice: vi.fn(async () => 200),
}));
vi.mock("../vetting/vet.js", () => ({ vetToken: vi.fn() }));
vi.mock("../ranges/binRent.js", () => ({
  applyBinRentGate: vi.fn(async (a: { range: unknown }) => ({
    ok: true, range: a.range, meta: { est: 0, actual: 0, tier: "normal", budget: 0, shrunk: false },
  })),
}));
vi.mock("../strategy/combo/feeMode.js", () => ({ readOnchainCollectFeeMode: vi.fn(async () => 1) }));
vi.mock("../strategy/jev/index.js", () => ({
  jevConsult: vi.fn(async () => ({ consulted: true, verdict: "yes", fallback: false, outcome: "ok", latencyMs: 1 })),
}));

import { scan } from "../scanner/scan.js";
import { trendingByMint } from "../scanner/gmgn.js";
import { fetchCandlesDeep } from "../scanner/candles.js";
import type { Candle } from "../scanner/meteora.js";
import { vetToken } from "../vetting/vet.js";
import { readOnchainCollectFeeMode } from "../strategy/combo/feeMode.js";
import { jevConsult } from "../strategy/jev/index.js";
import { enterNewPositions, resetManagerStateForTests } from "./loop.js";
import { FakeExecutor } from "../test/fakeExecutor.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb, insertOpenPosition } from "../test/db.js";
import { getDb, now } from "../db/db.js";
import { makePool } from "../test/pool.js";
import type { Candidate } from "../types.js";

const POOL = "PoolEEEE1111111111111111111111111111111111";
const MINT = "Tok1111111111111111111111111111111111111";

const mk = (open: number, high: number, low: number, close: number, volume: number): Candle =>
  ({ timestamp: 0, open, high, low, close, volume });

/** Flat, quiet candles ending in one freshest candle with the given 5m volume. */
function candlesWithLast(lastVolume: number, last: { open?: number; close?: number } = {}, quiet = 6): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < quiet; i++) out.push(mk(1, 1.02, 0.98, 1, 1000));
  out.push(mk(last.open ?? 1, Math.max(last.open ?? 1, last.close ?? 1) * 1.01, Math.min(last.open ?? 1, last.close ?? 1) * 0.99, last.close ?? 1, lastVolume));
  return out;
}

function pool(over: Record<string, unknown> = {}) {
  return makePool({
    address: POOL, marketCapUsd: 400_000, tvlUsd: 200_000, feeTvl24hPct: 50, price: 1, binStep: 100,
    vol30mUsd: 80_000, vol1hUsd: 150_000, vol24hUsd: 2_000_000, ...over,
  } as never);
}
function cand(p = pool()): Candidate {
  return { pool: p, tokenMint: p.mintX, symbol: "EYS", score: 90, scoreParts: {}, gateFailures: [] };
}
function vet(over: Record<string, unknown> = {}) {
  return { verdict: "pass", softScore: 50, hardFailures: [], facts: { tokenAgeMinutes: 600, tokenProgram: "spl-token", ...over } } as never;
}
function presence(mcap: number, perMinUsd: number) {
  return { token: { marketCapUsd: mcap }, intervals: new Set(["5m"]), volumeByInterval: new Map([["5m", perMinUsd * 5]]) } as never;
}
const skippedGates = () =>
  (getDb().prepare("SELECT failed_gate FROM decisions WHERE action='skipped'").all() as Array<{ failed_gate: string }>).map((d) => d.failed_gate);
const jevCalls = () => vi.mocked(jevConsult).mock.calls.map((c) => c[0] as unknown as Record<string, any>);

/** An open combo position on the candidate's mint. */
function openCombo(play: string, over: { entryPrice?: number; volThreshold?: number } = {}): number {
  const id = insertOpenPosition({ entrySol: 0.1, entryPrice: over.entryPrice ?? 1 });
  getDb().prepare("UPDATE positions SET play = ?, token_mint = ?, pool = ?, vol_threshold = ? WHERE id = ?")
    .run(play, MINT, POOL, over.volThreshold ?? null, id);
  return id;
}
/** Our scanner has been seeing this pool for `minutesAgo` (first snapshot) and saw it again in the current sweep. */
function seedObserved(poolAddr: string, minutesAgo: number) {
  const ins = getDb().prepare(
    "INSERT INTO pool_snapshots (pool, ts, tvl_usd, price, vol_30m, vol_1h, vol_24h, fee_tvl_30m, fee_tvl_24h) VALUES (?,?,?,?,?,?,?,?,?)"
  );
  ins.run(poolAddr, now() - minutesAgo * 60, 1, 1, 1, 1, 1, 1, 1);
  ins.run(poolAddr, now(), 1, 1, 2, 1, 1, 1, 1);
}

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
    const cc = c.combo!;
    cc.enabled = true;
    cc.canary_mode = true;
    cc.canary_position_sol = 0.1;
    cc.canary_position_pct = undefined; // these tests pin the flat 0.1 ticket; autocompound is covered in sizing.test.ts
    cc.canary_max_concurrent = 2;
    cc.ape_sol = 0.1;
    cc.play_priority = ["eys_breakout", "eys_seat", "eys_tight", "eys_ape", "eys_dump_bonus"];
    cc.eys_vol_hard_usd_per_min = 100_000;
    cc.eys_flow_usd_per_min_min = 100_000;
    cc.eys_vol_floor_usd_per_min = 15_000;
    cc.eys_vol_percentile = 0.8;
    cc.eys_vol_accel_min = 2;
    cc.jev_eys_soft_bar = 0.65;
    cc.eys_fee_per_musd_min = 20;
    cc.eys_cost_tx_sol = 0.0003;
    cc.eys_tp_pct = 2;
  });
  exec = new FakeExecutor("paper");
  vi.mocked(fetchCandlesDeep).mockResolvedValue(candlesWithLast(600_000)); // 120k/min
  vi.mocked(vetToken).mockResolvedValue(vet());
  vi.mocked(trendingByMint).mockResolvedValue(new Map());
  // Default: a both-tokens pool, so eys_ape never qualifies unless a test opts in.
  vi.mocked(readOnchainCollectFeeMode).mockResolvedValue(0);
  vi.mocked(scan).mockResolvedValue({ candidates: [cand()], rejected: [], sweptPools: 1 });
});
afterEach(() => { resetTestDb(); restoreConfig(); vi.clearAllMocks(); });

describe("eys_seat — hard and soft volume tiers", () => {
  it("hard tier (>= 100k/min): opens a Spot SOL-side seat, records the threshold, Jev gets the normal bar", async () => {
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(1);
    const o = exec.opens[0]!;
    expect(o.play).toBe("eys_seat");
    expect(o.side).toBeUndefined();
    expect(o.range.shape).toBe("spot");
    expect(o.sizeSol).toBe(0.1);
    expect(getDb().prepare("SELECT vol_threshold AS v FROM positions WHERE play IS NULL OR 1=1 ORDER BY id DESC LIMIT 1").get()).toEqual({ v: 100_000 });
    const j = jevCalls()[0]!;
    expect(j.play).toBe("eys_seat");
    expect(j.minComposite).toBeUndefined();
    expect(j.qualifyingPlays).toContain("eys_seat");
    expect(j.state.pool.vol_tier).toBe("hard");
  });

  const pinLegacySoftTier = () => installConfig((c) => {
    const cc = c.combo!;
    cc.eys_vol_floor_usd_per_min = 15_000; cc.eys_vol_percentile = 0.8; cc.eys_vol_accel_min = 2; cc.eys_soft_fee_tvl_per_hour_min = 0;
  });
  it("soft tier: between the dynamic floor and 100k/min AND accelerating -> Jev with the stricter 0.65 bar and the market context", async () => {
    pinLegacySoftTier();
    // market: 6 trending tokens at 10k..60k per minute -> p80 = 50k, floor = max(15k, 50k) = 50k
    vi.mocked(trendingByMint).mockResolvedValue(new Map(
      [10_000, 20_000, 30_000, 40_000, 50_000, 60_000].map((v, i) => [`T${i}`, presence(200_000, v)]),
    ));
    vi.mocked(fetchCandlesDeep).mockResolvedValue(candlesWithLast(300_000)); // 60k/min: soft tier
    vi.mocked(scan).mockResolvedValue({ candidates: [cand(pool({ vol4hUsd: 240 * 15_000 }))], rejected: [], sweptPools: 1 }); // trailing 15k/min -> accel 4
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(1);
    const j = jevCalls()[0]!;
    expect(j.minComposite).toBe(0.65);
    expect(j.state.pool.vol_tier).toBe("soft");
    expect(j.state.pool.dynamic_vol_floor_usd_per_min).toBeCloseTo(50_000, 3);
    expect(j.state.pool.market_percentile_usd_per_min).toBeCloseTo(50_000, 3);
    expect(j.state.pool.market_percentile_samples).toBe(6);
    expect(j.state.pool.vol_accel).toBeCloseTo(4, 6);
    expect(getDb().prepare("SELECT vol_threshold AS v FROM positions ORDER BY id DESC LIMIT 1").get()).toEqual({ v: expect.closeTo(50_000, 3) });
  });

  it("soft tier without acceleration (vol_accel < 2) is not offered to Jev at all", async () => {
    pinLegacySoftTier();
    vi.mocked(trendingByMint).mockResolvedValue(new Map(
      [10_000, 20_000, 30_000, 40_000, 50_000, 60_000].map((v, i) => [`T${i}`, presence(200_000, v)]),
    ));
    vi.mocked(fetchCandlesDeep).mockResolvedValue(candlesWithLast(300_000));
    vi.mocked(scan).mockResolvedValue({ candidates: [cand(pool({ vol4hUsd: 240 * 40_000 }))], rejected: [], sweptPools: 1 }); // accel 1.5
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(0);
    expect(jevCalls()).toHaveLength(0);
    expect(skippedGates()).toContain("combo_no_play");
  });

  it("sweet spot: floor comes from this sweep's DLMM pools (p90), and the pool must pay >= 1.5%/h fee/TVL", async () => {
    installConfig((c) => { const cc = c.combo!; cc.eys_vol_floor_usd_per_min = 1000; cc.eys_vol_percentile = 0.9; cc.eys_vol_accel_min = 0; cc.eys_soft_fee_tvl_per_hour_min = 1.5; });
    vi.mocked(trendingByMint).mockResolvedValue(new Map());
    // 6 rejected DLMM pools at 300..1800 $/min + the candidate itself (80k/30 = 2667) -> p90 = 2146.67
    const rej = [300, 600, 900, 1200, 1500, 1800].map((v, i) => cand(pool({ address: `Rej${i}1111111111111111111111111111111111`, vol30mUsd: v * 30 })));
    vi.mocked(fetchCandlesDeep).mockResolvedValue(candlesWithLast(2_500 * 5)); // 2.5k/min: above the floor, far below 100k
    vi.mocked(scan).mockResolvedValue({ candidates: [cand(pool({ feeTvl30mPct: 10 }))], rejected: rej, sweptPools: 7 }); // 20%/h
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(1);
    const j = jevCalls()[0]!;
    expect(j.state.pool.vol_tier).toBe("soft");
    expect(j.state.pool.dynamic_vol_floor_usd_per_min).toBeCloseTo(2146.667, 2);
    expect(j.state.pool.pool_fee_tvl_per_hour_pct).toBeCloseTo(20, 6);
  });

  it("sweet spot: a pool paying < 1.5%/h of TVL is not offered even with enough volume", async () => {
    installConfig((c) => { const cc = c.combo!; cc.eys_vol_floor_usd_per_min = 1000; cc.eys_vol_percentile = 0.9; cc.eys_vol_accel_min = 0; cc.eys_soft_fee_tvl_per_hour_min = 1.5; });
    vi.mocked(trendingByMint).mockResolvedValue(new Map());
    const rej = [300, 600, 900, 1200, 1500, 1800].map((v, i) => cand(pool({ address: `Rej${i}1111111111111111111111111111111111`, vol30mUsd: v * 30 })));
    vi.mocked(fetchCandlesDeep).mockResolvedValue(candlesWithLast(2_500 * 5));
    vi.mocked(scan).mockResolvedValue({ candidates: [cand(pool({ feeTvl30mPct: 0.5 }))], rejected: rej, sweptPools: 7 }); // 1%/h
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(0);
    expect(jevCalls()).toHaveLength(0);
  });

  it("below the dynamic floor nothing qualifies", async () => {
    pinLegacySoftTier();
    vi.mocked(trendingByMint).mockResolvedValue(new Map(
      [10_000, 20_000, 30_000, 40_000, 50_000, 60_000].map((v, i) => [`T${i}`, presence(200_000, v)]),
    ));
    vi.mocked(fetchCandlesDeep).mockResolvedValue(candlesWithLast(150_000)); // 30k/min < 50k floor
    vi.mocked(scan).mockResolvedValue({ candidates: [cand(pool({ vol4hUsd: 240 * 5_000 }))], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(0);
  });

  it("a blind market read (no trending data) leaves only the hard tier", async () => {
    vi.mocked(fetchCandlesDeep).mockResolvedValue(candlesWithLast(300_000)); // 60k/min
    vi.mocked(scan).mockResolvedValue({ candidates: [cand(pool({ vol4hUsd: 240 * 15_000 }))], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(0);
  });
});

describe("eys fee gates", () => {
  it("fake volume applies to the ape too (both-tokens off, quote-only on): 800k mcap / 12 SOL is rejected for BOTH plays", async () => {
    vi.mocked(readOnchainCollectFeeMode).mockResolvedValue(1);
    installConfig((c) => { c.combo!.play_priority = ["eys_ape", "eys_seat", "eys_tight", "eys_breakout", "eys_dump_bonus"]; });
    vi.mocked(vetToken).mockResolvedValue(vet({ tokenAgeMinutes: 20 }));
    vi.mocked(scan).mockResolvedValue({ candidates: [cand(pool({ marketCapUsd: 800_000, tvlUsd: 144_000, feeTvl24hPct: 40 }))], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(0);
  });

  it("fake volume: a 800k mcap with ~12 SOL of fees (15 SOL per $1M) is rejected; at 500k (24/M) it enters", async () => {
    // age 20min clamps to 1h: fees = tvl*fee%/day * (1/24) / sol_usd = 144000*.4*(1/24)/200 = 12 SOL
    vi.mocked(vetToken).mockResolvedValue(vet({ tokenAgeMinutes: 20 }));
    vi.mocked(scan).mockResolvedValue({ candidates: [cand(pool({ marketCapUsd: 800_000, tvlUsd: 144_000, feeTvl24hPct: 40 }))], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(0);

    vi.mocked(scan).mockResolvedValue({ candidates: [cand(pool({ marketCapUsd: 500_000, tvlUsd: 144_000, feeTvl24hPct: 40 }))], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(1);
  });
});

describe("eys_tight — second entry on a watched token", () => {
  const chop = () => [
    ...candlesWithLast(600_000, { open: 1, close: 1.03 }, 3),
  ];
  it("with the seat already open, a token watched >= 2 min that is chopping gets a 15-bin Spot tight range", async () => {
    openCombo("eys_seat");
    seedObserved(POOL, 5);
    vi.mocked(fetchCandlesDeep).mockResolvedValue(chop());
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(1);
    const o = exec.opens[0]!;
    expect(o.play).toBe("eys_tight");
    expect(o.range.binCount).toBe(15);
    expect(o.range.shape).toBe("spot");
  });
  it("not before 2 minutes of observation", async () => {
    openCombo("eys_seat");
    seedObserved(POOL, 0.5);
    vi.mocked(fetchCandlesDeep).mockResolvedValue(chop());
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(0);
  });
  it("a major dump inside the window blocks it", async () => {
    openCombo("eys_seat");
    seedObserved(POOL, 5);
    vi.mocked(fetchCandlesDeep).mockResolvedValue([
      mk(1, 1, 0.8, 0.8, 1000), mk(0.8, 0.82, 0.79, 0.81, 1000), mk(0.81, 0.83, 0.8, 0.82, 600_000),
    ]);
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(0);
  });
  it("on a fresh token the seat outranks tight, and qualifying_plays lists both in the decision features", async () => {
    seedObserved(POOL, 5);
    vi.mocked(fetchCandlesDeep).mockResolvedValue(chop());
    await enterNewPositions(exec);
    expect(exec.opens[0]!.play).toBe("eys_seat");
    const row = getDb().prepare("SELECT features_json FROM decisions WHERE action='entered'").get() as { features_json: string };
    const f = JSON.parse(row.features_json) as { qualifyingPlays: string[] };
    expect(f.qualifyingPlays).toEqual(expect.arrayContaining(["eys_seat", "eys_tight"]));
  });
});

describe("eys_breakout — token-sided second position; the seat stays open", () => {
  const spike = (volume: number) => candlesWithLast(volume, { open: 1.0, close: 1.12 });
  const breakoutPool = () => pool({ price: 1.05 });

  it("price above the seat's top + volume >= 300k/min + a strong spike: opens a token-sided breakout and does NOT close the seat", async () => {
    const seat = openCombo("eys_seat", { volThreshold: 100_000 });
    vi.mocked(fetchCandlesDeep).mockResolvedValue(spike(1_600_000)); // 320k/min, +12%
    vi.mocked(scan).mockResolvedValue({ candidates: [cand(breakoutPool())], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(1);
    const o = exec.opens[0]!;
    expect(o.play).toBe("eys_breakout");
    expect(o.side).toBe("token");
    expect(o.source).toBe("breakout");
    expect(o.sizeSol).toBe(0.1);
    expect(o.range.minBinId).toBeGreaterThanOrEqual(o.range.maxBinId - o.range.binCount + 1);
    expect(exec.closed).toHaveLength(0);
    const states = getDb().prepare("SELECT id, state FROM positions WHERE state = 'open'").all() as Array<{ id: number }>;
    expect(states.map((s) => s.id)).toContain(seat);
    expect(states).toHaveLength(2);
  });
  it("under 3x the seat's threshold (299k/min) it does not fire", async () => {
    openCombo("eys_seat", { volThreshold: 100_000 });
    vi.mocked(fetchCandlesDeep).mockResolvedValue(spike(1_450_000));
    vi.mocked(scan).mockResolvedValue({ candidates: [cand(breakoutPool())], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(0);
  });
  it("needs a strong spike", async () => {
    openCombo("eys_seat", { volThreshold: 100_000 });
    vi.mocked(fetchCandlesDeep).mockResolvedValue(candlesWithLast(1_600_000, { open: 1.0, close: 1.05 }));
    vi.mocked(scan).mockResolvedValue({ candidates: [cand(breakoutPool())], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(0);
  });
  it("needs price above the seat's top", async () => {
    openCombo("eys_seat", { volThreshold: 100_000 });
    vi.mocked(fetchCandlesDeep).mockResolvedValue(spike(1_600_000));
    vi.mocked(scan).mockResolvedValue({ candidates: [cand(pool({ price: 1.0 }))], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(0);
  });
  it("the bar follows the seat's own entry threshold: a 40k soft seat needs only 120k/min", async () => {
    openCombo("eys_seat", { volThreshold: 40_000 });
    vi.mocked(fetchCandlesDeep).mockResolvedValue(spike(600_000)); // 120k/min
    vi.mocked(scan).mockResolvedValue({ candidates: [cand(breakoutPool())], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens[0]?.play).toBe("eys_breakout");
  });
  it("Token-2022 mints are skipped for the token-sided breakout (policy allowlist): token2022_policy", async () => {
    openCombo("eys_seat", { volThreshold: 100_000 });
    vi.mocked(vetToken).mockResolvedValue(vet({ tokenProgram: "spl-token-2022" }));
    vi.mocked(fetchCandlesDeep).mockResolvedValue(spike(1_600_000));
    vi.mocked(scan).mockResolvedValue({ candidates: [cand(breakoutPool())], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(0);
    expect(skippedGates()).toContain("token2022_policy");
  });
});

describe("eys_dump_bonus — wide Bid-Ask as volume fades near the ATH", () => {
  it("opens a deep Bid-Ask on an Eys token whose volume fell >= 50% off its peak while price is within 20% of the ATH", async () => {
    openCombo("eys_seat");
    const cs: Candle[] = [];
    for (let i = 0; i < 9; i++) cs.push(mk(1, 1.1, 0.95, 1, 500_000));
    cs.push(mk(1, 1.15, 0.8, 1, 3_000_000));   // the peak
    cs.push(mk(1, 1.1, 0.9, 1, 2_000_000));
    cs.push(mk(1, 1.05, 0.95, 1, 1_000_000)); // freshest: 66% under the peak, 200k/min (still hard tier)
    vi.mocked(fetchCandlesDeep).mockResolvedValue(cs);
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(1);
    const o = exec.opens[0]!;
    expect(o.play).toBe("eys_dump_bonus");
    expect(o.range.shape).toBe("bidask");
    expect(o.range.binCount).toBeGreaterThanOrEqual(100);
  });
  it("does not fire while volume is still near its peak", async () => {
    openCombo("eys_seat");
    const cs: Candle[] = [];
    for (let i = 0; i < 9; i++) cs.push(mk(1, 1.1, 0.95, 1, 500_000));
    cs.push(mk(1, 1.15, 0.8, 1, 3_000_000), mk(1, 1.1, 0.9, 1, 2_900_000), mk(1, 1.05, 0.95, 1, 2_800_000));
    vi.mocked(fetchCandlesDeep).mockResolvedValue(cs);
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(0);
  });
});

describe("slots and affordability", () => {
  it("canary: an open seat plus its tight/breakout fills both slots; a third is skipped as canary_max_concurrent", async () => {
    openCombo("eys_seat");
    openCombo("eys_tight");
    vi.mocked(scan).mockResolvedValue({
      candidates: [cand(pool({ address: "PoolOther11111111111111111111111111111111", mintX: "TokOther1111111111111111111111111111111" } as never))],
      rejected: [], sweptPools: 1,
    });
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(0);
    expect(skippedGates()).toContain("canary_max_concurrent");
  });
  it("one open position leaves the second slot free (upstream slot caps and displacement do not apply under combo)", async () => {
    openCombo("eys_seat");
    // a different token takes the second slot as its own seat
    vi.mocked(scan).mockResolvedValue({
      candidates: [cand(pool({ address: "PoolOther11111111111111111111111111111111", mintX: "TokOther1111111111111111111111111111111" } as never))],
      rejected: [], sweptPools: 1,
    });
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(1);
    expect(exec.opens[0]!.play).toBe("eys_seat");
  });
  it("skips (never undersizes) when equity cannot cover size + reserve + one account's rent", async () => {
    exec.wallet = 0.18; // needs 0.1 + 0.045 rent + 0.04 buffer = 0.185
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(0);
    expect(skippedGates().some((g) => g.startsWith("skip_affordability"))).toBe(true);
  });
  it("prices the REAL position-account count: a 2-account Spot range on a fine-step pool needs 0.1 + 2x0.045 + 0.04", async () => {
    exec.wallet = 0.21; // enough for one account (0.185), not for two (0.23)
    vi.mocked(scan).mockResolvedValue({ candidates: [cand(pool({ binStep: 10 }))], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(0);
    const row = getDb().prepare("SELECT features_json FROM decisions WHERE failed_gate = 'skip_affordability'").get() as { features_json: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.features_json)).toMatchObject({ positionAccounts: 2 });
  });
  it("the same range IS taken when equity covers both accounts", async () => {
    exec.wallet = 0.5;
    vi.mocked(scan).mockResolvedValue({ candidates: [cand(pool({ binStep: 10 }))], rejected: [], sweptPools: 1 });
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(1);
    expect(exec.opens[0]!.range.positionAccounts).toBe(2);
  });
});

describe("data freshness and guards", () => {
  it("skips a candidate whose datapi reading is frozen across 3 polls while the market moved (stale_pool_data)", async () => {
    const t = now();
    const ins = getDb().prepare(
      "INSERT INTO pool_snapshots (pool, ts, tvl_usd, price, vol_30m, vol_1h, vol_24h, fee_tvl_30m, fee_tvl_24h) VALUES (?,?,?,?,?,?,?,?,?)"
    );
    for (let s = 0; s < 3; s++) {
      const ts = t - (2 - s) * 60;
      ins.run(POOL, ts, 1, 1, 5000, 1, 1, 1, 1);
      for (let i = 0; i < 10; i++) ins.run(`O${i}`, ts, 1, 1, 1000 + s * 50 + i, 1, 1, 1, 1);
    }
    await enterNewPositions(exec);
    expect(exec.opens).toHaveLength(0);
    expect(skippedGates()).toContain("stale_pool_data");
  });
});

describe("eys_ape — SOL-fee (quote-only) pool, read from the chain", () => {
  const apeFirst = () => installConfig((c) => { c.combo!.play_priority = ["eys_ape", "eys_seat", "eys_tight", "eys_breakout", "eys_dump_bonus"]; });

  it("on-chain OnlyY (1): qualifies and opens a token-sided ape", async () => {
    apeFirst();
    vi.mocked(readOnchainCollectFeeMode).mockResolvedValue(1);
    await enterNewPositions(exec);
    expect(exec.opens[0]!.play).toBe("eys_ape");
    expect(exec.opens[0]!.side).toBe("token");
  });
  it("on-chain InputOnly (0) overrides a datapi that said quote-only: no ape (the seat is taken instead)", async () => {
    apeFirst();
    vi.mocked(readOnchainCollectFeeMode).mockResolvedValue(0);
    await enterNewPositions(exec);
    expect(exec.opens[0]!.play).toBe("eys_seat");
  });
  it("unreadable on-chain mode falls back to the datapi value and logs fee_mode_unknown", async () => {
    apeFirst();
    vi.mocked(readOnchainCollectFeeMode).mockResolvedValue(null);
    await enterNewPositions(exec);
    expect(exec.opens[0]!.play).toBe("eys_ape");
    expect(skippedGates()).toContain("fee_mode_unknown");
  });
  it("Token-2022 mints never get the token-sided ape (token2022_policy)", async () => {
    apeFirst();
    vi.mocked(readOnchainCollectFeeMode).mockResolvedValue(1);
    vi.mocked(vetToken).mockResolvedValue(vet({ tokenProgram: "spl-token-2022" }));
    await enterNewPositions(exec);
    expect(exec.opens[0]!.play).toBe("eys_seat");
    expect(skippedGates()).toContain("token2022_policy");
  });
});
