import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { fetchPool } from "../scanner/meteora.js";
import { getDb } from "../db/db.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { resetTestDb, useMemoryDb } from "../test/db.js";
import { LiveExecutor } from "./live.js";
import { swapFromSol } from "./jupiter.js";
import type { OpenParams } from "./executor.js";

vi.mock("../scanner/meteora.js", () => ({
  fetchPool: vi.fn(),
}));

vi.mock("./jupiter.js", () => ({
  quoteToSolLamports: vi.fn(),
  signatureFromSwapError: (e: unknown) => {
    const value = e as { signature?: unknown; maybeSig?: unknown } | null;
    for (const candidate of [value?.signature, value?.maybeSig]) {
      if (typeof candidate === "string" && candidate.length > 0) return candidate;
    }
    return null;
  },
  swapFromSol: vi.fn(),
  swapToSolEscalating: vi.fn(),
}));

const TOKEN = "TokenMint111111111111111111111111111111111";
const OTHER_TOKEN = "OtherMint1111111111111111111111111111111";

function params(): OpenParams {
  return {
    poolAddress: "Pool111111111111111111111111111111111111",
    tokenMint: TOKEN,
    symbol: "TOK",
    sizeSol: 0.1,
    entryPrice: 1,
    fundingSide: "token",
    range: {
      minBinId: 100,
      maxBinId: 140,
      binCount: 41,
      positionAccounts: 1,
      bottomPricePct: 0,
      topPricePct: 40,
      shape: "spot",
      fibAnchor: null,
      estBinRentSol: 0.075,
    },
  };
}

function harness(): LiveExecutor {
  const pool = {
    lbPair: { activeId: 100, binStep: 100 },
    getActiveBin: vi.fn(async () => ({ binId: 100, price: "1" })),
    fromPricePerLamport: vi.fn(() => "1"),
    refetchStates: vi.fn(async () => undefined),
    initializePositionAndAddLiquidityByStrategy: vi.fn(async () => ({}) as never),
  };
  const executor = Object.create(LiveExecutor.prototype) as LiveExecutor;
  const unsafe = executor as unknown as Record<string, unknown>;
  unsafe.wallet = Keypair.generate();
  unsafe.connection = {};
  unsafe.pool = vi.fn(async () => pool);
  unsafe.tokenBalanceRaw = vi.fn(async () => 0n);
  unsafe.tokenDeltaFromConfirmedSwap = vi.fn(async () => 5_000n);
  unsafe.walletDelta = vi.fn(async () => -0.105);
  unsafe.send = vi.fn(async () => "deposit-sig");
  unsafe.ourLbPositions = vi.fn(async () => ({
    active: 100,
    priceYperX: 1,
    positions: [],
  }));
  return executor;
}

describe("token-side live open safety boundary", () => {
  beforeEach(() => {
    useMemoryDb();
    installConfig((c) => {
      c.exec.mode = "live";
      c.entry.tranche_enabled = true;
    });
    vi.mocked(fetchPool).mockResolvedValue({ mintX: TOKEN, binStep: 100 } as never);
    vi.mocked(swapFromSol).mockResolvedValue({ outAmountRaw: 5_000n, signature: "swap-sig" });
  });

  afterEach(() => {
    resetTestDb();
    restoreConfig();
    vi.clearAllMocks();
  });

  it("validates tokenX and deposits only attributed tokenX with zero SOL-side amount", async () => {
    const executor = harness();
    const position = await executor.open(params());
    const pool = (executor as unknown as { pool: ReturnType<typeof vi.fn> }).pool;
    const resolvedPool = await pool.mock.results[0]!.value;
    const deposit = resolvedPool.initializePositionAndAddLiquidityByStrategy.mock.calls[0]![0];

    expect(deposit.totalXAmount.toString()).toBe("5000");
    expect(deposit.totalYAmount.toString()).toBe("0");
    expect(position.id).toBeGreaterThan(0);
    expect((getDb().prepare("SELECT status, acquired_raw FROM acquisition_intents").get() as { status: string; acquired_raw: string })).toEqual({
      status: "complete",
      acquired_raw: "5000",
    });
    expect((getDb().prepare("SELECT open_cost_sol FROM positions WHERE id = ?").get(position.id) as { open_cost_sol: number }).open_cost_sol)
      .toBeCloseTo(0.105, 9);
  });

  it("rejects a pool whose tokenX is not the proposed mint before acquiring", async () => {
    vi.mocked(fetchPool).mockResolvedValue({ mintX: OTHER_TOKEN, binStep: 100 } as never);
    const executor = harness();

    await expect(executor.open(params())).rejects.toThrow(/requires pool tokenX/i);
    expect(swapFromSol).not.toHaveBeenCalled();
    expect((getDb().prepare("SELECT COUNT(*) AS c FROM acquisition_intents").get() as { c: number }).c).toBe(0);
  });

  it("quarantines an acquisition when the swap result is ambiguous", async () => {
    vi.mocked(swapFromSol).mockRejectedValue(Object.assign(new Error("RPC response lost"), { maybeSig: "ambiguous-sig" }));
    const executor = harness();

    await expect(executor.open(params())).rejects.toThrow("RPC response lost");
    const row = getDb().prepare("SELECT status, swap_sig, detail_json FROM acquisition_intents").get() as {
      status: string; swap_sig: string; detail_json: string;
    };
    expect(row.status).toBe("quarantined");
    expect(row.swap_sig).toBe("ambiguous-sig");
    expect(JSON.parse(row.detail_json).uncertainSignature).toBe("ambiguous-sig");
  });

  it("quarantines after deposit when the complete SOL debit cannot be reconciled", async () => {
    const executor = harness();
    (executor as unknown as Record<string, unknown>).walletDelta = vi.fn(async () => null);

    await expect(executor.open(params())).rejects.toThrow(/wallet debit is unknown/i);
    expect((getDb().prepare("SELECT COUNT(*) AS c FROM positions").get() as { c: number }).c).toBe(0);
    expect((getDb().prepare("SELECT status FROM acquisition_intents").get() as { status: string }).status)
      .toBe("quarantined");
  });
});
