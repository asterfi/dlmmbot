import { describe, it, expect, beforeEach } from "vitest";
import {
  gmgnSpendOk, gmgnRecentCallSummary, gmgnPaceState,
  _gmgnEnterBanForTests, _resetGmgnPaceForTests,
} from "./gmgn.js";

describe("burst spreading (owner, 2026-10-03)", () => {
  beforeEach(() => { _resetGmgnPaceForTests(); });

  it("optional enrichments are allowed at throttle L0", () => {
    expect(gmgnPaceState().throttleLevel).toBe(0);
    expect(gmgnSpendOk(5, "token", { optional: true })).toBe(true);
  });

  it("optional enrichments yield entirely once throttle >= L1, even after the ban itself has expired", async () => {
    _gmgnEnterBanForTests(Date.now() + 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(gmgnPaceState().throttleLevel).toBeGreaterThanOrEqual(1);
    expect(gmgnSpendOk(5, "token", { optional: true })).toBe(false);
  });

  it("the call summary reports 'none' with an empty ring", () => {
    expect(gmgnRecentCallSummary()).toBe("none");
  });
});
