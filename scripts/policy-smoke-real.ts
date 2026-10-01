/**
 * Sign-only Privy policy smoke test against REAL, liquid venues (a real
 * Meteora DLMM pool, the real Jupiter v6 API) using the codebase's ACTUAL
 * transaction builders — never broadcasts anything. Same ALLOW/REJECT
 * convention as scripts/privy-smoke.ts: a build+sign flow that completes is
 * ALLOW, one that throws is REJECT (the only thing standing between a
 * correctly-built real transaction and success is Privy's policy).
 *
 * Covers every real transaction shape the combo strategy's live path would
 * ever send:
 *   1. SOL-side Bid-Ask open            (DLMM SDK, same call as live.ts open())
 *   2. Spot SOL-side open (eys_seat)    (DLMM SDK, strategyType=Spot)
 *   3. Claim fees                       NOT INDEPENDENTLY TESTED — see below
 *   4. Remove liquidity + close         NOT INDEPENDENTLY TESTED — see below
 *   5. Jupiter swap token->SOL          (jupiter.ts buildSwapToSolTx — the build
 *                                        half swapToSol() already sends from;
 *                                        split out 2026-10-01 for this script)
 *   6. Jupiter swap SOL->token (ape)    (jupiter.ts buildSwapFromSolTx, used by
 *                                        LiveExecutor.openApe AND profitBurn.ts)
 *   7. Token-sided DLMM deposit (ape)   (live.ts buildApeDepositTx — the EXACT
 *                                        function LiveExecutor.openApe calls,
 *                                        not a hand-rolled duplicate)
 *   8. profitBurn path                  (jupiter.ts buildSwapFromSolTx + Burn,
 *                                        same build executeProfitBurn() uses)
 *
 * 2026-10-01: shapes 6 and 7 both signed ALLOW (see the run recorded in the
 * combo report) — eys_ape's live path (LiveExecutor.openApe) is live, gated
 * by config `combo.ape_live_enabled` (default true).
 *
 * Shapes 3/4 need a REAL on-chain position: `removeLiquidity`/`claimAllSwapFee`/
 * `closePositionIfEmpty` (@meteora-ag/dlmm) all call
 * `connection.getAccountInfo(position)` and Anchor-bytemuck-decode a
 * PositionV2 account that must already exist on chain (verified by reading
 * node_modules/@meteora-ag/dlmm/dist/index.js — `wrapPosition` throws
 * "Unknown position account" on anything that doesn't decode). The wallet
 * under test (PRIVY_WALLET_ADDRESS) holds 0 SOL and no positions, and this
 * script must never broadcast a real open to create one. Fabricating a
 * synthetic PositionV2 account (Anchor bytemuck-encoding a hand-built struct
 * and monkey-patching the one `getAccountInfo` call) was attempted and
 * abandoned within this session — `program.coder.accounts.encode` overran
 * its buffer on the first attempt, and guessing at raw bytes for a
 * security-sensitive financial program is not something to half-finish. These
 * two shapes are reported NOT INDEPENDENTLY TESTED, never assumed ALLOW. The
 * owner's decision (2026-10-01) accepts this gap for eys_ape since it is
 * identical across every play's close path and is backstopped off-box.
 *
 * Run as the dlmmbot user with the real env (same pattern as
 * scripts/privy-smoke.ts):
 *   systemd-run --uid=dlmmbot --gid=dlmmbot \
 *     --property=EnvironmentFile=/etc/dlmmbot/bot.env --wait --pipe \
 *     --working-directory=/opt/dlmmbot-live npx tsx scripts/policy-smoke-real.ts
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createBurnInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { createRequire } from "node:module";
import type * as DLMMTypes from "@meteora-ag/dlmm";
import { env } from "../src/config.js";
import { loadSigner } from "../src/executor/wallet.js";
import { buildSwapFromSolTx, buildSwapToSolTx } from "../src/executor/jupiter.js";
import { buildApeDepositTx } from "../src/executor/live.js";
import { PROFIT_BURN } from "../src/executor/profitBurn.js";

// Same CJS import pattern as src/executor/live.ts (the SDK's ESM build
// crashes on anchor's CJS named exports under Node's loader).
const dlmmMod = createRequire(import.meta.url)("@meteora-ag/dlmm") as {
  default?: any;
  StrategyType: typeof DLMMTypes.StrategyType;
} & any;
const DLMM = dlmmMod.default ?? dlmmMod;
const StrategyType = dlmmMod.StrategyType;

// Real, liquid, SOL-quoted Meteora DLMM pool — picked 2026-10-01 from
// https://dlmm.datapi.meteora.ag/pools?sort_by=volume_24h:desc (TVL ~$1.1M,
// token_y = native SOL, bin_step 100). Any other active SOL pair would do.
const TEST_POOL = "AG1EhPjsBrkxQWkViuLXF6pQnHwfr9f9sdNneeoykcEJ"; // SI-SOL
const TEST_TOKEN_MINT = "DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP"; // SI, 6 decimals

const KNOWN_PROGRAMS: Record<string, string> = {
  ComputeBudget111111111111111111111111111111: "ComputeBudget",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter v6",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  "11111111111111111111111111111111111111112": "System",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
};

function labelProgram(pid: string): string {
  return KNOWN_PROGRAMS[pid] ?? pid;
}

function describeLegacyIxs(ixs: TransactionInstruction[], dlmmProgram?: any): string[] {
  return ixs.map((ix) => {
    const pid = ix.programId.toBase58();
    let detail = "";
    if (pid === "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo" && dlmmProgram) {
      try {
        const decoded = dlmmProgram.coder.instruction.decode(ix.data);
        if (decoded) detail = `:${decoded.name}`;
      } catch { /* best-effort label only */ }
    }
    return `${labelProgram(pid)}${detail}`;
  });
}

function describeVersionedProgramIds(tx: { message: { compiledInstructions: { programIdIndex: number }[]; staticAccountKeys: PublicKey[] } }): string[] {
  return tx.message.compiledInstructions.map((ci) =>
    labelProgram(tx.message.staticAccountKeys[ci.programIdIndex]!.toBase58())
  );
}

type Outcome = "ALLOW" | "REJECT" | "NOT_TESTED";
interface CaseResult { label: string; outcome: Outcome; detail: string; instructions: string[] }

/** Same convention as scripts/privy-smoke.ts: completes = ALLOW, throws = REJECT. */
async function runCase(
  label: string,
  fn: () => Promise<{ instructions: string[] } | null>,
): Promise<CaseResult> {
  console.log(`\n=== ${label} ===`);
  try {
    const r = await fn();
    if (!r) {
      console.log("SKIPPED — no quote/route available right now (not a policy result)");
      return { label, outcome: "NOT_TESTED", detail: "no route/quote available", instructions: [] };
    }
    console.log("instructions:", r.instructions);
    console.log("Privy result: ALLOW");
    return { label, outcome: "ALLOW", detail: "", instructions: r.instructions };
  } catch (e) {
    const msg = (e as Error).message;
    console.log(`Privy result: REJECT (${msg})`);
    return { label, outcome: "REJECT", detail: msg, instructions: [] };
  }
}

async function main(): Promise<void> {
  const e = env();
  if (!e.privyWalletId) {
    console.error("PRIVY_WALLET_ID is not set — this smoke test requires the Privy signer.");
    process.exit(1);
  }
  const signer = loadSigner(e);
  const connection = new Connection(e.rpcUrl, "confirmed");
  console.log(`wallet: ${signer.publicKey.toBase58()}`);
  console.log(`pool:   ${TEST_POOL}`);
  console.log(`token:  ${TEST_TOKEN_MINT}`);
  console.log("NOTE: this script only SIGNS — it never calls sendTransaction/sendRawTransaction.");

  const pool = await DLMM.create(connection, new PublicKey(TEST_POOL));
  const dlmmProgram = (pool as any).program;
  const activeBin = await pool.getActiveBin();
  const decimalsX = pool.tokenX.mint.decimals as number;

  const results: CaseResult[] = [];

  async function buildAndSignLegacy(tx: Transaction, extraSigners: Keypair[]): Promise<string[]> {
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = signer.publicKey;
    for (const kp of extraSigners) tx.partialSign(kp);
    const labels = describeLegacyIxs(tx.instructions, dlmmProgram);
    await signer.signTransaction(tx); // the actual policy check
    return labels;
  }

  results.push(await runCase(
    "1. SOL-side Bid-Ask open (position init + add liquidity, incl. bin-array/ATA/wrap ixs)",
    async () => {
      const positionKp = Keypair.generate();
      const tx: Transaction = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKp.publicKey,
        user: signer.publicKey,
        totalXAmount: new BN(0),
        totalYAmount: new BN(1), // smallest possible unit — building needs no real balance
        strategy: { minBinId: activeBin.binId - 50, maxBinId: activeBin.binId, strategyType: StrategyType.BidAsk },
      });
      console.log("extra signer (position keypair):", positionKp.publicKey.toBase58());
      const instructions = await buildAndSignLegacy(tx, [positionKp]);
      return { instructions };
    },
  ));

  results.push(await runCase(
    "2. Spot SOL-side open (eys_seat shape)",
    async () => {
      const positionKp = Keypair.generate();
      const tx: Transaction = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKp.publicKey,
        user: signer.publicKey,
        totalXAmount: new BN(0),
        totalYAmount: new BN(1),
        strategy: { minBinId: activeBin.binId - 20, maxBinId: activeBin.binId, strategyType: StrategyType.Spot },
      });
      console.log("extra signer (position keypair):", positionKp.publicKey.toBase58());
      const instructions = await buildAndSignLegacy(tx, [positionKp]);
      return { instructions };
    },
  ));

  console.log("\n=== 3. Claim fees ===");
  console.log(
    "NOT INDEPENDENTLY TESTED — claimAllSwapFee()/claimSwapFee() read a real on-chain\n" +
    "PositionV2 account (connection.getAccountInfo + Anchor bytemuck decode). This wallet\n" +
    "holds no position and this script may not broadcast an open to create one. See the\n" +
    "header comment for what was attempted."
  );
  results.push({ label: "3. Claim fees", outcome: "NOT_TESTED", detail: "requires a real on-chain position (see header comment)", instructions: [] });

  console.log("\n=== 4. Remove liquidity + close (incl. unwrap) ===");
  console.log(
    "NOT INDEPENDENTLY TESTED — removeLiquidity()/closePositionIfEmpty() have the same\n" +
    "real-on-chain-position requirement as claim fees above."
  );
  results.push({ label: "4. Remove liquidity + close", outcome: "NOT_TESTED", detail: "requires a real on-chain position (see header comment)", instructions: [] });

  results.push(await runCase(
    "5. Jupiter swap token->SOL (bot's exit path, buildSwapToSolTx)",
    async () => {
      const built = await buildSwapToSolTx(connection, signer, TEST_TOKEN_MINT, 1_000_000n, 50);
      if (!built) return null;
      // buildSwapToSolTx already signed via Privy internally (it's the build
      // half swapToSol() sends from) — reaching here IS the ALLOW result.
      return { instructions: describeVersionedProgramIds(built.tx) };
    },
  ));

  results.push(await runCase(
    "6. Jupiter swap SOL->token (ape entry, buildSwapFromSolTx)",
    async () => {
      const built = await buildSwapFromSolTx(connection, signer, TEST_TOKEN_MINT, 100_000_000n, 100);
      if (!built) return null;
      return { instructions: describeVersionedProgramIds(built.tx) };
    },
  ));

  results.push(await runCase(
    "7. Token-sided DLMM deposit (eys_ape, range ABOVE current price) — via the REAL executor build (buildApeDepositTx)",
    async () => {
      const tokenAmount = new BN(10).pow(new BN(decimalsX)); // 1 whole token, nominal
      const { tx, positionKp } = await buildApeDepositTx(
        pool, signer.publicKey, BigInt(tokenAmount.toString()), activeBin.binId, activeBin.binId + 50,
      );
      console.log("extra signer (position keypair):", positionKp.publicKey.toBase58());
      const instructions = await buildAndSignLegacy(tx, [positionKp]);
      return { instructions };
    },
  ));

  results.push(await runCase(
    "8. profitBurn (SOL -> GNME via Jupiter + Burn, same build executeProfitBurn() uses)",
    async () => {
      const mint = new PublicKey(PROFIT_BURN.mint);
      const ata = getAssociatedTokenAddressSync(mint, signer.publicKey, false);
      const built = await buildSwapFromSolTx(
        connection, signer, mint.toBase58(), 10_000_000n, PROFIT_BURN.slippage_bps,
        (minOut) => [createBurnInstruction(ata, mint, signer.publicKey, minOut, [])],
      );
      if (!built) return null;
      return { instructions: describeVersionedProgramIds(built.tx) };
    },
  ));

  console.log("\n\n=== SUMMARY ===");
  for (const r of results) {
    console.log(`${r.outcome.padEnd(11)} ${r.label}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  const anyReject = results.some((r) => r.outcome === "REJECT");
  const anyNotTested = results.some((r) => r.outcome === "NOT_TESTED");
  console.log(`\nALL_TESTED_ALLOW=${!anyReject && !anyNotTested} ANY_REJECT=${anyReject} ANY_NOT_TESTED=${anyNotTested}`);
  process.exit(anyReject ? 1 : 0);
}

main().catch((e) => {
  console.error("policy smoke test crashed:", e);
  process.exit(1);
});
