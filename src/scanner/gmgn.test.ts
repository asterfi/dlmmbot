import { describe, it, expect, beforeEach } from "vitest";
import {
  MAX_DIRECT_INFO_CALLS,
  FLOW_CACHE_TTL_MS,
  ENRICH_TTL_MS,
  parseTokenSecurity,
  parseGmgnResetMs,
  isGmgnRateLimitText,
  gmgnRouteWeight,
  gmgnBucketId,
  gmgnTokenBudgetOk,
  gmgnSpendOk,
  gmgnOneMinuteFlow,
  _setGmgnBucketForTests,
  _resetGmgnPaceForTests,
  _gmgnEnterBanForTests,
  _gmgnAgeThrottleForTests,
  gmgnPaceState,
  gmgnSpendBudget,
  gmgnIntervalsForStrategy,
  gmgnMarketCapRangesForStrategy,
  SPEND_WINDOW_MAX as SPEND_WINDOW_MAX_FOR_TEST,
  GMGN_ONE_MINUTE_FRESHNESS_MS,
} from "./gmgn.js";
import type { GmgnPresence, GmgnTrendingToken } from "./gmgn.js";

// tokenSecurity is the pipeline's ONLY honeypot/sell-tax check (vet.ts).
// The parser must fail closed (null) on shape drift, never read a payload it
// doesn't understand as "honeypot=false".

describe("parseTokenSecurity", () => {
  it("unwraps the --raw { code, data } envelope like every other endpoint", () => {
    const raw = JSON.stringify({ code: 0, data: { honeypot: 1, sell_tax: 0.05, buy_tax: 0.01 } });
    expect(parseTokenSecurity(raw)).toEqual({
      honeypot: true,
      sellTaxPct: 5,
      buyTaxPct: 1,
      renouncedMint: null,
      renouncedFreeze: null,
    });
  });

  it("handles nested data envelopes", () => {
    const raw = JSON.stringify({ code: 0, data: { data: { honeypot: 0, can_not_sell: 1, sell_tax: 0 } } });
    expect(parseTokenSecurity(raw)?.honeypot).toBe(true);
  });

  it("still reads top-level fields when there is no envelope", () => {
    const raw = JSON.stringify({ honeypot: 0, sell_tax: 0, buy_tax: 0 });
    expect(parseTokenSecurity(raw)).toEqual({
      honeypot: false,
      sellTaxPct: 0,
      buyTaxPct: 0,
      renouncedMint: null,
      renouncedFreeze: null,
    });
  });

  it("parses GMGN security numeric strings from the live CLI shape", () => {
    const raw = JSON.stringify({
      honeypot: 0,
      can_not_sell: 0,
      buy_tax: "0.03",
      sell_tax: "0.03",
      renounced_mint: false,
      renounced_freeze_account: true,
    });
    expect(parseTokenSecurity(raw)).toEqual({
      honeypot: false,
      sellTaxPct: 3,
      buyTaxPct: 3,
      renouncedMint: false,
      renouncedFreeze: true,
    });
  });

  it("rejects malformed boolean, numeric, and JSON security values", () => {
    expect(parseTokenSecurity(JSON.stringify({ honeypot: "maybe", sell_tax: 0 }))).toBeNull();
    expect(parseTokenSecurity(JSON.stringify({ honeypot: 0, sell_tax: "bad", buy_tax: 0 }))).toBeNull();
    expect(parseTokenSecurity(JSON.stringify({ honeypot: 0, sell_tax: -0.01, buy_tax: 0 }))).toBeNull();
    expect(parseTokenSecurity(JSON.stringify({ honeypot: 0, sell_tax: 1.01, buy_tax: 0 }))).toBeNull();
    expect(parseTokenSecurity(JSON.stringify({ honeypot: 0, sell_tax: 0, buy_tax: -1 }))).toBeNull();
    expect(parseTokenSecurity("{not-json")).toBeNull();
  });

  it("returns null (not honeypot=false) when no security field is recognizable", () => {
    expect(parseTokenSecurity(JSON.stringify({ code: 0, data: { msg: "ok" } }))).toBeNull();
    expect(parseTokenSecurity(JSON.stringify({ code: 0, data: {} }))).toBeNull();
  });
});

describe("Eys GMGN interval requirement", () => {
  it("forces a genuine 1m window for Eys without changing core intervals", () => {
    expect(gmgnIntervalsForStrategy(["5m", "1h"], true)).toEqual(["1m", "5m", "1h"]);
    expect(gmgnIntervalsForStrategy(["1m", "5m"], true)).toEqual(["1m", "5m"]);
    expect(gmgnIntervalsForStrategy(["5m", "1h"], false)).toEqual(["5m", "1h"]);
  });
});

describe("Eys GMGN market-cap intake", () => {
  it("keeps the widened 1m intake inside the trending spend budget", () => {
    const ranges = gmgnMarketCapRangesForStrategy("1m", true);
    // Widened 2026-09-22 (operator "follow your recommendations"): 4 bands
    // starved the funnel (1,865 flow_unavailable rejects / 2h). 6 bands keep
    // the hot 100k-500k zone finely split while intake spend stays bounded:
    // 6 bands + 5m + 1h = 8 weight-1 calls/min vs SPEND_WINDOW_MAX 36.
    expect(ranges).toHaveLength(6);
    expect(ranges.length + 2).toBeLessThanOrEqual(8);
    expect(ranges).toContainEqual({});
    expect(ranges).toContainEqual({ min: 100_000, max: 250_000 });
    expect(ranges).toContainEqual({ min: 250_000, max: 500_000 });
    expect(ranges).toContainEqual({ min: 500_000, max: 1_000_000 });
    expect(ranges).toContainEqual({ min: 1_000_000, max: 2_000_000 });
    expect(ranges).toContainEqual({ min: 2_000_000 });
    expect(gmgnMarketCapRangesForStrategy("5m", true)).toEqual([{}]);
    expect(gmgnMarketCapRangesForStrategy("1m", false)).toEqual([{}]);
  });
});

describe("Eys direct-refresh spend + freshness headroom", () => {
  // Operator "go" 2026-09-23: two-stage starvation measured live — refresh
  // budget 30 < 35-40 candidates, and a 16-call fetch cap covered ~42% of
  // candidates, so most landed flow_unavailable/stale and could never clear
  // the $25k/min floor (0 candidates past fresh flow in a 47-min window).
  // Ceiling SPEND_WINDOW_MAX 36/min is deliberately NOT raised: runOne waits
  // or throws "gmgn budget exhausted" against it, so raising the cap only
  // redistributes existing spend instead of adding rate-limit risk.
  it("raises the direct-info fetch cap to 20 without touching the spend ceiling", () => {
    expect(MAX_DIRECT_INFO_CALLS).toBe(20);
    expect(SPEND_WINDOW_MAX_FOR_TEST).toBe(36);
  });

  // ENRICH_TTL_MS is shared by the security and tag caches: shortening THAT
  // would double weight-1/weight-5 enrichment calls inside the same fixed
  // ceiling and crowd out the very refresh fetches this change pays for.
  // Only the flow cache gets a shorter TTL.
  it("keeps security/tag enrichment TTL at 60s but shortens the flow cache", () => {
    expect(ENRICH_TTL_MS).toBe(60_000);
    expect(FLOW_CACHE_TTL_MS).toBe(30_000);
  });

  // The live bug: cache TTL equal to the freshness window hands back a row
  // with ~0 seconds of headroom, so a "successful" refresh still fails the
  // 60s freshness check at evaluation. Headroom must be strictly positive.
  it("leaves positive headroom inside the 1m freshness window", () => {
    expect(GMGN_ONE_MINUTE_FRESHNESS_MS - FLOW_CACHE_TTL_MS).toBeGreaterThanOrEqual(30_000);
  });
});

describe("gmgn rate-limit helpers", () => {
  beforeEach(() => _resetGmgnPaceForTests());

  it("weights holders/traders heavier than trending/security", () => {
    expect(gmgnRouteWeight(["market", "trending"])).toBe(1);
    expect(gmgnRouteWeight(["token", "security"])).toBe(1);
    expect(gmgnRouteWeight(["token", "holders"])).toBe(5);
    expect(gmgnRouteWeight(["token", "traders"])).toBe(5);
  });

  it("parses reset_at and X-RateLimit-Reset", () => {
    const now = 1_700_000_000_000;
    expect(parseGmgnResetMs('{"error":"RATE_LIMIT_BANNED","reset_at":1700000060}', now))
      .toBe(1_700_000_060_000);
    expect(parseGmgnResetMs('{"code":429,"error":"RATE_LIMIT_BANNED","reset_at":1700000060}', now))
      .toBe(1_700_000_060_000);
    expect(parseGmgnResetMs("X-RateLimit-Reset: 1700000099", now)).toBe(1_700_000_099_000);
    expect(parseGmgnResetMs("nope", now)).toBeNull();
  });

  it("reads gmgn-cli's '(~Ns remaining)' form — the epoch is never printed", () => {
    const now = 1_700_000_000_000;
    const cli = "GET /market/trending failed: HTTP 429 error=RATE_LIMIT_EXCEEDED. " +
      "Rate limit resets at 2026-09-07 02:23:30+00:00 (~12s remaining). Stop sending requests before then";
    expect(parseGmgnResetMs(cli, now)).toBe(now + 13_000);
  });

  it("ignores bare 429 (npm noise) but catches GMGN RATE_LIMIT payloads", () => {
    expect(isGmgnRateLimitText("npm ERR! code E429")).toBe(false);
    expect(isGmgnRateLimitText("HTTP 429 Too Many Requests")).toBe(false);
    expect(isGmgnRateLimitText('{"error":"RATE_LIMIT_BANNED","reset_at":1}')).toBe(true);
    expect(isGmgnRateLimitText("HTTP 429 rate limit exceeded")).toBe(true);
  });

  it("maps CLI args to per-module buckets", () => {
    expect(gmgnBucketId(["market", "trending"])).toBe("market");
    expect(gmgnBucketId(["token", "holders"])).toBe("token");
    expect(gmgnBucketId(["track", "smartmoney"])).toBe("track");
  });

  it("sheds optional trader-tag calls when token bucket is depleted", () => {
    _resetGmgnPaceForTests();
    _setGmgnBucketForTests("token", 5);
    expect(gmgnTokenBudgetOk(5)).toBe(true);
    _setGmgnBucketForTests("token", 4);
    expect(gmgnTokenBudgetOk(5)).toBe(false);
  });

  it("allows required security preflight when optional paths would shed", () => {
    _resetGmgnPaceForTests();
    _setGmgnBucketForTests("token", 1);
    expect(gmgnSpendOk(1, "token")).toBe(true);
    expect(gmgnSpendOk(5, "token", { optional: true })).toBe(false);
  });
});

describe("Eys one-minute GMGN provenance", () => {
  const token = (volumeUsd: number): GmgnTrendingToken => ({
    address: "mint",
    symbol: "TST",
    priceChangePct1h: 2,
    volumeUsd,
    liquidityUsd: 100_000,
    marketCapUsd: 1_000_000,
    holderCount: 100,
    top10HolderRate: 0.2,
    renouncedMint: true,
    renouncedFreeze: true,
    launchpad: "",
    creator: "creator",
    openTimestamp: 0,
  });

  it("uses only a fresh interval-specific 1m row", () => {
    const now = 1_700_000_000_000;
    const presence: GmgnPresence = {
      token: token(1),
      intervals: new Set(["1m", "5m"]),
      tokenByInterval: new Map([["1m", token(125_000)], ["5m", token(500_000)]]),
      fetchedAtMsByInterval: new Map([["1m", now - 30_000], ["5m", now - 30_000]]),
    };
    expect(gmgnOneMinuteFlow(presence, now)).toEqual({
      source: "gmgn-market-trending",
      cadence: "1m",
      volumeUsd: 125_000,
      observedAtMs: now - 30_000,
    });
    expect(gmgnOneMinuteFlow(presence, now, 10_000)).toBeNull();
    const stale = {
      ...presence,
      fetchedAtMsByInterval: new Map([["1m", now - 121_000], ["5m", now - 30_000]]),
    };
    expect(gmgnOneMinuteFlow(stale, now)).toBeNull();
  });
});

// A local bucket cannot see GMGN's real remaining budget, so resuming after a
// ban at exactly the rate that earned it reproduces the ban. Each ban has to
// cost us a step of rate, or the error log fills with the same sawtooth.
describe("adaptive throttle", () => {
  beforeEach(() => _resetGmgnPaceForTests());

  it("tightens the rolling budget one step per ban", () => {
    const full = gmgnSpendBudget();
    _gmgnEnterBanForTests(Date.now() - 1);        // already expired: only the throttle persists
    const once = gmgnSpendBudget();
    expect(once).toBeLessThan(full);
    _gmgnEnterBanForTests(Date.now() - 1);
    expect(gmgnSpendBudget()).toBeLessThan(once);
  });

  it("stops tightening at the floor instead of starving the scanner", () => {
    for (let i = 0; i < 12; i++) _gmgnEnterBanForTests(Date.now() - 1);
    expect(gmgnPaceState().throttleLevel).toBe(4);
    expect(gmgnSpendBudget()).toBeGreaterThanOrEqual(6);
  });

  it("relaxes one step per clean 15 minutes", () => {
    _gmgnEnterBanForTests(Date.now() - 1);
    _gmgnEnterBanForTests(Date.now() - 1);
    expect(gmgnPaceState().throttleLevel).toBe(2);
    _gmgnAgeThrottleForTests(15 * 60_000 + 1_000);
    expect(gmgnPaceState().throttleLevel).toBe(1);
    _gmgnAgeThrottleForTests(60 * 60_000);
    expect(gmgnPaceState().throttleLevel).toBe(0);
    expect(gmgnSpendBudget()).toBe(36);
  });

  it("keeps optional calls off the wire while the ban is live", () => {
    _gmgnEnterBanForTests(Date.now() + 30_000);
    _setGmgnBucketForTests("token", 20);
    expect(gmgnSpendOk(5, "token", { optional: true })).toBe(false);
    expect(gmgnTokenBudgetOk(5)).toBe(false);
  });
});
