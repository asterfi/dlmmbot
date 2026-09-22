import { describe, expect, it } from "vitest";
import { allocateTokenSideChunks, attributedTokenDelta, positiveTokenDelta } from "./tokenFunding.js";

describe("token-side funding primitives", () => {
  it("accepts only a positive post-swap token delta", () => {
    expect(positiveTokenDelta(10n, 37n)).toBe(27n);
  });

  it("rejects a missing, negative, or zero attributable delta", () => {
    expect(() => positiveTokenDelta(37n, 37n)).toThrow(/no attributable token delta/i);
    expect(() => positiveTokenDelta(37n, 10n)).toThrow(/token balance decreased/i);
  });

  it("allocates token-side Spot chunks from the active bin upward", () => {
    expect(allocateTokenSideChunks(100, 140)).toEqual([
      { min: 100, max: 140, share: 1 },
    ]);
    expect(allocateTokenSideChunks(100, 210)).toEqual([
      { min: 100, max: 168, share: 69 / 111 },
      { min: 169, max: 210, share: 42 / 111 },
    ]);
  });

  it("rejects a token range that does not extend above the active bin", () => {
    expect(() => allocateTokenSideChunks(100, 100)).toThrow(/must extend above/i);
    expect(() => allocateTokenSideChunks(100, 99)).toThrow(/must extend above/i);
  });

  it("attributes only the wallet's token delta from the confirmed swap", () => {
    expect(attributedTokenDelta(
      [
        { mint: "MINT", owner: "WALLET", uiTokenAmount: { amount: "10" } },
        { mint: "MINT", owner: "OTHER", uiTokenAmount: { amount: "100" } },
      ],
      [
        { mint: "MINT", owner: "WALLET", uiTokenAmount: { amount: "37" } },
        { mint: "MINT", owner: "OTHER", uiTokenAmount: { amount: "100" } },
      ],
      "WALLET",
      "MINT",
    )).toBe(27n);
  });

  it("rejects transaction token balances without owner attribution", () => {
    expect(() => attributedTokenDelta(
      [{ mint: "MINT", uiTokenAmount: { amount: "1" } }],
      [{ mint: "MINT", uiTokenAmount: { amount: "2" } }],
      "WALLET",
      "MINT",
    )).toThrow(/owner attribution/i);
  });
});
