import { describe, it, expect, afterEach } from "vitest";
import { poolGates } from "../scanner/gates.js";
import { parseKlinePeakUsd } from "../scanner/gmgn.js";
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
