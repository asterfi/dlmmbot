/**
 * Empty-token-account cleanup (owner's live-churn fix, 2026-10-02): 5 combo
 * closes left 5 stranded zero-balance USDC/USDT/other token accounts holding
 * ~0.0075 SOL rent (Jupiter route intermediates, not the bot's own ATA
 * creation — see cleanupEmptyTokenAccounts' doc comment in live.ts). This
 * must close every genuinely-empty account EXCEPT the wSOL ATA and the mints
 * of currently-open positions, batching CloseAccount instructions (dest =
 * wallet, the only shape Privy's policy allows).
 *
 * Same Object.create(LiveExecutor.prototype) seam as liveApe.test.ts:
 * LiveExecutor's constructor refuses outside live mode, so it is never
 * called — only connection/wallet/send/walletDelta are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useMemoryDb, resetTestDb, insertOpenPosition } from "../test/db.js";
import { getDb } from "../db/db.js";
import { LiveExecutor } from "./live.js";
import { SOL_MINT } from "../config.js";

const WALLET = new PublicKey("9DTThTbggnp2P2ZGLFRfN1A3j5JUsXez1dRJak3TixB2");
const OPEN_MINT = "Tok1111111111111111111111111111111111111";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUNK_MINT = "pumpxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

function tokenAccount(pubkey: PublicKey, mint: string, amount: string) {
  return {
    pubkey,
    account: { data: { parsed: { info: { mint, tokenAmount: { amount } } } } },
  };
}

function makeExec(overrides: Record<string, unknown> = {}): LiveExecutor & Record<string, unknown> {
  const exec = Object.create(LiveExecutor.prototype) as LiveExecutor & Record<string, unknown>;
  (exec as unknown as { wallet: unknown }).wallet = { publicKey: WALLET };
  Object.assign(exec, overrides);
  return exec;
}

beforeEach(() => useMemoryDb());
afterEach(() => { resetTestDb(); vi.clearAllMocks(); });

describe("cleanupEmptyTokenAccounts", () => {
  it("closes genuinely-empty accounts, skipping the wSOL ATA and open-position mints", async () => {
    insertOpenPosition({ entrySol: 0.1 }); // default mint1 — not relevant here
    getDb().prepare("UPDATE positions SET token_mint = ? WHERE token_mint = 'mint1'").run(OPEN_MINT);

    const wsolAta = getAssociatedTokenAddressSync(new PublicKey(SOL_MINT), WALLET);
    const emptyUsdc = new PublicKey("3DTThTbggnp2P2ZGLFRfN1A3j5JUsXez1dRJak3TixB1");
    const emptyJunk2022 = new PublicKey("4DTThTbggnp2P2ZGLFRfN1A3j5JUsXez1dRJak3TixB1");
    const openMintAcct = new PublicKey("5DTThTbggnp2P2ZGLFRfN1A3j5JUsXez1dRJak3TixB1");

    let sendCount = 0;
    const sent: { accounts: string[] }[] = [];
    const exec = makeExec({
      connection: {
        getParsedTokenAccountsByOwner: vi.fn(async (_owner: unknown, filter: { programId: PublicKey }) => {
          const legacy = filter.programId.toBase58() === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
          return {
            value: legacy
              ? [
                  tokenAccount(wsolAta, SOL_MINT, "0"),              // empty wSOL ATA — must be skipped
                  tokenAccount(emptyUsdc, USDC_MINT, "0"),           // genuinely empty — must close
                  tokenAccount(openMintAcct, OPEN_MINT, "0"),        // empty but mint has an OPEN position — must skip
                ]
              : [
                  tokenAccount(emptyJunk2022, JUNK_MINT, "0"),       // empty Token-2022 account — must close
                ],
          };
        }),
      },
      send: vi.fn(async (tx: { instructions: Array<{ keys: Array<{ pubkey: PublicKey }> }> }) => {
        sendCount++;
        sent.push({ accounts: tx.instructions.map((ix) => ix.keys[0]!.pubkey.toBase58()) });
        return `sig${sendCount}`;
      }),
      walletDelta: vi.fn(async () => 0.00203928 * 2),
    });

    const reclaimed = await exec.cleanupEmptyTokenAccounts();

    expect(sendCount).toBe(1); // both closes fit in one batch (<=8)
    const closedAccounts = sent[0]!.accounts;
    expect(closedAccounts).toContain(emptyUsdc.toBase58());
    expect(closedAccounts).toContain(emptyJunk2022.toBase58());
    expect(closedAccounts).not.toContain(wsolAta.toBase58());
    expect(closedAccounts).not.toContain(openMintAcct.toBase58());
    expect(reclaimed).toBeCloseTo(0.00203928 * 2, 6);

    const events = getDb().prepare("SELECT type, sol_delta FROM events WHERE type = 'ata_cleanup'").all() as
      Array<{ type: string; sol_delta: number }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.sol_delta).toBeCloseTo(0.00203928 * 2, 6);
  });

  it("returns 0 and sends nothing when there is nothing to clean up", async () => {
    const exec = makeExec({
      connection: {
        getParsedTokenAccountsByOwner: vi.fn(async () => ({ value: [] })),
      },
      send: vi.fn(),
    });

    const reclaimed = await exec.cleanupEmptyTokenAccounts();

    expect(reclaimed).toBe(0);
    expect((exec as unknown as { send: unknown }).send).not.toHaveBeenCalled();
  });

  it("batches more than 8 empty accounts into multiple transactions", async () => {
    const accounts = Array.from({ length: 10 }, (_, i) =>
      tokenAccount(Keypair.generate().publicKey, Keypair.generate().publicKey.toBase58(), "0")
    );
    let sendCount = 0;
    const exec = makeExec({
      connection: {
        getParsedTokenAccountsByOwner: vi.fn(async (_owner: unknown, filter: { programId: PublicKey }) =>
          filter.programId.toBase58() === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ? { value: accounts } : { value: [] }
        ),
      },
      send: vi.fn(async () => { sendCount++; return `sig${sendCount}`; }),
      walletDelta: vi.fn(async () => 0.002),
    });

    await exec.cleanupEmptyTokenAccounts();

    expect(sendCount).toBe(2); // 10 accounts, batch of 8 -> 8 + 2
  });
});
