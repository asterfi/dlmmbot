/**
 * Sign-only smoke test for the Privy server-wallet policy (see src/executor/wallet.ts).
 *
 * Builds two transactions and asks Privy to sign them. NEVER broadcasts
 * anything — the point is to prove the wallet's policy allowlist behaves as
 * configured before any real funds move through it:
 *
 *   1. A v0 tx with a disallowed System Transfer (to a random address).
 *      Expected: Privy REJECTS (signTransaction throws).
 *   2. A legacy tx with a Token CloseAccount of the wallet's own wSOL ATA
 *      (destination = wallet, which the policy allows) plus a Memo
 *      instruction with an extra local signer. Expected: Privy ALLOWS, and
 *      both the wallet's and the extra signer's signatures verify.
 *
 * Run as the dlmmbot user with the real env, e.g.:
 *   systemd-run --uid=dlmmbot --gid=dlmmbot \
 *     --property=EnvironmentFile=/etc/dlmmbot/bot.env --wait --pipe \
 *     --working-directory=/opt/dlmmbot-live npx tsx scripts/privy-smoke.ts
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createCloseAccountInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { env } from "../src/config.js";
import { loadSigner } from "../src/executor/wallet.js";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

type Outcome = "ALLOW" | "REJECT";

async function runCase(
  label: string,
  expect: Outcome,
  fn: () => Promise<void>,
): Promise<boolean> {
  console.log(`\n=== ${label} ===`);
  console.log(`expected: ${expect}`);
  let actual: Outcome;
  let detail = "";
  try {
    await fn();
    actual = "ALLOW";
  } catch (e) {
    actual = "REJECT";
    detail = (e as Error).message;
  }
  const pass = actual === expect;
  console.log(`actual:   ${actual}${detail ? ` (${detail})` : ""}`);
  console.log(pass ? "PASS" : "FAIL");
  return pass;
}

async function main(): Promise<void> {
  const e = env();
  if (!e.privyWalletId) {
    console.error("PRIVY_WALLET_ID is not set — this smoke test requires the Privy signer, not the raw-keypair fallback.");
    process.exit(1);
  }
  const signer = loadSigner(e);
  const connection = new Connection(e.rpcUrl, "confirmed");
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  console.log(`wallet: ${signer.publicKey.toBase58()}`);
  console.log("NOTE: this script only signs — it never calls sendTransaction/sendRawTransaction.");

  let allPass = true;

  allPass = await runCase(
    "System Transfer of 1000 lamports to a random address (v0)",
    "REJECT",
    async () => {
      const randomTo = Keypair.generate().publicKey;
      const ixs = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 10_000 }),
        SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: randomTo, lamports: 1000 }),
      ];
      const msg = new TransactionMessage({
        payerKey: signer.publicKey,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message();
      await signer.signTransaction(new VersionedTransaction(msg));
    },
  ) && allPass;

  allPass = await runCase(
    "Token CloseAccount(wSOL ATA → wallet) + Memo w/ extra local signer (legacy)",
    "ALLOW",
    async () => {
      const extraSigner = Keypair.generate();
      const wsolAta = getAssociatedTokenAddressSync(SOL_MINT, signer.publicKey);
      const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: blockhash });
      tx.add(createCloseAccountInstruction(wsolAta, signer.publicKey, signer.publicKey, [], TOKEN_PROGRAM_ID));
      tx.add(new TransactionInstruction({
        programId: MEMO_PROGRAM_ID,
        keys: [{ pubkey: extraSigner.publicKey, isSigner: true, isWritable: false }],
        data: Buffer.from("dlmmbot privy smoke test", "utf8"),
      }));
      tx.partialSign(extraSigner);

      const signed = await signer.signTransaction(tx);

      const walletSig = signed.signatures.find((s) => s.publicKey.equals(signer.publicKey))?.signature;
      const extraSig = signed.signatures.find((s) => s.publicKey.equals(extraSigner.publicKey))?.signature;
      if (!walletSig) throw new Error("wallet signature missing after Privy sign");
      if (!extraSig) throw new Error("extra local signer's signature missing after Privy sign");
      if (!signed.verifySignatures()) throw new Error("verifySignatures() failed on the returned tx");
    },
  ) && allPass;

  console.log(`\n${allPass ? "ALL CASES PASSED" : "SOME CASES FAILED"}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(1);
});
