/**
 * Live-churn fix (owner, 2026-10-02): positions 1-6 (all danko_trap, COCKROACH/
 * HOOKED) each opened a SOL-side ladder below price, price ran away before the
 * ladder ever filled, upstream's generic P3_above "missed" case closed them at
 * 0 fees every ~18min, and the bot immediately re-opened the same token — 5
 * cycles, -0.0085 SOL + 5 stranded empty token accounts. These tests cover the
 * fix: combo positions are managed ONLY by comboExitCheck + P0, a new idle
 * timeout closes a ladder that genuinely never filled, and a per-mint cooldown
 * stops the immediate re-entry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../scanner/scan.js", () => ({ scan: vi.fn(async () => ({ candidates: [], rejected: [], sweptPools: 0 })) }));
// P0's rugcheck-flip check hits a real network call when a position is
// in-range; none of these tests are exercising P0, so keep it inert.
vi.mock("../vetting/rugcheck.js", () => ({ fetchSummary: vi.fn(async () => null) }));

import { managePositions, resetManagerStateForTests } from "./loop.js";
import { FakeExecutor } from "../test/fakeExecutor.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb, insertOpenPosition } from "../test/db.js";
import { getDb, isBlacklisted, now } from "../db/db.js";

describe("combo exclusivity — upstream P3_above never closes a combo position", () => {
  let exec: FakeExecutor;

  beforeEach(() => {
    useMemoryDb();
    resetManagerStateForTests();
    installConfig((c) => {
      c.combo!.enabled = true;
      c.combo!.danko_idle_max_h = 6;
      c.combo!.molu_idle_max_h = 2;
    });
    exec = new FakeExecutor("paper");
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.clearAllMocks();
  });

  it("a danko_trap ladder that ran above range is NOT closed by P3_above, even well past its sustain window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    const id = insertOpenPosition({ entrySol: 0.1, minBinId: -248, maxBinId: -132, entryTs: Math.floor(Date.now() / 1000) });
    getDb().prepare("UPDATE positions SET play = 'danko_trap' WHERE id = ?").run(id);
    exec.setMark(id, {
      valueSol: 0.1, price: 1.0, activeBinId: -132, aboveRange: true, inRange: false, belowRange: false, vol30mUsd: 999_999,
    });

    await managePositions(exec); // arms whatever timers upstream would use
    vi.setSystemTime(new Date("2026-10-02T12:45:00Z")); // well past above_range_missed_sustain_min (45m default)
    await managePositions(exec);

    expect(exec.closed.find((c) => c.id === id && c.reason === "P3_above")).toBeUndefined();
  });
});

describe("combo idle timeout — only fires when genuinely unfilled", () => {
  let exec: FakeExecutor;

  beforeEach(() => {
    useMemoryDb();
    resetManagerStateForTests();
    installConfig((c) => {
      c.combo!.enabled = true;
      c.combo!.danko_idle_max_h = 6;
      c.combo!.molu_idle_max_h = 2;
      c.combo!.reentry_cooldown_h = 3;
    });
    exec = new FakeExecutor("paper");
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.clearAllMocks();
  });

  it("closes with combo_idle_timeout once a never-filled danko_trap ladder ages past danko_idle_max_h", async () => {
    const entryTs = now() - 7 * 3600; // 7h old, past the 6h idle max
    const id = insertOpenPosition({ entrySol: 0.1, minBinId: -248, maxBinId: -132, entryTs });
    getDb().prepare("UPDATE positions SET play = 'danko_trap', ever_filled = 0 WHERE id = ?").run(id);
    exec.setMark(id, {
      // vol30mUsd high so comboExitCheck's flow-dead short-circuit (and its
      // Jev consult) never fires — this test isolates the idle timeout itself.
      valueSol: 0.1, price: 1.0, activeBinId: -132, aboveRange: true, inRange: false, belowRange: false, vol30mUsd: 999_999,
    });

    await managePositions(exec);

    expect(exec.closed).toEqual([{ id, reason: "combo_idle_timeout" }]);
  });

  it("does NOT fire the idle timeout once the ladder has actually filled, even past the window", async () => {
    const entryTs = now() - 7 * 3600;
    const id = insertOpenPosition({ entrySol: 0.1, minBinId: -248, maxBinId: -132, entryTs });
    getDb().prepare("UPDATE positions SET play = 'danko_trap', ever_filled = 1 WHERE id = ?").run(id);
    exec.setMark(id, {
      // Still in range, flow alive, below the TP target — comboExitCheck holds.
      valueSol: 0.1, price: 1.0, activeBinId: -200, aboveRange: false, inRange: true, belowRange: false, vol30mUsd: 999_999,
    });

    await managePositions(exec);

    expect(exec.closed.find((c) => c.id === id)).toBeUndefined();
  });

  it("does not fire before the idle window elapses", async () => {
    const entryTs = now() - 1 * 3600; // only 1h old
    const id = insertOpenPosition({ entrySol: 0.1, minBinId: -248, maxBinId: -132, entryTs });
    getDb().prepare("UPDATE positions SET play = 'danko_trap', ever_filled = 0 WHERE id = ?").run(id);
    exec.setMark(id, {
      valueSol: 0.1, price: 1.0, activeBinId: -132, aboveRange: true, inRange: false, belowRange: false, vol30mUsd: 999_999,
    });

    await managePositions(exec);

    expect(exec.closed.find((c) => c.id === id)).toBeUndefined();
  });
});

describe("combo re-entry cooldown", () => {
  let exec: FakeExecutor;

  beforeEach(() => {
    useMemoryDb();
    resetManagerStateForTests();
    installConfig((c) => {
      c.combo!.enabled = true;
      c.combo!.danko_idle_max_h = 6;
      c.combo!.molu_idle_max_h = 2;
      c.combo!.reentry_cooldown_h = 3;
    });
    exec = new FakeExecutor("paper");
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.clearAllMocks();
  });

  it("blocks re-entry on the mint after an idle-timeout (never-filled) close", async () => {
    const entryTs = now() - 7 * 3600;
    const id = insertOpenPosition({ entrySol: 0.1, minBinId: -248, maxBinId: -132, entryTs });
    getDb().prepare("UPDATE positions SET play = 'danko_trap', ever_filled = 0 WHERE id = ?").run(id);
    exec.setMark(id, {
      valueSol: 0.1, price: 1.0, activeBinId: -132, aboveRange: true, inRange: false, belowRange: false, vol30mUsd: 999_999,
    });

    await managePositions(exec);

    expect(exec.closed).toEqual([{ id, reason: "combo_idle_timeout" }]);
    expect(isBlacklisted("mint1")).not.toBeNull();
  });
});
