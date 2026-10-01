import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { vetToken, _resetVetCacheForTests } from "./vet.js";
import { fetchTokenFacts } from "./onchain.js";
import { fetchReport } from "./rugcheck.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb } from "../test/db.js";

vi.mock("./onchain.js", () => ({ fetchTokenFacts: vi.fn() }));
vi.mock("./rugcheck.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rugcheck.js")>()),
  fetchReport: vi.fn(async () => null),
}));
vi.mock("./jupdata.js", () => ({ jupAsset: vi.fn(async () => null) }));
vi.mock("../scanner/gmgn.js", () => ({
  tokenSecurity: vi.fn(async () => null),
  tokenTraderTags: vi.fn(async () => null),
}));

const MINT = "Tok1111111111111111111111111111111111111";

describe("vetToken per-mint cache (2026-10-02)", () => {
  beforeEach(() => {
    useMemoryDb();
    _resetVetCacheForTests();
    installConfig((c) => { c.vetting.cache_ttl_s = 600; c.vetting.holder_gate_enabled = false; });
    vi.mocked(fetchTokenFacts).mockReset().mockResolvedValue({
      mintAuthority: null, freezeAuthority: null, tokenProgram: "spl-token",
      token2022Extensions: [], supplyRaw: 1e9, decimals: 6, largestAccounts: [],
    });
    vi.mocked(fetchReport).mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("serves a second vet of the same mint from cache — no new RPC/RugCheck calls", async () => {
    const first = await vetToken(MINT, Date.now() - 3 * 3600_000);
    const second = await vetToken(MINT, Date.now() - 3 * 3600_000);
    expect(second).toBe(first); // same object: a real cache hit, not just equal values
    expect(fetchTokenFacts).toHaveBeenCalledTimes(1);
    expect(fetchReport).toHaveBeenCalledTimes(1);
  });

  it("re-vets once the TTL has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    await vetToken(MINT, Date.now() - 3 * 3600_000);
    vi.setSystemTime(new Date("2026-10-02T00:10:01Z")); // 600s + 1s
    await vetToken(MINT, Date.now() - 3 * 3600_000);
    expect(fetchTokenFacts).toHaveBeenCalledTimes(2);
  });

  it("does not cache across different mints", async () => {
    await vetToken(MINT, Date.now());
    await vetToken("Tok2222222222222222222222222222222222222", Date.now());
    expect(fetchTokenFacts).toHaveBeenCalledTimes(2);
  });

  it("cache_ttl_s = 0 disables caching — every call re-vets", async () => {
    installConfig((c) => { c.vetting.cache_ttl_s = 0; c.vetting.holder_gate_enabled = false; });
    await vetToken(MINT, Date.now());
    await vetToken(MINT, Date.now());
    expect(fetchTokenFacts).toHaveBeenCalledTimes(2);
  });
});
