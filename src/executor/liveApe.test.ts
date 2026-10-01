/**
 * eys_ape live open path (owner's decision, 2026-10-01: live from day one).
 * Mocks connection/Privy at the seam LiveExecutor already exposes for this
 * kind of test: `this.pool`/`this.send`/`this.walletDelta`/`this.tokenBalanceAfter`
 * are overridden on an instance built via Object.create (LiveExecutor's
 * constructor refuses outside live mode, so it is never called). `buildApeDepositTx`
 * itself runs for REAL against a fake `pool` object satisfying the DLMM
 * structural interface — only the network-touching pieces are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { useMemoryDb, resetTestDb } from "../test/db.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { getDb } from "../db/db.js";
import { LiveExecutor, buildApeDepositTx } from "./live.js";
import { swapFromSol, swapToSol } from "./jupiter.js";
import type { OpenParams } from "./executor.js";

vi.mock("./jupiter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./jupiter.js")>();
  return { ...actual, swapFromSol: vi.fn(), swapToSol: vi.fn() };
});

function makeExec(overrides: Record<string, unknown> = {}): LiveExecutor {
  const exec = Object.create(LiveExecutor.prototype) as LiveExecutor & Record<string, unknown>;
  const walletPk = new PublicKey("9DTThTbggnp2P2ZGLFRfN1A3j5JUsXez1dRJak3TixB2");
  (exec as unknown as { wallet: unknown }).wallet = { publicKey: walletPk, signTransaction: vi.fn(async (tx: unknown) => tx) };
  (exec as unknown as { connection: unknown }).connection = {};
  (exec as unknown as { pools: unknown }).pools = new Map();
  Object.assign(exec, overrides);
  return exec as unknown as LiveExecutor;
}

const FAKE_POOL = {
  tokenX: { mint: { decimals: 6 } },
  initializePositionAndAddLiquidityByStrategy: vi.fn(async () => new Transaction()),
};

const BASE_PARAMS: OpenParams = {
  poolAddress: "Pool1111111111111111111111111111111111111",
  tokenMint: "Tok1111111111111111111111111111111111111",
  symbol: "APETEST",
  sizeSol: 0.1,
  entryPrice: 0.001,
  range: { minBinId: 100, maxBinId: 150, binCount: 51, positionAccounts: 1, bottomPricePct: 0, shape: "bidask", fibAnchor: null, estBinRentSol: 0.075 },
  play: "eys_ape",
  side: "token",
};

beforeEach(() => {
  useMemoryDb();
  installConfig((c) => { c.exec.exit_slippage_bps = 100; c.combo!.ape_live_enabled = true; });
  vi.mocked(swapFromSol).mockReset();
  vi.mocked(swapToSol).mockReset();
  FAKE_POOL.initializePositionAndAddLiquidityByStrategy.mockClear();
});

afterEach(() => {
  resetTestDb();
  restoreConfig();
  vi.restoreAllMocks();
});

describe("buildApeDepositTx", () => {
  it("deposits 100% token-side (Y=0) in the planned above-price range, with a fresh position signer", async () => {
    const user = new PublicKey("9DTThTbggnp2P2ZGLFRfN1A3j5JUsXez1dRJak3TixB2");
    const { tx, positionKp } = await buildApeDepositTx(FAKE_POOL as never, user, 5_000_000n, 100, 150);
    expect(tx).toBeInstanceOf(Transaction);
    expect(positionKp).toBeInstanceOf(Keypair);
    const calls = FAKE_POOL.initializePositionAndAddLiquidityByStrategy.mock.calls as unknown as Array<[{
      totalXAmount: { toString(): string }; totalYAmount: { toString(): string };
      strategy: { minBinId: number; maxBinId: number };
    }]>;
    const call = calls[0]![0];
    expect(call.totalXAmount.toString()).toBe("5000000");
    expect(call.totalYAmount.toString()).toBe("0");
    expect(call.strategy).toEqual(expect.objectContaining({ minBinId: 100, maxBinId: 150 }));
  });
});

describe("LiveExecutor.open — eys_ape swap-then-deposit happy path", () => {
  it("swaps SOL->token, deposits, and records entry_sol/entry_price from walletDelta truth (not the quote)", async () => {
    vi.mocked(swapFromSol).mockResolvedValue({ outAmountRaw: 999_999n, signature: "swap-sig" }); // quote value — must NOT be trusted
    const exec = makeExec({
      pool: vi.fn(async () => FAKE_POOL),
      send: vi.fn(async () => "deposit-sig"),
      walletDelta: vi.fn(async (sigs: string[]) => (sigs[0] === "swap-sig" ? -0.1003 : 0)), // actual SOL spent, incl. fees
      tokenBalanceAfter: vi.fn(async () => 4_800_000n), // actual tokens credited — differs from the quote on purpose
    });

    const pos = await exec.open(BASE_PARAMS);

    expect(pos.play).toBe("eys_ape");
    expect(pos.entrySol).toBeCloseTo(0.1003, 6); // from walletDelta, not params.sizeSol or the quote
    expect(pos.minBinId).toBe(100);
    expect(pos.maxBinId).toBe(150);
    expect(pos.state).toBe("open");

    const row = getDb().prepare("SELECT play, entry_sol, min_bin_id, max_bin_id, mode FROM positions WHERE id = ?").get(pos.id) as
      { play: string; entry_sol: number; min_bin_id: number; max_bin_id: number; mode: string };
    expect(row.play).toBe("eys_ape");
    expect(row.mode).toBe("live");
    expect(row.entry_sol).toBeCloseTo(0.1003, 6);

    const accounts = getDb().prepare("SELECT COUNT(*) AS c FROM position_accounts WHERE position_id = ?").get(pos.id) as { c: number };
    expect(accounts.c).toBe(1);
  });

  it("refuses to deposit blind when no token credit is visible after the swap", async () => {
    vi.mocked(swapFromSol).mockResolvedValue({ outAmountRaw: 999_999n, signature: "swap-sig" });
    const exec = makeExec({
      pool: vi.fn(async () => FAKE_POOL),
      send: vi.fn(async () => "deposit-sig"),
      walletDelta: vi.fn(async () => -0.1),
      tokenBalanceAfter: vi.fn(async () => 0n), // nothing credited
    });
    await expect(exec.open(BASE_PARAMS)).rejects.toThrow(/no .* credit is visible/i);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM positions").get() as { c: number }).toEqual({ c: 0 });
  });

  it("throws when the swap itself returns no route, before touching the DB", async () => {
    vi.mocked(swapFromSol).mockResolvedValue(null);
    const exec = makeExec({ pool: vi.fn(async () => FAKE_POOL), send: vi.fn() });
    await expect(exec.open(BASE_PARAMS)).rejects.toThrow(/no Jupiter route/i);
  });
});

describe("LiveExecutor.open — eys_ape deposit failure -> swap-back", () => {
  it("swaps the token back to SOL and reports ape_deposit_failed when the deposit fails but the swap-back lands", async () => {
    vi.mocked(swapFromSol).mockResolvedValue({ outAmountRaw: 999_999n, signature: "swap-sig" });
    vi.mocked(swapToSol).mockResolvedValue({ outLamports: 95_000_000, signature: "swapback-sig" });
    const exec = makeExec({
      pool: vi.fn(async () => FAKE_POOL),
      send: vi.fn().mockRejectedValue(Object.assign(new Error("ExceededBinSlippageTolerance"), { code: "ExceededBinSlippageTolerance" })),
      walletDelta: vi.fn(async (sigs: string[]) => {
        if (sigs[0] === "swap-sig") return -0.1003; // spent entering
        if (sigs[0] === "swapback-sig") return 0.0950; // recovered on the way back out
        return 0;
      }),
      tokenBalanceAfter: vi.fn(async () => 4_800_000n),
    });

    await expect(exec.open(BASE_PARAMS)).rejects.toThrow(/ape_deposit_failed|deposit failed/i);

    // No position was ever written — the open genuinely failed, same as any
    // other open_failed path; the funds are safe (swapped back), not stranded.
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM positions").get() as { c: number }).toEqual({ c: 0 });
    expect(vi.mocked(swapToSol)).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), BASE_PARAMS.tokenMint, 4_800_000n, 100,
    );
    const err = (getDb().prepare("SELECT code, message FROM error_log ORDER BY id DESC LIMIT 1").get() as
      { code: string; message: string } | undefined);
    expect(err?.code).toBe("ape_deposit_failed");
    expect(err?.message).toMatch(/0\.1003/); // spent
    expect(err?.message).toMatch(/0\.0950/); // recovered
  });

  it("reports ape_stranded (does not swallow it) when the deposit AND the swap-back both fail", async () => {
    vi.mocked(swapFromSol).mockResolvedValue({ outAmountRaw: 999_999n, signature: "swap-sig" });
    vi.mocked(swapToSol).mockRejectedValue(new Error("no route back"));
    const exec = makeExec({
      pool: vi.fn(async () => FAKE_POOL),
      send: vi.fn().mockRejectedValue(new Error("deposit boom")),
      walletDelta: vi.fn(async () => -0.1003),
      tokenBalanceAfter: vi.fn(async () => 4_800_000n),
    });

    await expect(exec.open(BASE_PARAMS)).rejects.toThrow(/ape_stranded|may be stranded/i);
    const err = (getDb().prepare("SELECT code FROM error_log ORDER BY id DESC LIMIT 1").get() as { code: string } | undefined);
    expect(err?.code).toBe("ape_stranded");
  });
});

describe("eys_ape live kill switch", () => {
  it("refuses a token-sided open outright when combo.ape_live_enabled = false", async () => {
    installConfig((c) => { c.combo!.ape_live_enabled = false; });
    const exec = makeExec({ pool: vi.fn(), send: vi.fn() });
    await expect(exec.open(BASE_PARAMS)).rejects.toThrow(/ape_live_enabled=false/);
    expect(vi.mocked(swapFromSol)).not.toHaveBeenCalled();
  });
});

describe("LiveExecutor valueOf — token-sided (eys_ape) position valuation", () => {
  it("values an X-only (token-sided) position as tokenAmount * price + fees, same formula as SOL-side", () => {
    const exec = makeExec();
    const fakePosition = {
      positionData: {
        totalXAmount: "2000000", // 2 of a 6-decimal token, raw units
        totalYAmount: "0",
        feeX: { toString: () => "10000" }, // 0.01 token of unclaimed fee, raw
        feeY: { toString: () => "0" },
      },
    };
    const priceYperX = 0.05; // 0.05 SOL per token
    const xDecimals = 6;
    const result = (exec as unknown as { valueOf: (p: unknown[], price: number, dec: number) => { valueSol: number; feesSol: number } })
      .valueOf([fakePosition], priceYperX, xDecimals);
    // 2,000,000 raw / 1e6 = 2 tokens * 0.05 = 0.1 SOL principal
    // fee: 10,000 raw / 1e6 = 0.01 token * 0.05 = 0.0005 SOL
    expect(result.feesSol).toBeCloseTo(0.0005, 8);
    expect(result.valueSol).toBeCloseTo(0.1 + 0.0005, 8);
  });

  it("values a position that has partially converted to SOL (price ran through some bins) as the sum of both sides", () => {
    const exec = makeExec();
    const fakePosition = {
      positionData: {
        totalXAmount: "1000000", // 1 token still unsold
        totalYAmount: "50000000", // 0.05 SOL already converted
        feeX: { toString: () => "0" },
        feeY: { toString: () => "0" },
      },
    };
    const result = (exec as unknown as { valueOf: (p: unknown[], price: number, dec: number) => { valueSol: number } })
      .valueOf([fakePosition], 0.05, 6);
    // 1 token * 0.05 + 0.05 SOL = 0.1 SOL
    expect(result.valueSol).toBeCloseTo(0.1, 8);
  });
});
