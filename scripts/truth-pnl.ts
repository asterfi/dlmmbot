/**
 * Truth P&L: what the wallet's SOL-denominated equity actually is right now,
 * independent of anything the bot's own ledger (positions/events tables)
 * believes. Reads live chain state — SOL balance, wSOL, open DLMM positions,
 * other SPL tokens — and nets it against real external deposits/withdrawals
 * pulled from transaction history, so a bug (or a drain) in the bot's own
 * bookkeeping can't hide behind its own numbers.
 *
 * Usage:
 *   npx tsx scripts/truth-pnl.ts [--address <pubkey>] [--since YYYY-MM-DD]
 *                                 [--cold-wallet <pubkey>] [--telegram]
 *
 * --address defaults to PRIVY_WALLET_ADDRESS (or WALLET_PRIVATE_KEY's pubkey).
 * --cold-wallet defaults to COLD_WALLET_ADDRESS from the env, if set.
 * Without --address, the computed row is appended to FARMER_DB_PATH's
 * sibling truth-pnl.jsonl; with --address (an ad-hoc check against some
 * other wallet) nothing is written to disk.
 */
import { existsSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { env, SOL_MINT } from "../src/config.js";
import { quoteToSolLamports } from "../src/executor/jupiter.js";
import { alert } from "../src/alerts.js";

interface Args {
  address?: string;
  since?: string;
  coldWallet?: string;
  telegram: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { telegram: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--address") out.address = argv[++i];
    else if (a === "--since") out.since = argv[++i];
    else if (a === "--cold-wallet") out.coldWallet = argv[++i];
    else if (a === "--telegram") out.telegram = true;
  }
  return out;
}

/** SOL balance of a pubkey, in SOL. */
async function solBalance(connection: Connection, pubkey: PublicKey): Promise<number> {
  return (await connection.getBalance(pubkey, "confirmed")) / 1e9;
}

/** wSOL ATA balance, in SOL (0 if the ATA doesn't exist). */
async function wsolBalance(connection: Connection, owner: PublicKey): Promise<number> {
  try {
    const accs = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(SOL_MINT) });
    let total = 0;
    for (const acc of accs.value) {
      const info = acc.account.data.parsed.info as { tokenAmount: { uiAmount: number | null } };
      total += info.tokenAmount.uiAmount ?? 0;
    }
    return total;
  } catch {
    return 0;
  }
}

/** Every non-SOL SPL token the wallet holds, valued in SOL via Jupiter (best-effort — unquotable dust is skipped). */
async function otherTokensValueSol(connection: Connection, owner: PublicKey): Promise<{ valueSol: number; tokens: { mint: string; amountRaw: string; sol: number }[] }> {
  const tokens: { mint: string; amountRaw: string; sol: number }[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    let accs;
    try {
      accs = await connection.getParsedTokenAccountsByOwner(owner, { programId });
    } catch {
      continue;
    }
    for (const acc of accs.value) {
      const info = acc.account.data.parsed.info as { mint: string; tokenAmount: { amount: string; uiAmount: number | null } };
      if (info.mint === SOL_MINT) continue; // wSOL already counted separately
      const raw = BigInt(info.tokenAmount.amount);
      if (raw <= 0n) continue;
      const outLamports = await quoteToSolLamports(info.mint, raw).catch(() => null);
      const sol = outLamports != null ? outLamports / 1e9 : 0;
      tokens.push({ mint: info.mint, amountRaw: raw.toString(), sol });
    }
  }
  return { valueSol: tokens.reduce((s, t) => s + t.sol, 0), tokens };
}

/**
 * Open DLMM position value in SOL, read straight from on-chain pool state —
 * not from the bot's own `positions` table (that's exactly what this script
 * must not trust). Pool addresses are still sourced from the DB only to know
 * WHERE to look; if the DB is missing or empty (fresh install, nothing ever
 * opened), this is a no-op rather than a hard failure.
 */
async function openPositionsValueSol(connection: Connection, owner: PublicKey, dbPath: string | undefined): Promise<number> {
  if (!dbPath || !existsSync(dbPath)) return 0;
  let pools: string[] = [];
  try {
    const DatabaseCtor = (await import("better-sqlite3")).default;
    const db = new DatabaseCtor(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(
      "SELECT DISTINCT pool FROM positions WHERE mode = 'live' AND state IN ('open','pending')",
    ).all() as { pool: string }[];
    db.close();
    pools = rows.map((r) => r.pool);
  } catch (e) {
    console.warn(`[truth-pnl] could not read open positions from ${dbPath}: ${(e as Error).message.split("\n")[0]}`);
    return 0;
  }
  if (pools.length === 0) return 0;

  let total = 0;
  const DLMM = (await import("@meteora-ag/dlmm")).default as unknown as {
    create(connection: Connection, pool: PublicKey): Promise<{
      getPositionsByUserAndLbPair(user: PublicKey): Promise<{ userPositions: Array<{
        positionData: { totalXAmount: string; totalYAmount: string; feeX: { toString(): string }; feeY: { toString(): string } };
      }> }>;
      getActiveBin(): Promise<{ price: string | number }>;
      fromPricePerLamport(p: number): string;
      tokenX: { mint: { decimals: number } };
    }>;
  };
  for (const poolAddr of pools) {
    try {
      const pool = await DLMM.create(connection, new PublicKey(poolAddr));
      const { userPositions } = await pool.getPositionsByUserAndLbPair(owner);
      if (userPositions.length === 0) continue;
      const activeBin = await pool.getActiveBin();
      const priceYperX = Number(pool.fromPricePerLamport(Number(activeBin.price)));
      const xDecimals = pool.tokenX.mint.decimals;
      let xRaw = 0, yRaw = 0;
      for (const p of userPositions) {
        xRaw += Number(p.positionData.totalXAmount) + Number(p.positionData.feeX.toString());
        yRaw += Number(p.positionData.totalYAmount) + Number(p.positionData.feeY.toString());
      }
      const xUi = xRaw / 10 ** xDecimals;
      total += yRaw / 1e9 + xUi * priceYperX;
    } catch (e) {
      console.warn(`[truth-pnl] skipping pool ${poolAddr}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return total;
}

/**
 * Net external SOL movement since `sinceTs` (unix seconds), from top-level
 * System Program transfers only: deposits_sol (in, from an address that is
 * not the wallet's own ATA), cold_withdrawals_sol (out, to coldWallet), and
 * unexplained_outflow_sol (out, to anything else — this is where a drain or
 * an un-logged withdrawal shows up).
 */
async function externalFlowsSol(
  connection: Connection,
  owner: PublicKey,
  sinceTs: number,
  coldWallet: string | undefined,
): Promise<{ depositsSol: number; coldWithdrawalsSol: number; unexplainedOutflowSol: number; txsScanned: number }> {
  const ownAtas = new Set<string>();
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const accs = await connection.getParsedTokenAccountsByOwner(owner, { programId });
      for (const a of accs.value) ownAtas.add(a.pubkey.toBase58());
    } catch { /* best effort */ }
  }
  // wSOL wrap/unwrap targets are deterministic ATAs that may already be closed,
  // so derive them rather than relying on the live token-account list.
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    ownAtas.add(getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, programId).toBase58());
  }
  const ownerStr = owner.toBase58();
  const isOwn = (addr: string) => addr === ownerStr || ownAtas.has(addr);

  let depositsSol = 0, coldWithdrawalsSol = 0, unexplainedOutflowSol = 0, txsScanned = 0;
  let before: string | undefined;
  const MAX_PAGES = 50; // 50k signatures cap — plenty for a bot wallet's lifetime
  for (let page = 0; page < MAX_PAGES; page++) {
    const sigs = await connection.getSignaturesForAddress(owner, { before, limit: 1000 }, "confirmed");
    if (sigs.length === 0) break;
    let stop = false;
    let inRange = sigs;
    const cutIdx = sigs.findIndex((s) => s.blockTime != null && s.blockTime < sinceTs);
    if (cutIdx >= 0) { inRange = sigs.slice(0, cutIdx); stop = true; }
    before = sigs[sigs.length - 1]!.signature;

    const candidates = inRange.filter((s) => !s.err);
    const CONCURRENCY = 20;
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      const batch = candidates.slice(i, i + CONCURRENCY);
      const txs = await Promise.all(batch.map((s) =>
        connection
          .getParsedTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
          .catch(() => null as ParsedTransactionWithMeta | null),
      ));
      for (const tx of txs) {
        if (!tx) continue;
        txsScanned++;
        for (const ix of tx.transaction.message.instructions) {
          if (!("parsed" in ix) || ix.program !== "system") continue;
          const parsed = ix.parsed as { type: string; info?: { source?: string; destination?: string; lamports?: number } };
          if (parsed.type !== "transfer" || !parsed.info) continue;
          const { source, destination, lamports } = parsed.info;
          if (!source || !destination || lamports == null) continue;
          const sol = lamports / 1e9;
          if (destination === ownerStr && !isOwn(source)) {
            depositsSol += sol;
          } else if (source === ownerStr && !isOwn(destination)) {
            if (coldWallet && destination === coldWallet) coldWithdrawalsSol += sol;
            else unexplainedOutflowSol += sol;
          }
        }
      }
    }
    if (stop) break;
  }
  return { depositsSol, coldWithdrawalsSol, unexplainedOutflowSol, txsScanned };
}

function parseSince(since: string | undefined): number {
  if (!since) return 0; // genesis — scan full history
  const ts = Date.parse(`${since}T00:00:00Z`);
  if (Number.isNaN(ts)) throw new Error(`--since: cannot parse date "${since}" (expected YYYY-MM-DD)`);
  return Math.floor(ts / 1000);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const e = env();
  const addressStr = args.address ?? e.privyWalletAddress;
  if (!addressStr) throw new Error("no wallet address: pass --address or set PRIVY_WALLET_ADDRESS");
  const owner = new PublicKey(addressStr);
  const coldWallet = args.coldWallet ?? process.env.COLD_WALLET_ADDRESS ?? undefined;
  const sinceTs = parseSince(args.since);

  const connection = new Connection(e.rpcUrl, "confirmed");

  const [sol, wsol, otherTokens, positionsSol, flows] = await Promise.all([
    solBalance(connection, owner),
    wsolBalance(connection, owner),
    otherTokensValueSol(connection, owner),
    openPositionsValueSol(connection, owner, process.env.FARMER_DB_PATH),
    externalFlowsSol(connection, owner, sinceTs, coldWallet),
  ]);

  const equitySol = sol + wsol + otherTokens.valueSol + positionsSol;
  const netDepositsSol = flows.depositsSol - flows.coldWithdrawalsSol;
  const pnlSol = equitySol - netDepositsSol;
  const pnlPct = netDepositsSol > 0 ? (pnlSol / netDepositsSol) * 100 : 0;

  const row = {
    ts: new Date().toISOString(),
    address: addressStr,
    since: args.since ?? null,
    sol_balance: sol,
    wsol_balance: wsol,
    other_tokens_sol: otherTokens.valueSol,
    open_positions_sol: positionsSol,
    equity_sol: equitySol,
    deposits_sol: flows.depositsSol,
    cold_withdrawals_sol: flows.coldWithdrawalsSol,
    net_deposits_sol: netDepositsSol,
    unexplained_outflow_sol: flows.unexplainedOutflowSol,
    pnl_sol: pnlSol,
    pnl_pct: pnlPct,
    txs_scanned: flows.txsScanned,
  };

  console.log(JSON.stringify(row, null, 2));

  // Only the bot's own wallet's run gets logged — an --address sanity check
  // against some other wallet is a one-off query, not part of the ledger.
  if (!args.address && process.env.FARMER_DB_PATH) {
    const outPath = join(dirname(process.env.FARMER_DB_PATH), "truth-pnl.jsonl");
    try {
      appendFileSync(outPath, JSON.stringify(row) + "\n");
      console.log(`[truth-pnl] appended to ${outPath}`);
    } catch (err) {
      console.warn(`[truth-pnl] could not append to ${outPath}: ${(err as Error).message}`);
    }
  }

  if (args.telegram) {
    const line = `equity ${equitySol.toFixed(4)} SOL | net deposits ${netDepositsSol.toFixed(4)} | pnl ${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%)`
      + (flows.unexplainedOutflowSol > 1e-6 ? ` | ⚠ unexplained outflow ${flows.unexplainedOutflowSol.toFixed(4)} SOL` : "");
    await alert("info", `truth-pnl: ${line}`);
  }
}

main().catch((e) => {
  console.error("truth-pnl failed:", e);
  process.exit(1);
});
