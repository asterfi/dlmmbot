import { describe, expect, it } from "vitest";
import { buildCardNode } from "./layout.js";
import { renderCardPng } from "./render.js";
import {
  buildOpenedCard, buildClosedCard, buildFeesClaimedCard, buildProfitLockCard,
  buildAccountCard, buildJevDecisionCard, buildApeOpenedCard, buildApeClosedCard,
  buildSkipSummaryCard, buildReconcileCard, buildErrorCard, buildWarningCard,
  buildStartupCard, buildTruthPnlCard, buildFallbackCard, parseAlertToCard,
} from "./cards.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function expectValidPng(png: Buffer): void {
  expect(png.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
  expect(png.length).toBeGreaterThan(500); // not an empty/blank render
}

describe("card builders render to a valid PNG (no network)", () => {
  const samples: Array<[string, () => { spec: ReturnType<typeof buildOpenedCard>["spec"] }]> = [
    ["opened", () => buildOpenedCard({ symbol: "WIF", posId: 1, sizeSol: 0.42, entryPrice: 0.0003841, score: 78, depthPct: 32, play: "molu ladder" })],
    ["closed", () => buildClosedCard({ symbol: "WIF", posId: 1, pnlSol: 0.06, pnlPct: 14.6, entrySol: 0.42, exitSol: 0.48, feesSol: 0.004, holdTime: "2h14m" })],
    ["closed_loss", () => buildClosedCard({ symbol: "BONK", posId: 2, pnlSol: -0.05, pnlPct: -10, entrySol: 0.5, exitSol: 0.45, feesSol: 0.001, holdTime: "40m" })],
    ["fees_claimed", () => buildFeesClaimedCard({ symbol: "BONK", posId: 2, claimedSol: 0.009 })],
    ["profit_lock", () => buildProfitLockCard({ symbol: "POPCAT", posId: 3, gainPct: 65, withdrawnSol: 0.11 })],
    ["account", () => buildAccountCard({ acctSol: 0.8, acctPct: 8, walletSol: 6, inPositionsSol: 2, baselineSol: 10, closedCount: 5, realizedSol: 1 })],
    ["jev_decision", () => buildJevDecisionCard({ symbol: "MEW", verdict: "uncertain", redFlagMax: 0.5, composite: 0.5, keyAnswers: [{ q: "flow", a: "mixed" }] })],
    ["ape_opened", () => buildApeOpenedCard({ symbol: "PNUT", posId: 4, sizeSol: 0.9, multiple: 3, play: "Eys ape" })],
    ["ape_closed", () => buildApeClosedCard({ symbol: "PNUT", posId: 4, pnlSol: -0.08, pnlPct: -9, multiple: 3 })],
    ["skip_summary", () => buildSkipSummaryCard({ windowLabel: "6h", skipped: 10, topReasons: [{ reason: "low_score", count: 6 }] })],
    ["reconcile_orphan", () => buildReconcileCard({ orphaned: ["WIF pos#1"], adopted: [] })],
    ["reconcile_warning", () => buildReconcileCard({ orphaned: [], adopted: [], warning: "chain read returned 0" })],
    ["error", () => buildErrorCard("swap failed", "jupiter 422")],
    ["warning", () => buildWarningCard("rpc degraded", "3 timeouts")],
    ["startup", () => buildStartupCard("live", "0 open positions")],
    ["truth_pnl_daily", () => buildTruthPnlCard({ equitySol: 10.8, netDepositsSol: 10, pnlSol: 0.8, pnlPct: 8, unexplainedOutflowSol: 0, history: [9.8, 10, 10.2, 10.8] })],
    ["truth_pnl_outflow", () => buildTruthPnlCard({ equitySol: 9, netDepositsSol: 10, pnlSol: -1, pnlPct: -10, unexplainedOutflowSol: 0.3 })],
    ["fallback", () => buildFallbackCard("info", "something unparsed\nmore detail")],
  ];

  for (const [name, make] of samples) {
    it(`${name} produces a valid PNG`, async () => {
      const { spec } = make();
      const node = buildCardNode(spec);
      const png = await renderCardPng(node);
      expectValidPng(png);
    });
  }
});

describe("parseAlertToCard", () => {
  it("parses a real entry alert message into an opened card", () => {
    const built = parseAlertToCard("entry", "WIF pos#4821: entered 0.42 SOL @ 0.0003841 (score 78/base 70, range depth 32%)\nchart: https://gmgn.ai/x");
    expect(built.spec.kindLabel).toBe("OPENED");
    expect(built.spec.title).toBe("WIF");
    expect(built.caption).toContain("WIF");
  });

  it("parses a real close alert message into a closed card", () => {
    const msg = "WIF pos#4821 closed — profit target\nPnL: +0.0612 SOL (+14.6%)\nentry 0.420 → exit 0.481 SOL | fees 0.0038 SOL | held 2h14m";
    const built = parseAlertToCard("close", msg);
    expect(built.spec.kindLabel).toBe("CLOSED");
    expect(built.spec.bigValueColor).toBeDefined();
  });

  it("falls back to a generic card for unparseable text", () => {
    const built = parseAlertToCard("watchdog", "some brand new message shape nobody wrote a parser for");
    expect(built.spec.kindLabel).toBe("WATCHDOG");
    expect(built.caption).toContain("watchdog");
  });

  it("falls back for empty/garbage input without throwing", () => {
    expect(() => parseAlertToCard("close", "")).not.toThrow();
    expect(() => parseAlertToCard("entry", "pos#NaN entered abc SOL")).not.toThrow();
  });

  it("every fallback card still renders a valid PNG", async () => {
    const built = parseAlertToCard("displacement", "unparsed displacement text");
    const node = buildCardNode(built.spec);
    const png = await renderCardPng(node);
    expectValidPng(png);
  });
});
