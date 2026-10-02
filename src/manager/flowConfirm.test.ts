/**
 * Combo flow-death confirmation (owner, 2026-10-03): pos#7 OCTO was closed on
 * ONE tick of vol30m=4834 < 5000. The raw condition must now hold continuously
 * for combo.flow_dead_confirm_min (3) before the exit may fire.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../scanner/scan.js", () => ({ scan: vi.fn(async () => ({ candidates: [], rejected: [], sweptPools: 0 })) }));
vi.mock("../vetting/rugcheck.js", () => ({ fetchSummary: vi.fn(async () => null) }));

import { managePositions, resetManagerStateForTests, flowConfirmed } from "./loop.js";
import { FakeExecutor } from "../test/fakeExecutor.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb, insertOpenPosition } from "../test/db.js";
import { getDb } from "../db/db.js";

describe("flowConfirmed", () => {
  it("arms on the first true tick, fires only after confirmS, and resets when the condition clears", () => {
    const t = new Map<number, number>();
    expect(flowConfirmed(t, 1, true, 1000, 180)).toBe(false);   // armed
    expect(flowConfirmed(t, 1, true, 1100, 180)).toBe(false);   // 100s
    expect(flowConfirmed(t, 1, true, 1180, 180)).toBe(true);    // 180s held
    expect(flowConfirmed(t, 1, false, 1200, 180)).toBe(false);  // cleared, reset
    expect(flowConfirmed(t, 1, true, 1210, 180)).toBe(false);   // re-armed from scratch
    expect(flowConfirmed(t, 1, true, 1300, 180)).toBe(false);
  });
  it("confirmS=0 fires immediately", () => {
    expect(flowConfirmed(new Map(), 1, true, 1000, 0)).toBe(true);
  });
});

describe("combo flowDead exit needs 3 continuous minutes", () => {
  let exec: FakeExecutor;
  const T0 = new Date("2026-10-03T03:00:00Z");
  const lowFlow = { valueSol: 0.101, price: 1, activeBinId: 150, aboveRange: false, inRange: true, belowRange: false, vol30mUsd: 4834, tvlUsd: 100_000 };
  const okFlow = { ...lowFlow, vol30mUsd: 50_000 };

  beforeEach(() => {
    useMemoryDb();
    resetManagerStateForTests();
    installConfig((c) => { c.combo!.enabled = true; c.combo!.flow_dead_confirm_min = 3; });
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    exec = new FakeExecutor("paper");
  });
  afterEach(() => { vi.useRealTimers(); resetTestDb(); restoreConfig(); vi.clearAllMocks(); });

  function openSeat() {
    const id = insertOpenPosition({ entrySol: 0.1, entryTs: Math.floor(T0.getTime() / 1000) - 600 });
    getDb().prepare("UPDATE positions SET play='eys_seat', ever_filled=1 WHERE id=?").run(id);
    return id;
  }

  it("a single low-volume tick does NOT close (pos#7's exact failure)", async () => {
    const id = openSeat();
    exec.setMark(id, lowFlow);
    await managePositions(exec);
    expect(exec.closed).toHaveLength(0);
  });

  it("closes once the low-volume condition has held for 3 minutes", async () => {
    const id = openSeat();
    exec.setMark(id, lowFlow);
    await managePositions(exec);
    vi.setSystemTime(new Date(T0.getTime() + 2 * 60_000));
    await managePositions(exec);
    expect(exec.closed).toHaveLength(0);
    vi.setSystemTime(new Date(T0.getTime() + 3 * 60_000 + 1000));
    await managePositions(exec);
    expect(exec.closed).toEqual([{ id, reason: "combo_exit" }]);
  });

  it("a recovery tick resets the timer: 2 min low, 1 min ok, 2 min low does not close", async () => {
    const id = openSeat();
    exec.setMark(id, lowFlow);
    await managePositions(exec);
    vi.setSystemTime(new Date(T0.getTime() + 2 * 60_000));
    await managePositions(exec);
    exec.setMark(id, okFlow);
    vi.setSystemTime(new Date(T0.getTime() + 3 * 60_000));
    await managePositions(exec);
    exec.setMark(id, lowFlow);
    vi.setSystemTime(new Date(T0.getTime() + 4 * 60_000));
    await managePositions(exec);
    vi.setSystemTime(new Date(T0.getTime() + 5 * 60_000));
    await managePositions(exec);
    expect(exec.closed).toHaveLength(0);
  });
});
