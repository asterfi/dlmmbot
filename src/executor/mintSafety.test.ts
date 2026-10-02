/**
 * Same-mint safety (owner audit, 2026-10-03). With an eys_seat and an
 * eys_breakout open on ONE mint, a breakout's swapped tokens sit in the wallet
 * briefly before their deposit, and a seat close reads/sells/burns the wallet
 * balance of that mint. open() and close() on a mint are serialized; residual
 * handling never touches a mint another position uses; cleanup and the residual
 * sweep skip opening/closing/busy mints.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useMemoryDb, resetTestDb, insertOpenPosition } from "../test/db.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { getDb } from "../db/db.js";

vi.mock("./jupiter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./jupiter.js")>();
  return { ...actual, quoteToSolLamports: vi.fn(async () => 1e9) };
});

import { LiveExecutor, sellAmountForClose } from "./live.js";
import type { OpenParams } from "./executor.js";
import type { Position } from "../types.js";

const WALLET = new PublicKey("9DTThTbggnp2P2ZGLFRfN1A3j5JUsXez1dRJak3TixB2");
const MINT_A = Keypair.generate().publicKey.toBase58();
const MINT_B = Keypair.generate().publicKey.toBase58();

function makeExec(overrides: Record<string, unknown> = {}): LiveExecutor & Record<string, any> {
  const exec = Object.create(LiveExecutor.prototype) as LiveExecutor & Record<string, any>;
  (exec as unknown as { wallet: unknown }).wallet = { publicKey: WALLET };
  Object.assign(exec, overrides);
  return exec;
}
const deferred = () => { let resolve!: () => void; const p = new Promise<void>((r) => { resolve = r; }); return { p, resolve }; };
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => { useMemoryDb(); installConfig(() => {}); });
afterEach(() => { resetTestDb(); restoreConfig(); vi.clearAllMocks(); });

describe("per-mint serialization of open() / close()", () => {
  const openParams = (mint: string) => ({ tokenMint: mint } as unknown as OpenParams);
  const pos = (mint: string) => ({ tokenMint: mint, id: 1 } as unknown as Position);

  it("a breakout open and a seat close on the SAME mint never interleave", async () => {
    const order: string[] = [];
    const gate = deferred();
    const exec = makeExec({
      openUnlocked: vi.fn(async () => { order.push("open:start"); await gate.p; order.push("open:end"); return {} as Position; }),
      closeUnlocked: vi.fn(async () => { order.push("close:start"); order.push("close:end"); return { exitSol: 0, txCostSol: 0 }; }),
    });
    const o = exec.open(openParams(MINT_A));
    const c = exec.close(pos(MINT_A), "combo_exit", 100);
    await tick();
    expect(order).toEqual(["open:start"]);          // the close is queued behind the open
    expect(exec.mintBusy(MINT_A)).toBe(true);
    gate.resolve();
    await Promise.all([o, c]);
    expect(order).toEqual(["open:start", "open:end", "close:start", "close:end"]);
    expect(exec.mintBusy(MINT_A)).toBe(false);
  });

  it("the reverse order serializes too (a close, then a breakout open)", async () => {
    const order: string[] = [];
    const gate = deferred();
    const exec = makeExec({
      openUnlocked: vi.fn(async () => { order.push("open:start"); order.push("open:end"); return {} as Position; }),
      closeUnlocked: vi.fn(async () => { order.push("close:start"); await gate.p; order.push("close:end"); return { exitSol: 0, txCostSol: 0 }; }),
    });
    const c = exec.close(pos(MINT_A), "combo_exit", 100);
    const o = exec.open(openParams(MINT_A));
    await tick();
    expect(order).toEqual(["close:start"]);
    gate.resolve();
    await Promise.all([c, o]);
    expect(order).toEqual(["close:start", "close:end", "open:start", "open:end"]);
  });

  it("different mints stay concurrent", async () => {
    const order: string[] = [];
    const gate = deferred();
    const exec = makeExec({
      openUnlocked: vi.fn(async () => { order.push("openA:start"); await gate.p; order.push("openA:end"); return {} as Position; }),
      closeUnlocked: vi.fn(async () => { order.push("closeB"); return { exitSol: 0, txCostSol: 0 }; }),
    });
    const o = exec.open(openParams(MINT_A));
    await exec.close(pos(MINT_B), "combo_exit", 100);
    expect(order).toEqual(["openA:start", "closeB"]);
    gate.resolve();
    await o;
  });

  it("a failing open releases the lock", async () => {
    const exec = makeExec({
      openUnlocked: vi.fn(async () => { throw new Error("deposit failed"); }),
      closeUnlocked: vi.fn(async () => ({ exitSol: 1, txCostSol: 0 })),
    });
    await expect(exec.open(openParams(MINT_A))).rejects.toThrow(/deposit failed/);
    await expect(exec.close(pos(MINT_A), "combo_exit", 100)).resolves.toEqual({ exitSol: 1, txCostSol: 0 });
    expect(exec.mintBusy(MINT_A)).toBe(false);
  });
});

describe("sellAmountForClose — never sell tokens that are not this position's", () => {
  it("normally sells the wallet balance (the sellable truth)", () => {
    expect(sellAmountForClose({ walletX: 900n, walletXKnown: true, xToSwap: 800n, otherOnMint: false })).toBe(900n);
  });
  it("falls back to the chain-side amount on a blind read", () => {
    expect(sellAmountForClose({ walletX: 0n, walletXKnown: false, xToSwap: 800n, otherOnMint: false })).toBe(800n);
  });
  it("with another position open on the mint, the sale is capped at this position's own removed amount", () => {
    expect(sellAmountForClose({ walletX: 5_000n, walletXKnown: true, xToSwap: 800n, otherOnMint: true })).toBe(800n);
  });
  it("...but never sells MORE than the wallet holds (chain overestimate)", () => {
    expect(sellAmountForClose({ walletX: 500n, walletXKnown: true, xToSwap: 800n, otherOnMint: true })).toBe(500n);
  });
});

describe("mintHasOtherActivePosition", () => {
  it("counts only OTHER open/opening/closing LIVE positions on the mint", () => {
    const a = insertOpenPosition({ mode: "live" });
    const b = insertOpenPosition({ mode: "live" });
    const c = insertOpenPosition({ mode: "live" });
    getDb().prepare("UPDATE positions SET token_mint = ? WHERE id IN (?, ?, ?)").run(MINT_A, a, b, c);
    const exec = makeExec();
    expect(exec.mintHasOtherActivePosition(MINT_A, a)).toBe(true);
    getDb().prepare("UPDATE positions SET state = 'closed_rotation' WHERE id IN (?, ?)").run(b, c);
    expect(exec.mintHasOtherActivePosition(MINT_A, a)).toBe(false);
    getDb().prepare("UPDATE positions SET state = 'pending' WHERE id = ?").run(b);
    expect(exec.mintHasOtherActivePosition(MINT_A, a)).toBe(true);
    getDb().prepare("UPDATE positions SET state = 'closing' WHERE id = ?").run(b);
    expect(exec.mintHasOtherActivePosition(MINT_A, a)).toBe(true);
  });
});

function tokenAcct(pubkey: PublicKey, mint: string, amount: string) {
  return { pubkey, account: { owner: TOKEN_PROGRAM_ID, data: { parsed: { info: { mint, tokenAmount: { amount, decimals: 6 } } } } } };
}

describe("cleanupEmptyTokenAccounts skips opening / closing / busy mints", () => {
  it("leaves the empty account of a mint with a PENDING or CLOSING position, closes a free one", async () => {
    const pend = insertOpenPosition({ mode: "live" });
    getDb().prepare("UPDATE positions SET token_mint = ?, state = 'pending' WHERE id = ?").run(MINT_A, pend);
    const acctA = Keypair.generate().publicKey;
    const acctB = Keypair.generate().publicKey;
    const sent: string[][] = [];
    const exec = makeExec({
      connection: {
        getParsedTokenAccountsByOwner: vi.fn(async (_o: unknown, f: { programId: PublicKey }) => ({
          value: f.programId.toBase58() === TOKEN_PROGRAM_ID.toBase58()
            ? [tokenAcct(acctA, MINT_A, "0"), tokenAcct(acctB, MINT_B, "0")] : [],
        })),
      },
      send: vi.fn(async (tx: { instructions: Array<{ keys: Array<{ pubkey: PublicKey }> }> }) => {
        sent.push(tx.instructions.map((i) => i.keys[0]!.pubkey.toBase58())); return "sig";
      }),
      walletDelta: vi.fn(async () => 0.002),
    });
    await exec.cleanupEmptyTokenAccounts();
    expect(sent).toEqual([[acctB.toBase58()]]);
    getDb().prepare("UPDATE positions SET state = 'closing' WHERE id = ?").run(pend);
    sent.length = 0;
    await exec.cleanupEmptyTokenAccounts();
    expect(sent).toEqual([[acctB.toBase58()]]);
  });

  it("skips a mint whose open()/close() is mid-flight — except the mint of the close that is calling it", async () => {
    const acctA = Keypair.generate().publicKey;
    const acctB = Keypair.generate().publicKey;
    const sent: string[][] = [];
    const gateA = deferred();
    const exec = makeExec({
      openUnlocked: vi.fn(async () => { await gateA.p; return {} as Position; }),
      connection: {
        getParsedTokenAccountsByOwner: vi.fn(async (_o: unknown, f: { programId: PublicKey }) => ({
          value: f.programId.toBase58() === TOKEN_PROGRAM_ID.toBase58()
            ? [tokenAcct(acctA, MINT_A, "0"), tokenAcct(acctB, MINT_B, "0")] : [],
        })),
      },
      send: vi.fn(async (tx: { instructions: Array<{ keys: Array<{ pubkey: PublicKey }> }> }) => {
        sent.push(tx.instructions.map((i) => i.keys[0]!.pubkey.toBase58())); return "sig";
      }),
      walletDelta: vi.fn(async () => 0.002),
    });
    const o = exec.open({ tokenMint: MINT_A } as unknown as OpenParams); // MINT_A is now busy
    await tick();
    await exec.cleanupEmptyTokenAccounts();
    expect(sent).toEqual([[acctB.toBase58()]]);          // MINT_A's account untouched mid-open
    sent.length = 0;
    await exec.cleanupEmptyTokenAccounts(null, MINT_A);   // the closing mint itself is allowed
    expect(sent.flat().sort()).toEqual([acctA.toBase58(), acctB.toBase58()].sort());
    gateA.resolve();
    await o;
  });
});

describe("sweepResiduals never sells a mint another position is using", () => {
  it("skips a non-zero balance of a mint with an open position (a breakout's tokens before their deposit)", async () => {
    // MINT_A: an OPEN position uses it. MINT_B: an old closed position, a stray non-zero balance to sweep.
    const open = insertOpenPosition({ mode: "live" });
    getDb().prepare("UPDATE positions SET token_mint = ? WHERE id = ?").run(MINT_A, open);
    const closed = insertOpenPosition({ mode: "live", entryTs: 1000 });
    getDb().prepare("UPDATE positions SET token_mint = ?, state = 'closed_rotation' WHERE id = ?").run(MINT_B, closed);
    const sold: string[] = [];
    const exec = makeExec({
      unwrapWsol: vi.fn(async () => undefined),
      closeEmptyAccounts: vi.fn(async () => undefined),
      walletDelta: vi.fn(async () => 0.01),
      tokenToSol: vi.fn(async (mint: string) => { sold.push(mint); return { signature: "s" }; }),
      connection: {
        getParsedTokenAccountsByOwner: vi.fn(async (_o: unknown, f: { programId: PublicKey }) => ({
          value: f.programId.toBase58() === TOKEN_PROGRAM_ID.toBase58()
            ? [tokenAcct(Keypair.generate().publicKey, MINT_A, "5000000"), tokenAcct(Keypair.generate().publicKey, MINT_B, "5000000")] : [],
        })),
      },
    });
    const res = await exec.sweepResiduals(0.001);
    expect(sold).toEqual([MINT_B]);
    expect(res.map((r) => r.mint)).toEqual([MINT_B]);
  });

  it("also skips a mint whose open()/close() holds the lock", async () => {
    const closed = insertOpenPosition({ mode: "live", entryTs: 1000 });
    getDb().prepare("UPDATE positions SET token_mint = ?, state = 'closed_rotation' WHERE id = ?").run(MINT_B, closed);
    const gate = deferred();
    const sold: string[] = [];
    const exec = makeExec({
      openUnlocked: vi.fn(async () => { await gate.p; return {} as Position; }),
      unwrapWsol: vi.fn(async () => undefined),
      closeEmptyAccounts: vi.fn(async () => undefined),
      walletDelta: vi.fn(async () => 0.01),
      tokenToSol: vi.fn(async (mint: string) => { sold.push(mint); return { signature: "s" }; }),
      connection: {
        getParsedTokenAccountsByOwner: vi.fn(async (_o: unknown, f: { programId: PublicKey }) => ({
          value: f.programId.toBase58() === TOKEN_PROGRAM_ID.toBase58()
            ? [tokenAcct(Keypair.generate().publicKey, MINT_B, "5000000")] : [],
        })),
      },
    });
    const o = exec.open({ tokenMint: MINT_B } as unknown as OpenParams);
    await tick();
    await exec.sweepResiduals(0.001);
    expect(sold).toEqual([]);
    gate.resolve();
    await o;
  });
});
