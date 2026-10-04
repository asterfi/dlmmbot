import { describe, it, expect, afterEach } from "vitest";
import { poolGates } from "../scanner/gates.js";
import { parseKlinePeakUsd } from "../scanner/gmgn.js";
import { sanitizeCandles } from "../scanner/candles.js";
import { planApeRange } from "../strategy/combo/apeRange.js";
import { planTightRange, pumpOriginBins } from "../strategy/combo/eysRanges.js";
import { installConfig, restoreConfig } from "./config.js";
import { makePool } from "./pool.js";

// Eys-fidelity fixes (owner, 2026-10-03): 1m volume, no non-Eys pool gates,
// default 69-bin ranges, Spot token-sided.

const SKIP = ["fee_tvl_24h", "fee_tvl_30m_daily", "vol_trend", "tvl_max"];
const COLD = { feeTvl24hPct: 0.1, feeTvl30mPct: 0.001, feeTvl1hPct: 0.001, tvlUsd: 5_000_000 };

describe("combo_skip_gates", () => {
  afterEach(() => restoreConfig());

  it("ignores the listed upstream gates while combo is on", () => {
    installConfig((c) => { c.combo!.enabled = true; c.gates.combo_skip_gates = SKIP; });
    const gates = poolGates(makePool(COLD)).map((f) => f.gate);
    for (const g of SKIP) expect(gates).not.toContain(g);
  });

  it("still applies them when combo is off", () => {
    installConfig((c) => { c.combo!.enabled = false; c.gates.combo_skip_gates = SKIP; });
    const gates = poolGates(makePool(COLD)).map((f) => f.gate);
    expect(gates).toContain("fee_tvl_24h");
    expect(gates).toContain("tvl_max");
  });

  it("never skips safety gates", () => {
    installConfig((c) => { c.combo!.enabled = true; c.gates.combo_skip_gates = SKIP; });
    const gates = poolGates(makePool({ marketCapUsd: 1_000, tvlUsd: 100 })).map((f) => f.gate);
    expect(gates).toContain("mcap_min");
    expect(gates).toContain("tvl_min");
  });
});

describe("fee-tier pools skip the raw vol_30m floor", () => {
  afterEach(() => restoreConfig());
  it("exempt at >= eys_fee_entry_pct_per_h, not below", () => {
    installConfig((c) => { c.combo!.enabled = true; c.combo!.eys_fee_entry_pct_per_h = 5; });
    expect(poolGates(makePool({ vol30mUsd: 3_000, feeTvl30mPct: 2.5 })).map((f) => f.gate)).not.toContain("vol_30m");
    expect(poolGates(makePool({ vol30mUsd: 3_000, feeTvl30mPct: 2.4 })).map((f) => f.gate)).toContain("vol_30m");
  });
  it("not exempt with combo off", () => {
    installConfig((c) => { c.combo!.enabled = false; c.combo!.eys_fee_entry_pct_per_h = 5; });
    expect(poolGates(makePool({ vol30mUsd: 3_000, feeTvl30mPct: 10 })).map((f) => f.gate)).toContain("vol_30m");
  });
});

describe("parseKlinePeakUsd", () => {
  const T = 1_790_947_260_000;
  const raw = JSON.stringify({ list: [
    { time: T - 600_000, volume: "500000" },      // 10 min ago: outside the window
    { time: T - 60_000, volume: "97456.2" },
    { time: T, volume: "42708" },
  ] });

  it("takes the highest bar inside the window", () => {
    expect(parseKlinePeakUsd(raw, T - 120_000)).toBeCloseTo(97456.2);
  });
  it("is 0 when nothing traded in the window (GMGN skips empty minutes)", () => {
    expect(parseKlinePeakUsd(raw, T + 60_000)).toBe(0);
  });
  it("is null for an unrecognizable payload", () => {
    expect(parseKlinePeakUsd("not json", 0)).toBeNull();
    expect(parseKlinePeakUsd(JSON.stringify({ code: 429 }), 0)).toBeNull();
  });
});

describe("default 69-bin ranges", () => {
  it("seat: 69 bins ending at the active bin, one position account", () => {
    const r = planTightRange(0.77, 100, 6, 69, 2);
    expect(r.binCount).toBe(69);
    expect(r.positionAccounts).toBe(1);
    expect(r.shape).toBe("spot");
    expect(r.bottomPricePct).toBeLessThan(-45); // 1% step: ~-49%
  });

  it("ape: 69 bins above price, Spot, one account (bins override the % cap)", () => {
    const r = planApeRange(0.77, 100, 6, 50, 2, 69);
    expect(r.binCount).toBe(69);
    expect(r.positionAccounts).toBe(1);
    expect(r.shape).toBe("spot");
    expect(r.topPricePct).toBeGreaterThan(90); // 1% step: ~+97%
  });

  it("ape without bins keeps the % range", () => {
    const r = planApeRange(0.77, 100, 6, 50, 2);
    expect(r.topPricePct).toBeGreaterThan(45);
    expect(r.topPricePct).toBeLessThan(55);
  });
});

describe("pumpOriginBins (re-seat range)", () => {
  it("covers the pump back to its origin on a 1% step pool", () => {
    // price 1.40 after a pump from 1.00: ln(1.4)/ln(1.01) = 33.8 -> 34 bins
    expect(pumpOriginBins(1.4, 1.0, 100, 30, 69)).toBe(34);
  });
  it("never narrower than the minimum", () => {
    expect(pumpOriginBins(1.1, 1.0, 100, 30, 69)).toBe(30);
  });
  it("never wider than one account (the default range)", () => {
    expect(pumpOriginBins(3.0, 1.0, 100, 30, 69)).toBe(69);
  });
  it("falls back to the default when the low is unknown or not below price", () => {
    expect(pumpOriginBins(1.4, null, 100, 30, 69)).toBe(69);
    expect(pumpOriginBins(1.4, 1.5, 100, 30, 69)).toBe(69);
  });
});

describe("sanitizeCandles (freak wick prints)", () => {
  const bar = (o: number, h: number, l: number, c: number, i: number) => ({ timestamp: i, open: o, high: h, low: l, close: c, volume: 1 });
  // knightcat 2026-10-04: real bars ~1.2e-5 with lows of 1.5e-9 and one open at 2e-8
  const raw = [
    bar(1.09e-5, 1.43e-5, 9.1e-6, 1.43e-5, 1),
    bar(1.43e-5, 1.59e-5, 1.5e-9, 1.27e-5, 2),
    bar(1.27e-5, 1.44e-5, 1.04e-5, 1.33e-5, 3),
    bar(1.33e-5, 1.98e-5, 7.8e-9, 2.03e-8, 4),
    bar(2.03e-8, 1.77e-5, 1.05e-8, 1.33e-5, 5),
    bar(1.33e-5, 1.40e-5, 1.3e-8, 1.20e-5, 6),
    bar(1.20e-5, 1.39e-5, 3.4e-9, 1.23e-5, 7),
  ];
  const clean = sanitizeCandles(raw);
  it("removes the ~1000x-off prints", () => {
    expect(Math.min(...clean.map((c) => c.low))).toBeGreaterThan(9e-6);
    expect(clean[3]!.close).toBeCloseTo(1.33e-5, 10);
    expect(clean[4]!.open).toBeCloseTo(1.33e-5, 10);
  });
  it("keeps real bars untouched", () => {
    expect(clean[0]).toEqual(raw[0]);
    expect(clean[2]).toEqual(raw[2]);
  });
  it("keeps a real 3x move", () => {
    const pump = [1, 1.1, 1.3, 1.8, 2.4, 3.0, 3.2].map((p, i) => bar(p * 0.95, p * 1.05, p * 0.9, p, i));
    expect(sanitizeCandles(pump)).toEqual(pump);
  });
});
