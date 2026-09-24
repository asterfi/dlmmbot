import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eysDiscoveryGates, eysFlowSourceGateFailure, pickBestPool, pickCopycatWinner, selectEysPoolResolutionMints } from "./scan.js";
import { poolGates } from "./gates.js";
import { makePool } from "../test/pool.js";
import { effectiveEysFlowFloorUsd, EYS_MIN_FLOW_FLOOR_USD } from "../config.js";
import { installConfig, restoreConfig } from "../test/config.js";

describe("pickCopycatWinner (copycat cooldown, §1.2)", () => {
  const NOW = 1_000_000;
  const IGNORE_S = 24 * 3600;

  it("picks the highest-volume mint and cools down the losers", () => {
    const ignored = new Map<string, number>();
    const vols = new Map([["mintA", 50_000], ["mintB", 200_000], ["mintC", 10_000]]);
    expect(pickCopycatWinner(vols, ignored, NOW, IGNORE_S)).toBe("mintB");
    expect(ignored.get("mintA")).toBe(NOW + IGNORE_S);
    expect(ignored.get("mintC")).toBe(NOW + IGNORE_S);
    expect(ignored.has("mintB")).toBe(false);
  });

  it("keeps the previous winner even when a cooled loser flips ahead on volume", () => {
    const ignored = new Map<string, number>();
    pickCopycatWinner(new Map([["mintA", 50_000], ["mintB", 200_000]]), ignored, NOW, IGNORE_S);
    // Next sweep: mintA's volume spiked past mintB — but it lost within the
    // last 24h, so it stays ignored and mintB stays canonical.
    const later = NOW + 3600;
    expect(pickCopycatWinner(new Map([["mintA", 500_000], ["mintB", 200_000]]), ignored, later, IGNORE_S)).toBe("mintB");
    // After the cooldown expires it may compete (and win) again.
    const expired = NOW + IGNORE_S + 1;
    expect(pickCopycatWinner(new Map([["mintA", 500_000], ["mintB", 200_000]]), ignored, expired, IGNORE_S)).toBe("mintA");
  });

  it("returns null when every contender is cooling down", () => {
    const ignored = new Map([["mintA", NOW + 999], ["mintB", NOW + 999]]);
    expect(pickCopycatWinner(new Map([["mintA", 1], ["mintB", 2]]), ignored, NOW, IGNORE_S)).toBeNull();
  });

  it("never cools down a sole contender", () => {
    const ignored = new Map<string, number>();
    expect(pickCopycatWinner(new Map([["mintA", 1]]), ignored, NOW, IGNORE_S)).toBe("mintA");
    expect(ignored.size).toBe(0);
  });
});

/**
 * Which of a token's pools to trade. "Highest fee/TVL" is inversely
 * proportional to TVL and so structurally picks the THINNEST sibling — thin
 * pools earn less and their TVL jitters 40-50% on ordinary LP moves, which
 * P0 tvl_drain reads as a rug (2026-08-15, pos#5 GUNICORN).
 */
describe("pickBestPool (deepest gate-passing sibling)", () => {
  const pool = (tvlUsd: number, feeTvl24hPct: number, binStep = 100, ok = true) =>
    ({ tvlUsd, feeTvl24hPct, binStep, ok });
  const passes = (p: { ok: boolean }) => p.ok;

  it("takes the deepest same-bin-step sibling, not the highest fee/TVL", () => {
    // The GUNICORN shape: $8k pool at 64% fee/TVL vs $67k pool at 34%.
    const thin = pool(8_000, 64), deep = pool(67_000, 34);
    expect(pickBestPool([thin, deep], passes, 25)).toBe(deep);
  });

  it("the gates are the family boundary — a bin-20 pool loses because bin_step_new fails it", () => {
    // Deep bin-20 pool exists but the strategy needs wide bins. It is not an
    // alternative because the GATES reject it, so it is simply not eligible.
    const wideThin = pool(8_000, 64, 100), narrowDeep = pool(400_000, 5, 20, false);
    expect(pickBestPool([wideThin, narrowDeep], passes, 25)).toBe(wideThin);
  });

  it("does not split hairs between two bin steps the gates both accept", () => {
    // Real board 2026-08-15: a $6k bin-80 pool and a $60k bin-100 pool, both
    // passing (bin_step_min_new = 80). An earlier draft that demanded identical
    // bin steps picked the $6k one. Depth wins across accepted shapes.
    const bin80thin = pool(6_163, 91, 80), bin100deep = pool(59_724, 87, 100);
    expect(pickBestPool([bin80thin, bin100deep], passes, 25)).toBe(bin100deep);
  });

  it("ignores a high-fee pool that fails the gates when choosing", () => {
    const failing = pool(5_000, 99, 20, false);
    const a = pool(30_000, 20, 100), b = pool(90_000, 12, 100);
    expect(pickBestPool([failing, a, b], passes, 25)).toBe(b);
  });

  it("lets fee/TVL break a near-tie in depth", () => {
    // Within 25% of the deepest, the fee edge is real — take it.
    const deep = pool(100_000, 10), nearHot = pool(80_000, 30);
    expect(pickBestPool([deep, nearHot], passes, 25)).toBe(nearHot);
    // Just outside the band the depth rule reasserts.
    const farHot = pool(70_000, 30);
    expect(pickBestPool([deep, farHot], passes, 25)).toBe(deep);
  });

  it("a gate-failing pool never wins on depth", () => {
    const deepBad = pool(500_000, 40, 100, false), thinOk = pool(9_000, 30, 100, true);
    expect(pickBestPool([deepBad, thinOk], passes, 25)).toBe(thinOk);
  });

  it("returns the best-by-fee pool when nothing passes, so the rejection is logged", () => {
    const a = pool(20_000, 5, 100, false), b = pool(10_000, 50, 100, false);
    expect(pickBestPool([a, b], passes, 25)).toBe(b);
    expect(pickBestPool([], passes, 25)).toBeNull();
  });
});

describe("Eys-first discovery boundary", () => {
  it("does not apply generic fee, volume, base-fee, or price gates before Eys", () => {
    const pool = makePool({
      feeTvl24hPct: 1,
      feeTvl30mPct: 0.1,
      vol30mUsd: 1_000,
      baseFeePct: 10,
    });
    expect(eysDiscoveryGates(pool)).toEqual([]);
  });

  it("rejects malformed TVL instead of allowing NaN into sizing", () => {
    const pool = makePool({ tvlUsd: Number.NaN });
    expect(eysDiscoveryGates(pool).map((failure) => failure.gate)).toContain("tvl_invalid");
  });

  it("lets Eys see hot structural candidates rejected by generic listing/range/economic gates", () => {
    const base = makePool();
    const pool = {
      ...base,
      tvlUsd: 3_000_000,
      binStep: 10,
      feeTvl24hPct: 1,
      feeTvl30mPct: 0.1,
      vol30mUsd: 1_000,
      baseFeePct: 10,
      extras: { ...base.extras, freezeAuthorityDisabled: false },
    };
    expect(eysDiscoveryGates(pool)).toEqual([]);
  });

  it("keeps those generic gates in core mode", () => {
    const base = makePool();
    const pool = {
      ...base,
      tvlUsd: 3_000_000,
      binStep: 10,
      extras: { ...base.extras, freezeAuthorityDisabled: false },
    };
    expect(poolGates(pool).map((failure) => failure.gate)).toEqual(expect.arrayContaining([
      "tvl_max", "bin_step_new", "freeze_authority_listing",
    ]));
  });

  it("keeps the structural liquidity and blacklist boundary", () => {
    const pool = makePool({ tvlUsd: 100 });
    expect(eysDiscoveryGates(pool).map((failure) => failure.gate)).toContain("tvl_min");
    expect(eysDiscoveryGates(makePool({ isBlacklisted: true })).map((failure) => failure.gate)).toContain("pool_blacklisted");
  });
});

describe("Eys flow floor", () => {
  // 2026-09-23: the clamp sat at 10_000, which silently raised the operator's
  // approved `[eys] flow_floor_usd = 5000` back to $10,000/min. Cost measured
  // over 3 days: 11 fee-qualifying mints blocked (WALTER peaked at $9,485 —
  // $515 short — on $17,058 fees + 157.7%/d yield). Clamp = noise floor only.
  it("clamps to the $5k noise floor and honours any higher configured floor", () => {
    expect(EYS_MIN_FLOW_FLOOR_USD).toBe(5_000);
    expect(effectiveEysFlowFloorUsd(1)).toBe(5_000);
    expect(effectiveEysFlowFloorUsd(4_999)).toBe(5_000);
    expect(effectiveEysFlowFloorUsd(5_000)).toBe(5_000);
    expect(effectiveEysFlowFloorUsd("5000")).toBe(5_000);
    expect(effectiveEysFlowFloorUsd("50000")).toBe(50_000);
    expect(effectiveEysFlowFloorUsd(Number.NaN)).toBe(5_000);
    expect(effectiveEysFlowFloorUsd(Number.POSITIVE_INFINITY)).toBe(5_000);
    expect(effectiveEysFlowFloorUsd(25_000)).toBe(25_000);
    expect(effectiveEysFlowFloorUsd(150_000)).toBe(150_000);
  });
});

describe("Eys GMGN exact-pool resolution selection", () => {
  const nowMs = 1_000_000;
  const presence = (mint: string, volumeUsd: number, fetchedAtMs: number, marketCapUsd = 250_000) => {
    const token = {
      address: mint,
      symbol: mint.slice(0, 4),
      priceChangePct1h: 5,
      volumeUsd,
      liquidityUsd: 25_000,
      marketCapUsd,
      holderCount: 100,
      top10HolderRate: 0.1,
      renouncedMint: true,
      renouncedFreeze: true,
      launchpad: "",
      creator: "",
      openTimestamp: 0,
    };
    return {
      token,
      intervals: new Set(["1m"]),
      tokenByInterval: new Map([["1m", token]]),
      fetchedAtMsByInterval: new Map([["1m", fetchedAtMs]]),
    };
  };

  beforeEach(() => installConfig((c) => {
    c.strategy.mode = "eys";
    c.eys.enabled = true;
    c.eys.flow_floor_usd = 1;
    c.eys.gmgn_pool_resolution_max_mints = 2;
  }));
  afterEach(() => restoreConfig());

  it("selects fresh highest-flow mints, excludes stale/future/sub-floor rows, and respects the cap", () => {
    const gmgn = new Map([
      ["mint-high", presence("mint-high", 220_000, nowMs - 10_000)],
      ["mint-mid", presence("mint-mid", 150_000, nowMs - 20_000)],
      ["mint-low", presence("mint-low", 4_999, nowMs - 10_000)],
      ["mint-stale", presence("mint-stale", 500_000, nowMs - 121_000)],
      ["mint-future", presence("mint-future", 500_000, nowMs + 1)],
      // Huge flow, but the Eys market-cap floor rejects it downstream anyway —
      // resolving its pools would spend provider budget on a doomed candidate.
      ["mint-tiny-mcap", presence("mint-tiny-mcap", 400_000, nowMs - 10_000, 40_000)],
    ]);

    expect(selectEysPoolResolutionMints(gmgn, nowMs)).toEqual(["mint-high", "mint-mid"]);
  });
});

describe("Eys GMGN flow-source admission (candidate universe)", () => {
  it("rejects a swept pool whose mint has no GMGN sighting", () => {
    // A Meteora-swept pool absent from GMGN trending/event is never trending:
    // token-info volume_1m = 0, so it can never yield a 1m flow row. It only
    // floods flow_unavailable (46% of rejections) and dilutes the refresh
    // budget away from genuinely-hot tokens. Must not become a candidate.
    const gmgn = new Map<string, unknown>([["Trending1111111111111111111111111111111111", {}]]);
    const failure = eysFlowSourceGateFailure("SweptOnly1111111111111111111111111111111", gmgn);
    expect(failure?.gate).toBe("no_gmgn_flow_source");
    expect(failure?.limit).toBe("GMGN trending/event sighting");
  });

  it("admits a pool whose mint is in the GMGN trending/event universe", () => {
    const gmgn = new Map<string, unknown>([["Trending1111111111111111111111111111111111", {}]]);
    expect(eysFlowSourceGateFailure("Trending1111111111111111111111111111111111", gmgn)).toBeNull();
  });
});
