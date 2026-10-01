// EMERGENCY WITHDRAWAL — run on YOUR laptop, never on the VPS.
// Uses the OWNER key (no policy limits) to: close every Meteora DLMM position, swap leftover
// tokens to SOL via Jupiter, close token accounts, then send ALL SOL to COLD_WALLET.
//
//   node emergency-withdraw.mjs              dry run: shows what it would do, sends nothing
//   node emergency-withdraw.mjs --selftest   proves the owner key can sign (sign-only, sends nothing)
//   node emergency-withdraw.mjs --execute    does it for real (asks you to type WITHDRAW)
//
// Owner key source, in order: owner-key.secret.txt → OWNER_KEY_PRIVATE env → hidden prompt.
import "dotenv/config";
import fs from "node:fs";
import readline from "node:readline";
import { createRequire } from "node:module";
import { PrivyClient } from "@privy-io/node";
import { Connection, PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";

// The Meteora SDK's Anchor dependency breaks under ESM import; load the CommonJS build instead.
const require = createRequire(import.meta.url);
const BN = require("bn.js");
const dlmmPkg = require("@meteora-ag/dlmm");
const DLMM = dlmmPkg.default ?? dlmmPkg;
const MODE = process.argv.includes("--execute") ? "execute" : process.argv.includes("--selftest") ? "selftest" : "dry";
const { PRIVY_APP_ID, PRIVY_APP_SECRET, COLD_WALLET, RPC_URL, JUPITER_API_KEY } = process.env;
const state = JSON.parse(fs.readFileSync("state.json", "utf8"));
if (!PRIVY_APP_ID || !PRIVY_APP_SECRET || !COLD_WALLET) throw new Error("PRIVY_APP_ID, PRIVY_APP_SECRET, COLD_WALLET must be set in .env");

const wallet = new PublicKey(state.walletAddress);
const cold = new PublicKey(COLD_WALLET.trim());
const conn = new Connection(RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const privy = new PrivyClient({ appId: PRIVY_APP_ID, appSecret: PRIVY_APP_SECRET });
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN22 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const WSOL = "So11111111111111111111111111111111111111112";
const JUP = JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";
const sol = (l) => (l / LAMPORTS_PER_SOL).toFixed(6);

function ask(question, hidden = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
  return new Promise((r) => rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); r(a.trim()); }));
}

async function ownerKey() {
  if (fs.existsSync("owner-key.secret.txt")) return fs.readFileSync("owner-key.secret.txt", "utf8").trim();
  if (process.env.OWNER_KEY_PRIVATE) return process.env.OWNER_KEY_PRIVATE.trim();
  return ask("Paste owner key (input hidden): ", true);
}

let OWNER;
// Sign with Privy as the owner; returns raw signed bytes. Works for legacy and versioned txs.
async function signBytes(serializedBase64) {
  const r = await privy.wallets().solana().signTransaction(state.walletId, {
    transaction: serializedBase64,
    authorization_context: { authorization_private_keys: [OWNER] },
  });
  return Buffer.from(r.signed_transaction, "base64");
}

async function sendLegacy(tx, label) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = wallet;
  tx.recentBlockhash = blockhash;
  const raw = await signBytes(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"));
  return sendRaw(raw, label, blockhash, lastValidBlockHeight);
}

async function sendRaw(raw, label, blockhash, lastValidBlockHeight) {
  const sig = await conn.sendRawTransaction(raw, { maxRetries: 5 });
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(res.value.err)} (${sig})`);
  console.log(`   ✔ ${label}: https://solscan.io/tx/${sig}`);
  return sig;
}

const priority = () => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 });

async function tokenAccounts() {
  const out = [];
  for (const programId of [TOKEN, TOKEN22]) {
    const { value } = await conn.getParsedTokenAccountsByOwner(wallet, { programId });
    for (const a of value) {
      const info = a.account.data.parsed.info;
      out.push({ pubkey: a.pubkey, programId, mint: info.mint, raw: info.tokenAmount.amount, ui: info.tokenAmount.uiAmountString });
    }
  }
  return out;
}

async function main() {
  console.log(`MODE: ${MODE.toUpperCase()}\nbot wallet: ${wallet.toBase58()}\ncold wallet: ${cold.toBase58()}\n`);
  OWNER = await ownerKey();

  if (MODE === "selftest") {
    // Owner must be able to sign a transfer to ANY address (the bot key cannot). Sign-only; never sent.
    const stranger = Keypair.generate().publicKey;
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: stranger, lamports: 1000 }));
    tx.feePayer = wallet;
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    await signBytes(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"));
    console.log("SELFTEST PASSED: owner key can sign unrestricted withdrawals (nothing was sent).");
    return;
  }

  // ---- 1. Plan ----
  const positions = await DLMM.getAllLbPairPositionsByUser(conn, wallet);
  const posList = [];
  for (const [pair, info] of positions) for (const p of info.lbPairPositionsData) posList.push({ pair, p });
  const accts = await tokenAccounts();
  const balance = await conn.getBalance(wallet);

  console.log(`1. Meteora positions to close: ${posList.length}`);
  for (const { pair, p } of posList) console.log(`   - ${p.publicKey.toBase58()} in pool ${pair} (bins ${p.positionData.lowerBinId}..${p.positionData.upperBinId})`);
  console.log(`2. Token accounts: ${accts.length}`);
  for (const a of accts) console.log(`   - ${a.mint === WSOL ? "wSOL" : a.mint}: ${a.ui}`);
  console.log(`3. SOL balance now: ${sol(balance)} (all of it, after the steps above, goes to cold)\n`);

  if (MODE === "dry") { console.log("DRY RUN — nothing sent. Re-run with --execute to withdraw."); return; }
  if ((await ask('Type WITHDRAW to move everything to the cold wallet: ')) !== "WITHDRAW") { console.log("Aborted."); return; }

  // ---- 2. Close positions (remove 100% liquidity, claim fees, close) ----
  for (const { pair, p } of posList) {
    const pool = await DLMM.create(conn, new PublicKey(pair));
    try {
      const txs = await pool.removeLiquidity({
        user: wallet, position: p.publicKey,
        fromBinId: p.positionData.lowerBinId, toBinId: p.positionData.upperBinId,
        bps: new BN(10_000), shouldClaimAndClose: true,
      });
      for (const [i, tx] of txs.entries()) await sendLegacy(tx, `close position ${p.publicKey.toBase58().slice(0, 8)} (${i + 1}/${txs.length})`);
    } catch (e) {
      console.log(`   ! removeLiquidity failed (${e.message}); trying close-if-empty`);
      const tx = await pool.closePositionIfEmpty({ owner: wallet, position: p.publicKey });
      await sendLegacy(tx, `close empty position ${p.publicKey.toBase58().slice(0, 8)}`);
    }
  }

  // ---- 3. Swap every non-SOL token to SOL via Jupiter ----
  for (const a of await tokenAccounts()) {
    if (a.mint === WSOL || a.raw === "0") continue;
    try {
      const h = JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {};
      const q = await (await fetch(`${JUP}/quote?inputMint=${a.mint}&outputMint=${WSOL}&amount=${a.raw}&slippageBps=1500`, { headers: h })).json();
      if (!q.outAmount) throw new Error(q.error ?? "no route");
      const s = await (await fetch(`${JUP}/swap`, {
        method: "POST", headers: { "content-type": "application/json", ...h },
        body: JSON.stringify({ quoteResponse: q, userPublicKey: wallet.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }),
      })).json();
      if (!s.swapTransaction) throw new Error(s.error ?? "swap build failed");
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      await sendRaw(await signBytes(s.swapTransaction), `swap ${a.ui} of ${a.mint.slice(0, 8)} → ${sol(Number(q.outAmount))} SOL`, blockhash, lastValidBlockHeight);
    } catch (e) {
      console.log(`   ! could not swap ${a.mint} (${e.message}) — left in wallet; you can sweep it later with the owner key`);
    }
  }

  // ---- 4. Close empty token accounts (incl. unwrapping wSOL) to reclaim rent ----
  const closable = (await tokenAccounts()).filter((a) => a.raw === "0" || a.mint === WSOL);
  for (let i = 0; i < closable.length; i += 8) {
    const tx = new Transaction().add(priority());
    for (const a of closable.slice(i, i + 8)) {
      tx.add(new TransactionInstruction({
        programId: a.programId, data: Buffer.from([9]),
        keys: [{ pubkey: a.pubkey, isSigner: false, isWritable: true }, { pubkey: wallet, isSigner: false, isWritable: true }, { pubkey: wallet, isSigner: true, isWritable: false }],
      }));
    }
    await sendLegacy(tx, `close ${Math.min(8, closable.length - i)} token account(s)`);
  }

  // ---- 5. Send all SOL to cold ----
  const fee = 5_000;
  const bal = await conn.getBalance(wallet);
  if (bal > fee) {
    await sendLegacy(new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: cold, lamports: bal - fee })), `send ${sol(bal - fee)} SOL to cold`);
  }
  const left = await tokenAccounts();
  console.log(`\nDONE. Bot wallet SOL: ${sol(await conn.getBalance(wallet))}, token accounts left: ${left.length}`);
}

main().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
