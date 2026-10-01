import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { poolGates, poolShareGate, isPeggedToDollar } from "./gates.js";
import { feeMomentumPart, turnoverPart, structurePart, opportunityScore, timingPart } from "./score.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { makePool } from "../test/pool.js";

describe("poolGates", () => {
  beforeEach(() => installConfig());
  afterEach(() => restoreConfig());

  it("passes a healthy SOL-quoted meme pool", () => {
    expect(poolGates(makePool())).toEqual([]);
  });

  it("fails TVL / mcap / vol floors", () => {
    const fails = poolGates(makePool({ tvlUsd: 100, marketCapUsd: 1000, vol30mUsd: 100 }));
    const gates = fails.map((f) => f.gate);
    expect(gates).toContain("tvl_min");
    expect(gates).toContain("mcap_min");
    expect(gates).toContain("vol_30m");
  });

  it("poolShareGate rejects oversized positions", () => {
    const p = makePool({ tvlUsd: 10_000 });
    expect(poolShareGate(p, 3_000)?.gate).toBe("pool_share");
    expect(poolShareGate(p, 500)).toBeNull();
  });
});

describe("opportunityScore parts", () => {
  beforeEach(() => installConfig());
  afterEach(() => restoreConfig());

  it("composes a deterministic score from fixture parts", () => {
    const p = makePool();
    const { score } = opportunityScore({
      feeMomentum: feeMomentumPart(p),
      turnover: turnoverPart(p),
      vettingSoft: 0.8,
      timing: 0.9,
      structure: structurePart(p),
    });
    expect(score).toBeGreaterThan(50);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("timingPart penalizes freefall", () => {
    const candles = [
      { timestamp: 1, open: 1, high: 1, low: 0.9, close: 0.95, volume: 10 },
      { timestamp: 2, open: 0.95, high: 0.95, low: 0.8, close: 0.85, volume: 10 },
      { timestamp: 3, open: 0.85, high: 0.85, low: 0.7, close: 0.75, volume: 10 },
      { timestamp: 4, open: 0.75, high: 0.75, low: 0.6, close: 0.65, volume: 10 },
    ];
    expect(timingPart(candles, 0.65)).toBeLessThan(0.5);
  });
});

describe("poolGates — exclude_mints (stablecoins/majors, 2026-10-02)", () => {
  beforeEach(() => installConfig((c) => {
    c.scanner.exclude_mints = ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]; // USDC
  }));
  afterEach(() => restoreConfig());

  it("rejects a base mint on the exclude list as excluded_mint, even though it clears every other gate", () => {
    const usdcPool = makePool({ mintX: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", marketCapUsd: 7_894_739_873 });
    const fails = poolGates(usdcPool).map((f) => f.gate);
    expect(fails).toContain("excluded_mint");
  });

  it("does not flag a mint that is not on the list", () => {
    const fails = poolGates(makePool()).map((f) => f.gate);
    expect(fails).not.toContain("excluded_mint");
  });

  it("is a no-op when exclude_mints is unset", () => {
    installConfig((c) => { delete (c.scanner as { exclude_mints?: string[] }).exclude_mints; });
    expect(poolGates(makePool()).map((f) => f.gate)).not.toContain("excluded_mint");
  });
});

describe("isPeggedToDollar", () => {
  const c = (close: number) => ({ close });

  it("flags a base token whose price never left a tight band around $1", () => {
    // 0.0085 SOL * $117.65/SOL ~= $1.00
    const candles = [c(0.0085), c(0.00852), c(0.00849), c(0.00851)];
    expect(isPeggedToDollar(candles, 117.65, 0.01)).toBe(true);
  });

  it("does not flag a genuine memecoin whose price moves", () => {
    const candles = [c(0.0085), c(0.009), c(0.0078), c(0.0095)];
    expect(isPeggedToDollar(candles, 117.65, 0.01)).toBe(false);
  });

  it("returns false when the SOL/USD price is unavailable (fail open, not closed — this is a backstop, not the primary gate)", () => {
    expect(isPeggedToDollar([c(0.0085), c(0.0085), c(0.0085)], null)).toBe(false);
  });

  it("returns false with too few candles to judge", () => {
    expect(isPeggedToDollar([c(0.0085)], 117.65)).toBe(false);
  });
});
