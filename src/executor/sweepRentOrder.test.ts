import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const liveSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "live.ts"), "utf8");

/**
 * `sweepResiduals` reclaimed empty-ATA rent — but only for mints already in
 * `positions`, because the `known` guard sat ABOVE the empty-account branch.
 * An exit swap that routed through an untraded hop mint therefore created an
 * ATA we never held a position in, and the rent was skipped forever: it was
 * paid out of that swap's proceeds, so the exit read -88% against its quote
 * while the chain showed the pool paying in full. Two of 39 exits stranded
 * 3 ATAs / 0.004465320 SOL exactly this way.
 *
 * Ordering is the invariant, and the sweep needs a live RPC connection +
 * wallet to drive, so it is pinned at source level (same convention as
 * `manager/tickOrder.test.ts`): the empty-account branch must be reachable
 * before any known-mint filter is consulted.
 */
describe("residual sweep — empty-ATA rent reachability", () => {
  const EMPTY_BRANCH = 'if (info.tokenAmount.amount === "0")';
  const KNOWN_GUARD = "if (!known.has(info.mint)) continue;";
  const SELL_RAW = "const raw = BigInt(info.tokenAmount.amount);";

  it("tests the empty-account branch BEFORE the known-mint guard", () => {
    const knownAt = liveSrc.indexOf(KNOWN_GUARD);
    const emptyAt = liveSrc.indexOf(EMPTY_BRANCH);
    expect(knownAt, "known-mint guard missing from live.ts").toBeGreaterThan(-1);
    expect(emptyAt, "empty-account branch missing from live.ts").toBeGreaterThan(-1);
    expect(
      emptyAt,
      "the known-mint guard sits above the empty branch: an empty ATA for a mint we never "
      + "held a position in is skipped, so its rent is never reclaimed (this is what stranded "
      + "0.004465320 SOL across 4 ATAs)",
    ).toBeLessThan(knownAt);
  });

  it("keeps the sell path gated on a known mint — airdrop spam is never sold", () => {
    const knownAt = liveSrc.indexOf(KNOWN_GUARD);
    const sellAt = liveSrc.indexOf(SELL_RAW);
    expect(knownAt, "known-mint guard missing from live.ts").toBeGreaterThan(-1);
    expect(sellAt, "sell path missing from live.ts").toBeGreaterThan(-1);
    // Moving the guard below the empty branch must not also move it past the
    // sell: a non-zero balance in an untraded mint is still spam, never sold.
    expect(knownAt, "the known-mint guard must still precede the sell").toBeLessThan(sellAt);
  });

  it("never closes the wSOL ATA, whose rent only churns if reclaimed", () => {
    const emptyAt = liveSrc.indexOf(EMPTY_BRANCH);
    const sellAt = liveSrc.indexOf(SELL_RAW);
    expect(emptyAt, "empty-account branch missing from live.ts").toBeGreaterThan(-1);
    expect(sellAt, "sell path missing from live.ts").toBeGreaterThan(-1);
    const branch = liveSrc.slice(emptyAt, sellAt);
    // `unwrapWsol()` drains wSOL but deliberately leaves the ATA standing; the
    // next zap-path swap recreates it, so closing it re-pays 0.001488440 of
    // rent out of that swap's proceeds on a ~144/day loop.
    expect(branch, "empty branch must explicitly spare SOL_MINT").toContain("SOL_MINT");
  });

  it("still routes the close through mintIsIdle so open positions are spared", () => {
    const emptyAt = liveSrc.indexOf(EMPTY_BRANCH);
    const sellAt = liveSrc.indexOf(SELL_RAW);
    expect(emptyAt, "empty-account branch missing from live.ts").toBeGreaterThan(-1);
    expect(sellAt, "sell path missing from live.ts").toBeGreaterThan(-1);
    const branch = liveSrc.slice(emptyAt, sellAt);
    expect(branch, "mintIsIdle is the guard that keeps an open position's ATA alive").toContain(
      "this.mintIsIdle",
    );
    expect(branch, "the close must stay behind that guard").toContain("closable.push");
  });
});
