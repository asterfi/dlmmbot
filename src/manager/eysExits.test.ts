/**
 * Manager-side rules for Eys positions (owner, 2026-10-03):
 *  - combo positions are managed ONLY by comboExitCheck + P0 (upstream P3_above etc. never close them)
 *  - the P0 price-crash trigger is NOT a stop-loss for combo positions (other P0 triggers still apply)
 *  - eys_seat idle: above its range 20 min with no breakout leg open -> eys_seat_idle
 *  - eys_dump_bonus never-filled timeout
 *  - legacy plays (molu_ladder / danko_trap rows) load as read-only labels and fall to the upstream engine
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../scanner/scan.js", () => ({ scan: vi.fn(async () => ({ candidates: [], rejected: [], sweptPools: 0 })) }));
vi.mock("../vetting/rugcheck.js", () => ({ fetchSummary: vi.fn(async () => null) }));

import { managePositions, resetManagerStateForTests } from "./loop.js";
import { FakeExecutor } from "../test/fakeExecutor.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb, insertOpenPosition } from "../test/db.js";
import { getDb, isBlacklisted } from "../db/db.js";

const T0 = new Date("2026-10-03T06:00:00Z");
const minutes = (m: number) => new Date(T0.getTime() + m * 60_000);

beforeEach(() => {
  useMemoryDb();
  resetManagerStateForTests();
  installConfig((c) => {
    c.combo!.enabled = true;
    c.combo!.eys_seat_idle_above_min = 20;
    c.combo!.eys_dump_idle_max_h = 2;
    c.combo!.reentry_cooldown_h = 3;
  });
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => { vi.useRealTimers(); resetTestDb(); restoreConfig(); vi.clearAllMocks(); });

function openPos(play: string | null, over: { entrySol?: number; everFilled?: number; ageMin?: number; mint?: string } = {}): number {
  const id = insertOpenPosition({
    entrySol: over.entrySol ?? 0.1,
    entryTs: Math.floor(T0.getTime() / 1000) - (over.ageMin ?? 1) * 60,
  });
  getDb().prepare("UPDATE positions SET play = ?, ever_filled = ?, token_mint = COALESCE(?, token_mint) WHERE id = ?")
    .run(play, over.everFilled ?? 0, over.mint ?? null, id);
  return id;
}
const aboveMark = { valueSol: 0.1, price: 1.3, activeBinId: 300, aboveRange: true, inRange: false, belowRange: false, vol30mUsd: 999_999, tvlUsd: 100_000 };
/** Price still at the ladder's top bin (nothing converted): activeBinId == the position's max bin (200). */
const topBinMark = { valueSol: 0.1, price: 1.0, activeBinId: 200, aboveRange: false, inRange: true, belowRange: false, vol30mUsd: 999_999, tvlUsd: 100_000 };
const inRangeMark = { valueSol: 0.1, price: 1.0, activeBinId: 150, aboveRange: false, inRange: true, belowRange: false, vol30mUsd: 999_999, tvlUsd: 100_000 };

describe("upstream P3_above never closes a combo position", () => {
  it("an eys_seat that ran above range is not closed by P3_above, even far past its sustain windows", async () => {
    const exec = new FakeExecutor("paper");
    const id = openPos("eys_seat");
    exec.setMark(id, aboveMark);
    await managePositions(exec);
    vi.setSystemTime(minutes(19)); // under the 20-minute idle rule, over every upstream sustain window
    await managePositions(exec);
    expect(exec.closed).toHaveLength(0);
    expect(exec.closed.find((c) => c.reason === "P3_above")).toBeUndefined();
  });
});

describe("P0 price-crash is not a stop-loss for combo positions", () => {
  // insertOpenPosition entry price 1 -> 0.3 is -70% (threshold -60%)
  const crash = { valueSol: 0.03, price: 0.3, activeBinId: 150, aboveRange: false, inRange: true, belowRange: false, vol30mUsd: 999_999, tvlUsd: 100_000 };

  it("a combo position at -70% is NOT closed by the crash trigger; the skip is logged once", async () => {
    const exec = new FakeExecutor("paper");
    const id = openPos("eys_breakout");
    exec.setMark(id, crash);
    await managePositions(exec);
    await managePositions(exec);
    expect(exec.closed).toHaveLength(0);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM decisions WHERE failed_gate='p0_crash_skipped_combo'").get()).toEqual({ c: 1 });
  });
  it("the same position is still closed by another P0 trigger (pool death)", async () => {
    const exec = new FakeExecutor("paper");
    const id = openPos("eys_breakout");
    exec.setMark(id, { ...crash, valueSol: 0 });
    await managePositions(exec);
    expect(exec.closed).toEqual([{ id, reason: "P0_safety" }]);
  });
  it("a NON-combo position at -70% is still crash-closed", async () => {
    const exec = new FakeExecutor("paper");
    const id = openPos(null);
    exec.setMark(id, crash);
    await managePositions(exec);
    expect(exec.closed).toEqual([{ id, reason: "P0_safety" }]);
  });
});

describe("eys_seat idle: above range 20 minutes with no breakout leg open", () => {
  it("closes as eys_seat_idle after 20 continuous minutes above range", async () => {
    const exec = new FakeExecutor("paper");
    const id = openPos("eys_seat");
    exec.setMark(id, aboveMark);
    await managePositions(exec);
    vi.setSystemTime(minutes(19));
    await managePositions(exec);
    expect(exec.closed).toHaveLength(0);
    vi.setSystemTime(new Date(T0.getTime() + 20 * 60_000 + 1000));
    await managePositions(exec);
    expect(exec.closed).toEqual([{ id, reason: "eys_seat_idle" }]);
    expect(isBlacklisted("mint1")).not.toBeNull();
  });

  it("a dip back into range resets the 20-minute clock", async () => {
    const exec = new FakeExecutor("paper");
    const id = openPos("eys_seat");
    exec.setMark(id, aboveMark);
    await managePositions(exec);
    vi.setSystemTime(minutes(15));
    exec.setMark(id, inRangeMark);
    await managePositions(exec);
    vi.setSystemTime(minutes(18));
    exec.setMark(id, aboveMark);
    await managePositions(exec);
    vi.setSystemTime(minutes(30)); // only 12 min since re-arming
    await managePositions(exec);
    expect(exec.closed).toHaveLength(0);
  });

  it("while a breakout leg is open on the SAME mint the seat stays as the backup", async () => {
    const exec = new FakeExecutor("paper");
    const seat = openPos("eys_seat");
    const breakout = openPos("eys_breakout");
    exec.setMark(seat, aboveMark);
    exec.setMark(breakout, { ...inRangeMark, price: 1.3 });
    await managePositions(exec);
    vi.setSystemTime(minutes(45));
    await managePositions(exec);
    expect(exec.closed.find((c) => c.id === seat)).toBeUndefined();
  });

  it("once the breakout closes the rule applies at once (the 20 minutes above range already elapsed)", async () => {
    const exec = new FakeExecutor("paper");
    const seat = openPos("eys_seat");
    const breakout = openPos("eys_breakout");
    exec.setMark(seat, aboveMark);
    exec.setMark(breakout, { ...inRangeMark, price: 1.3 });
    await managePositions(exec);
    vi.setSystemTime(minutes(30));
    await managePositions(exec);
    expect(exec.closed.find((c) => c.id === seat)).toBeUndefined();
    getDb().prepare("UPDATE positions SET state = 'closed_rotation' WHERE id = ?").run(breakout);
    await managePositions(exec);
    expect(exec.closed.find((c) => c.id === seat)?.reason).toBe("eys_seat_idle");
  });

  it("a seat in range is never idle", async () => {
    const exec = new FakeExecutor("paper");
    const id = openPos("eys_seat");
    exec.setMark(id, inRangeMark);
    await managePositions(exec);
    vi.setSystemTime(minutes(120));
    await managePositions(exec);
    expect(exec.closed).toHaveLength(0);
  });

  it("an idle breakout/tight leg is not subject to the seat rule", async () => {
    const exec = new FakeExecutor("paper");
    const id = openPos("eys_tight");
    exec.setMark(id, aboveMark);
    await managePositions(exec);
    vi.setSystemTime(minutes(60));
    await managePositions(exec);
    expect(exec.closed.find((c) => c.reason === "eys_seat_idle")).toBeUndefined();
  });
});

describe("eys_dump_bonus never-filled timeout", () => {
  it("closes a never-filled bonus ladder after eys_dump_idle_max_h", async () => {
    const exec = new FakeExecutor("paper");
    const id = openPos("eys_dump_bonus", { ageMin: 3 * 60 });
    exec.setMark(id, topBinMark);
    await managePositions(exec);
    expect(exec.closed).toEqual([{ id, reason: "combo_idle_timeout" }]);
  });
  it("does not close a filled ladder, or one inside the window", async () => {
    const exec = new FakeExecutor("paper");
    const filled = openPos("eys_dump_bonus", { ageMin: 3 * 60, everFilled: 1 });
    const young = openPos("eys_dump_bonus", { ageMin: 30, mint: "mintY" });
    exec.setMark(filled, inRangeMark);
    exec.setMark(young, topBinMark);
    await managePositions(exec);
    expect(exec.closed).toHaveLength(0);
  });
});

describe("legacy plays are labels only", () => {
  it("a historical molu_ladder / danko_trap row loads as a non-combo position (upstream engine), without crashing", async () => {
    const exec = new FakeExecutor("paper");
    const molu = openPos("molu_ladder");
    const danko = openPos("danko_trap", { mint: "mintD" });
    exec.setMark(molu, inRangeMark);
    exec.setMark(danko, inRangeMark);
    await expect(managePositions(exec)).resolves.not.toThrow();
    // the row keeps its label in the DB
    const row = getDb().prepare("SELECT play FROM positions WHERE id = ?").get(molu) as { play: string };
    expect(row.play).toBe("molu_ladder");
  });
});
