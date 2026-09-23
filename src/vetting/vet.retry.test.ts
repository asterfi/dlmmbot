import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { vetWithRetry } from "./vet.js";
import { fetchReport, type RugcheckReport as Report } from "./rugcheck.js";
import { fetchTokenFacts } from "./onchain.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { useMemoryDb, resetTestDb } from "../test/db.js";

// Live evidence 2026-09-22/23 (loop.ts `enter · vet_error`): a transient
// Helius 429 inside the vet pipeline escaped as a throw and cost the whole
// entry for that candidate (PAID x2, ALLINU). vetToken is read-only, so the
// enter path now retries transient rate-limit/connect blips through the same
// bounded withRpcRetry the wallet path uses — and only transient ones.

vi.mock("./onchain.js", () => ({ fetchTokenFacts: vi.fn() }));
vi.mock("./rugcheck.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rugcheck.js")>()),
  fetchReport: vi.fn(),
}));
vi.mock("./jupdata.js", () => ({ jupAsset: vi.fn(async () => null) }));
vi.mock("../scanner/gmgn.js", () => ({
  tokenSecurity: vi.fn(async () => null),
  tokenTraderTags: vi.fn(async () => null),
}));

const MINT = "Tok1111111111111111111111111111111111111";
const THREE_H_AGO = Date.now() - 3 * 3600_000;

const factsMock = vi.mocked(fetchTokenFacts);
const reportMock = vi.mocked(fetchReport);

function onchainFacts() {
  return {
    mintAuthority: null,
    freezeAuthority: null,
    tokenProgram: "spl-token",
    token2022Extensions: [],
    supplyRaw: 1_000_000_000,
    decimals: 6,
    largestAccounts: [],
  };
}

function rugReport(): Report {
  return {
    score: 0,
    score_normalised: 10,
    risks: [],
    creator: "Cr1111111111111111111111111111111111111",
    creatorTokens: null,
    rugged: false,
    graphInsidersDetected: 0,
    insiderNetworks: null,
    totalHolders: 500,
    totalLPProviders: 10,
    totalMarketLiquidity: 1e6,
    launchpad: null,
    topHolders: [
      { address: "H1", owner: "H1", pct: 5, insider: false },
      { address: "H2", owner: "H2", pct: 3, insider: false },
    ],
    markets: null,
    detectedAt: new Date(THREE_H_AGO).toISOString(),
  };
}

describe("vetWithRetry transient recovery", () => {
  beforeEach(() => {
    useMemoryDb();
    installConfig();
    factsMock.mockReset().mockResolvedValue(onchainFacts());
    reportMock.mockReset().mockResolvedValue(rugReport());
  });
  afterEach(() => {
    restoreConfig();
    resetTestDb();
  });

  it("recovers an entry when the pipeline throws one transient 429", async () => {
    reportMock
      .mockRejectedValueOnce(Object.assign(new Error("429 Too Many Requests: Too Many Requests"), { status: 429 }))
      .mockResolvedValue(rugReport());
    const r = await vetWithRetry(MINT, THREE_H_AGO, { attempts: 3, delaysMs: [1, 1] });
    expect(r.verdict).toBe("pass");
    expect(reportMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the bounded attempts on a persistent 429", async () => {
    reportMock.mockRejectedValue(
      Object.assign(new Error("429 Too Many Requests"), { status: 429 }),
    );
    await expect(vetWithRetry(MINT, THREE_H_AGO, { attempts: 3, delaysMs: [1, 1] })).rejects.toThrow("429");
    expect(reportMock).toHaveBeenCalledTimes(3);
  });

  it("never retries a domain error", async () => {
    reportMock.mockRejectedValue(new Error("invalid account data"));
    await expect(vetWithRetry(MINT, THREE_H_AGO, { attempts: 3, delaysMs: [1, 1] })).rejects.toThrow("invalid account data");
    expect(reportMock).toHaveBeenCalledTimes(1);
  });
});
