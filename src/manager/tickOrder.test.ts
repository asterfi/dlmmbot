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

  it("gates the sweep on its own interval, not on tick age", () => {
    const sweepAt = loopSrc.indexOf("exec.sweepResiduals &&");
    // End of the sweep block, before the entry scan's own tick-age guard —
    // that guard is legitimate (it exists to keep mark gaps bounded) and must
    // not be dragged into this assertion.
    const sweepBlockEnd = loopSrc.indexOf("const due = scanDue(");
    expect(sweepBlockEnd, "sweep block end marker missing").toBeGreaterThan(sweepAt);
    const between = loopSrc.slice(sweepAt, sweepBlockEnd);
    // Reordering alone could not make `tickStart < pollMs` reachable: the
    // ~96 lines before the sweep (marks, escapes, claims, mode sync) already
    // exceed the 20s poll budget on a normal tick, so the sweep ran only when
    // a tick happened to be fast. Live evidence: 211 deferrals against 1
    // successful sweep, so stranded residue and empty-ATA rent sat unsold.
    expect(
      between,
      "sweep must not be gated on Date.now() - tickStart (unreachable on normal ticks)"
    ).not.toContain("tickStart < pollMs");
    // Its own 10-minute cadence stays the only throttle.
    expect(between, "sweep must remain interval-throttled").toContain(
      "RESIDUAL_SWEEP_INTERVAL_MS"
    );
  });
});
