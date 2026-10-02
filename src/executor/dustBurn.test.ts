/**
 * Dust residual handling + close-sequence PnL attribution (owner, 2026-10-03).
 * pos#7 OCTO (molu_ladder): mark +1.05%, leftover token side quoted 0.00061 SOL,
 * exit swap "received -0.00254 SOL (-515%)", post-close ATA cleanup reclaimed
 * 0.004554 SOL. Ledger realized -0.00398 SOL; on-chain truth about +0.0006 SOL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useMemoryDb, resetTestDb, insertOpenPosition } from "../test/db.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { getDb, REALIZED_PNL_SQL } from "../db/db.js";
import { LiveExecutor, isDustQuote, attributeReclaimToPosition } from "./live.js";

const WALLET = new PublicKey("9DTThTbggnp2P2ZGLFRfN1A3j5JUsXez1dRJak3TixB2");

function makeExec(overrides: Record<string, unknown> = {}): LiveExecutor & Record<string, unknown> {
  const exec = Object.create(LiveExecutor.prototype) as LiveExecutor & Record<string, unknown>;
  (exec as unknown as { wallet: unknown }).wallet = { publicKey: WALLET };
  Object.assign(exec, overrides);
  return exec;
}

beforeEach(() => { useMemoryDb(); installConfig(() => {}); });
afterEach(() => { resetTestDb(); restoreConfig(); vi.clearAllMocks(); });

describe("isDustQuote", () => {
  it("pos#7's 0.00061 SOL leftover is dust (below the 0.002 floor and the swap-cost estimate)", () => {
    expect(isDustQuote(0.00061 * 1e9)).toBe(true);
  });
  it("a leftover that clears the floor and the cost estimate is swapped", () => {
    expect(isDustQuote(0.003 * 1e9)).toBe(false);
  });
  it("the estimated swap cost raises the floor above dust_swap_min_sol", () => {
    installConfig((c) => { c.exec.dust_swap_min_sol = 0.002; c.exec.dust_swap_cost_est_sol = 0.005; });
    expect(isDustQuote(0.003 * 1e9)).toBe(true);
  });
  it("an unquotable residual (null) is NOT dust: a quote failure is not evidence of worthlessness", () => {
    expect(isDustQuote(null)).toBe(false);
  });
});

describe("burnDustAndClose", () => {
  const MINT = Keypair.generate().publicKey;
  const acct = Keypair.generate().publicKey;

  function parsedAccount(owner: PublicKey, amount: string) {
    return { pubkey: acct, account: { owner, data: { parsed: { info: { tokenAmount: { amount, decimals: 6 } } } } } };
  }

  it("burns the residual and closes the token account in ONE tx, via the account's own program (Token-2022)", async () => {
    const sent: Array<{ programIds: string[]; keys0: string[] }> = [];
    const exec = makeExec({
      connection: { getParsedTokenAccountsByOwner: vi.fn(async () => ({ value: [parsedAccount(TOKEN_2022_PROGRAM_ID, "54466782")] })) },
      send: vi.fn(async (tx: { instructions: Array<{ programId: PublicKey; keys: Array<{ pubkey: PublicKey }> }> }) => {
        sent.push({ programIds: tx.instructions.map((i) => i.programId.toBase58()), keys0: tx.instructions.map((i) => i.keys[0]!.pubkey.toBase58()) });
        return "sigBurn";
      }),
      walletDelta: vi.fn(async () => 0.00203928 - 0.000005),
    });
    const id = insertOpenPosition({});
    const r = await exec.burnDustAndClose(MINT.toBase58(), id);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.programIds).toEqual([TOKEN_2022_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]); // Burn + CloseAccount
    expect(sent[0]!.keys0).toEqual([acct.toBase58(), acct.toBase58()]);
    expect(r!.burnedRaw).toBe(54466782n);
    expect(r!.reclaimedSol).toBeCloseTo(0.002034, 6);
    const ev = getDb().prepare("SELECT position_id, sol_delta FROM events WHERE type='dust_burn'").all() as Array<{ position_id: number; sol_delta: number }>;
    expect(ev).toHaveLength(1);
    expect(ev[0]!.position_id).toBe(id);
  });

  it("uses the legacy Token program for a legacy mint", async () => {
    const programs: string[] = [];
    const exec = makeExec({
      connection: { getParsedTokenAccountsByOwner: vi.fn(async () => ({ value: [parsedAccount(TOKEN_PROGRAM_ID, "100")] })) },
      send: vi.fn(async (tx: { instructions: Array<{ programId: PublicKey }> }) => { programs.push(...tx.instructions.map((i) => i.programId.toBase58())); return "s"; }),
      walletDelta: vi.fn(async () => 0.002),
    });
    await exec.burnDustAndClose(MINT.toBase58(), null);
    expect(new Set(programs)).toEqual(new Set([TOKEN_PROGRAM_ID.toBase58()]));
  });

  it("propagates a rejected tx (policy denies Token-2022 / transfer-fee mint) so close() can leave the dust", async () => {
    const exec = makeExec({
      connection: { getParsedTokenAccountsByOwner: vi.fn(async () => ({ value: [parsedAccount(TOKEN_2022_PROGRAM_ID, "5")] })) },
      send: vi.fn(async () => { throw new Error("privy policy denied"); }),
      walletDelta: vi.fn(),
    });
    await expect(exec.burnDustAndClose(MINT.toBase58(), null)).rejects.toThrow(/policy denied/);
    expect(getDb().prepare("SELECT COUNT(*) AS c FROM events WHERE type='dust_burn'").get()).toEqual({ c: 0 });
  });

  it("returns null (nothing to do) when the wallet holds no account for the mint", async () => {
    const exec = makeExec({ connection: { getParsedTokenAccountsByOwner: vi.fn(async () => ({ value: [] })) }, send: vi.fn() });
    expect(await exec.burnDustAndClose(MINT.toBase58(), null)).toBeNull();
  });
});

describe("close-sequence PnL attribution (pos#7 OCTO regression)", () => {
  const realized = (id: number) =>
    (getDb().prepare(`SELECT ${REALIZED_PNL_SQL} AS r FROM positions WHERE id = ?`).get(id) as { r: number }).r;

  it("folding the post-close ATA reclaim into close_return_sol turns the ledger's -0.00398 into the on-chain ~ +0.0006", () => {
    const id = insertOpenPosition({ entrySol: 0.1, mode: "live" });
    // pos#7: open cost 0.17 (0.1 deployed + position rent), close returned 0.17 - 0.00398.
    getDb().prepare(
      "UPDATE positions SET state='closed_rotation', open_cost_sol=0.17, close_return_sol=?, exit_sol=0.10105, exit_ts=1 WHERE id=?"
    ).run(0.17 - 0.00398, id);
    expect(realized(id)).toBeCloseTo(-0.00398, 6);

    attributeReclaimToPosition(id, 0.004554);

    expect(realized(id)).toBeCloseTo(0.000574, 6);
    expect(realized(id)).toBeGreaterThan(0.0005); // on-chain equity 0.3343 -> 0.33488
    expect(realized(id)).toBeLessThan(0.0007);
  });

  it("is a no-op for a zero/non-finite reclaim and for a position with no close_return_sol yet", () => {
    const id = insertOpenPosition({ entrySol: 0.1, mode: "live" });
    attributeReclaimToPosition(id, 0.004);
    attributeReclaimToPosition(id, Number.NaN);
    const row = getDb().prepare("SELECT close_return_sol AS c FROM positions WHERE id=?").get(id) as { c: number | null };
    expect(row.c).toBeNull();
  });
});
