import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const loopSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "loop.ts"), "utf8");

/**
 * The periodic residual sweep is gated on `Date.now() - tickStart < pollMs`
 * (poll_s = 20 -> 20s), but it sat AFTER `enterNewPositions`, which reliably
 * eats ~70s of every tick. The tick age could therefore never be under the
 * budget by the time the guard was evaluated: the live log recorded 204
 * `deferring residual sweep` lines and 0 actual sweeps, so stranded residue
 * and the 0.00204 SOL empty-ATA rent were never reclaimed by this path.
 *
 * Ordering is the invariant that makes the guard reachable, and the runtime
 * harness cannot drive `runLoop` tick-by-tick, so it is pinned at the source
 * level: the sweep block must be evaluated before the entry scan.
 */
describe("tick phase order — residual sweep reachability", () => {
  it("evaluates the residual sweep before the entry scan", () => {
    const sweepAt = loopSrc.indexOf("exec.sweepResiduals &&");
    const scanAt = loopSrc.indexOf("await enterNewPositions(");
    expect(sweepAt, "sweep guard missing from loop.ts").toBeGreaterThan(-1);
    expect(scanAt, "entry scan missing from loop.ts").toBeGreaterThan(-1);
    expect(sweepAt, "residual sweep must run before the entry scan eats the tick budget").toBeLessThan(scanAt);
  });

  it("keeps the sweep fail-soft so a cleanup RPC error cannot skip the scan", () => {
    const sweepAt = loopSrc.indexOf("exec.sweepResiduals &&");
    const scanAt = loopSrc.indexOf("await enterNewPositions(");
    const between = loopSrc.slice(sweepAt, scanAt);
    expect(between, "sweep call must be wrapped in its own try/catch").toContain("catch");
  });
});
