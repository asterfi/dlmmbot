/**
 * datapi staleness (owner, 2026-10-03): no feed timestamp exists, so a pool is
 * stale when its newest snapshot is old, or its fields were frozen across 3
 * polls while the rest of the market moved.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { useMemoryDb, resetTestDb } from "../test/db.js";
import { getDb, poolDataStale } from "./db.js";

const T = 1_800_000_000;

function snap(pool: string, ts: number, vol30m: number, over: Partial<{ price: number; tvl: number; vol1h: number; vol24h: number; f30: number; f24: number }> = {}) {
  getDb().prepare(
    "INSERT INTO pool_snapshots (pool, ts, tvl_usd, price, vol_30m, vol_1h, vol_24h, fee_tvl_30m, fee_tvl_24h) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(pool, ts, over.tvl ?? 50_000, over.price ?? 1, vol30m, over.vol1h ?? 100, over.vol24h ?? 1000, over.f30 ?? 1, over.f24 ?? 10);
}
/** 3 sweeps; `P` is frozen unless `frozen=false`; `n` other pools whose vol_30m drifts each sweep iff `marketMoves`. */
function seed(opts: { frozen: boolean; marketMoves: boolean; n?: number; sweeps?: number }) {
  const sweeps = opts.sweeps ?? 3;
  for (let s = 0; s < sweeps; s++) {
    const ts = T - (sweeps - 1 - s) * 60;
    snap("P", ts, opts.frozen ? 5000 : 5000 + s * 100);
    for (let i = 0; i < (opts.n ?? 10); i++) snap(`O${i}`, ts, opts.marketMoves ? 1000 + s * 50 + i : 1000 + i);
  }
}

beforeEach(() => useMemoryDb());
afterEach(() => resetTestDb());

describe("poolDataStale", () => {
  it("no snapshots: not stale (cannot tell)", () => {
    expect(poolDataStale("P", { nowTs: T }).stale).toBe(false);
  });
  it("fresh and moving: not stale", () => {
    seed({ frozen: false, marketMoves: true });
    expect(poolDataStale("P", { nowTs: T + 10 }).stale).toBe(false);
  });
  it("newest reading older than datapi_max_age_s (120s) is stale", () => {
    seed({ frozen: false, marketMoves: true });
    const r = poolDataStale("P", { nowTs: T + 121, maxAgeS: 120 });
    expect(r.stale).toBe(true);
    expect(r.reason).toMatch(/121s old/);
    expect(poolDataStale("P", { nowTs: T + 120, maxAgeS: 120 }).stale).toBe(false);
  });
  it("identical fields across 3 polls while the market moved: stale", () => {
    seed({ frozen: true, marketMoves: true });
    const r = poolDataStale("P", { nowTs: T + 5 });
    expect(r.stale).toBe(true);
    expect(r.reason).toMatch(/identical across 3 polls/);
  });
  it("identical fields in a market that is itself idle is just quiet, not stale", () => {
    seed({ frozen: true, marketMoves: false });
    expect(poolDataStale("P", { nowTs: T + 5 }).stale).toBe(false);
  });
  it("fewer than 3 snapshots cannot prove a freeze", () => {
    seed({ frozen: true, marketMoves: true, sweeps: 2 });
    expect(poolDataStale("P", { nowTs: T + 5 }).stale).toBe(false);
  });
  it("any single field changing across the polls clears it", () => {
    seed({ frozen: true, marketMoves: true });
    getDb().prepare("UPDATE pool_snapshots SET price = 1.01 WHERE pool = 'P' AND ts = ?").run(T - 60);
    expect(poolDataStale("P", { nowTs: T + 5 }).stale).toBe(false);
  });
  it("too few other pools to call the market active: not stale", () => {
    seed({ frozen: true, marketMoves: true, n: 3 });
    expect(poolDataStale("P", { nowTs: T + 5 }).stale).toBe(false);
  });
});
