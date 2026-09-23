import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VetResult } from "../types.js";

vi.mock("./vet.js", () => ({ vetWithRetry: vi.fn() }));

import { vetWithRetry } from "./vet.js";
import { resetVetCacheForTests, vetCached } from "./vetCache.js";

const mocked = vi.mocked(vetWithRetry);
const pass: VetResult = { mint: "MINT1", verdict: "pass", hardFailures: [], softScore: 71, facts: {} } as never;

// Cross-cycle vet cache: the enter path re-vets every recurring candidate each
// ~65s cycle, and vet's Helius cluster scan (paced 130ms x ~26 calls) costs
// ~3-4s. That latency sits BEFORE the stale-quote guard, so it inflates measured
// drift and was pushing quote_stale skips to 10/hr. Caching a passing vet for a
// few cycles cuts the scan->enter window without weakening any safety gate.
describe("vetCached (latency cache for the enter path)", () => {
  beforeEach(() => {
    mocked.mockReset();
    resetVetCacheForTests();
  });

  it("vets once, then serves the second cycle from cache", async () => {
    mocked.mockResolvedValue(pass);
    const first = await vetCached("MINT1", null, 1_000);
    const second = await vetCached("MINT1", null, 2_000);
    expect(first).toBe(pass);
    expect(second).toBe(pass);
    expect(mocked).toHaveBeenCalledTimes(1); // RED without cache: 2
  });

  it("re-vets after the TTL window so safety data cannot go stale", async () => {
    mocked.mockResolvedValue(pass);
    await vetCached("MINT1", null, 1_000);
    await vetCached("MINT1", null, 1_000 + 180_001); // past 180s
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("does not cache across different mints", async () => {
    mocked.mockResolvedValue(pass);
    await vetCached("MINT1", null, 1_000);
    await vetCached("MINT2", null, 2_000);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("never caches a throw — transient errors must retry next cycle", async () => {
    mocked.mockRejectedValueOnce(new Error("429")).mockResolvedValueOnce(pass);
    await expect(vetCached("MINT1", null, 1_000)).rejects.toThrow("429");
    await vetCached("MINT1", null, 2_000); // must re-invoke, not serve cached
    expect(mocked).toHaveBeenCalledTimes(2);
  });
});
