// One-time Privy setup for the dlmmbot trading wallet. Run on YOUR laptop: `node setup.mjs`
// Resumable: progress is saved to state.json, so re-running skips finished steps.
// Never prints private keys or the app secret.
import "dotenv/config";
import fs from "node:fs";
import { PrivyClient, generateP256KeyPair } from "@privy-io/node";
import { PublicKey, Keypair, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";

const { PRIVY_APP_ID, PRIVY_APP_SECRET, COLD_WALLET } = process.env;
if (!PRIVY_APP_ID || !PRIVY_APP_SECRET || !COLD_WALLET) throw new Error("PRIVY_APP_ID, PRIVY_APP_SECRET, COLD_WALLET must be set in .env");

const cold = new PublicKey(COLD_WALLET.trim());
if (!PublicKey.isOnCurve(cold.toBytes())) throw new Error("COLD_WALLET is not a normal wallet address");

const PROGRAMS = {
  computeBudget: "ComputeBudget111111111111111111111111111111",
  meteoraDlmm: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  jupiterV6: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  ata: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  memo: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
};
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const wsolAta = (owner) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), NATIVE_MINT.toBuffer()], new PublicKey(PROGRAMS.ata))[0];

const STATE = "state.json";
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const writeSecret = (file, text) => fs.writeFileSync(file, text, { mode: 0o600 });

const privy = new PrivyClient({ appId: PRIVY_APP_ID, appSecret: PRIVY_APP_SECRET });

// 1. Authorization keys, generated locally. Private halves go to files, never to stdout.
if (!state.ownerPub) {
  const owner = await generateP256KeyPair();
  const bot = await generateP256KeyPair();
  writeSecret("owner-key.secret.txt", owner.privateKey + "\n");
  writeSecret("bot-key.secret.txt", bot.privateKey + "\n");
  Object.assign(state, { ownerPub: owner.publicKey, botPub: bot.publicKey });
  save();
  console.log("1. generated owner + bot authorization keys (saved to *.secret.txt)");
}
const ownerPriv = fs.readFileSync("owner-key.secret.txt", "utf8").trim();
const botPriv = fs.readFileSync("bot-key.secret.txt", "utf8").trim();
const asOwner = { authorization_private_keys: [ownerPriv] };
const asBot = { authorization_private_keys: [botPriv] };

// 2. Wallet owned by the owner key.
if (!state.walletId) {
  const w = await privy.wallets().create({ chain_type: "solana", owner: { public_key: state.ownerPub }, display_name: "dlmmbot-trading" });
  Object.assign(state, { walletId: w.id, walletAddress: w.address, ownerQuorumId: w.owner_id });
  save();
  console.log(`2. created wallet ${w.address} (owner quorum ${w.owner_id})`);
}
const wallet = new PublicKey(state.walletAddress);
const ata = wsolAta(wallet);

// 3. Bot signer key registered as its own 1-of-1 key quorum.
if (!state.botSignerId) {
  const q = await privy.keyQuorums().create({ display_name: "dlmmbot-signer", public_keys: [state.botPub], authorization_threshold: 1 });
  state.botSignerId = q.id;
  save();
  console.log(`3. registered bot signer ${q.id}`);
}

// 4. Policy for the bot signer. Every instruction in a tx must match some ALLOW rule.
if (!state.policyId) {
  const METHODS = ["signTransaction", "signAndSendTransaction"];
  const rulesFor = (method) => [
    {
      name: "Allow trading programs",
      method, action: "ALLOW",
      conditions: [{ field_source: "solana_program_instruction", field: "programId", operator: "in", value: Object.values(PROGRAMS) }],
    },
    {
      name: "SOL only to cold wallet or own wSOL",
      method, action: "ALLOW",
      conditions: [
        { field_source: "solana_system_program_instruction", field: "instructionName", operator: "eq", value: "Transfer" },
        { field_source: "solana_system_program_instruction", field: "Transfer.to", operator: "in", value: [cold.toBase58(), ata.toBase58()] },
      ],
    },
    {
      name: "Token close only back to wallet",
      method, action: "ALLOW",
      conditions: [
        { field_source: "solana_token_program_instruction", field: "instructionName", operator: "eq", value: "CloseAccount" },
        { field_source: "solana_token_program_instruction", field: "CloseAccount.destination", operator: "eq", value: wallet.toBase58() },
      ],
    },
    {
      name: "Token sync and burn",
      method, action: "ALLOW",
      conditions: [{ field_source: "solana_token_program_instruction", field: "instructionName", operator: "in", value: ["SyncNative", "Burn", "BurnChecked"] }],
    },
  ];
  const p = await privy.policies().create({
    version: "1.0", name: "dlmmbot bot signer", chain_type: "solana",
    owner_id: state.ownerQuorumId,
    rules: METHODS.flatMap(rulesFor),
  });
  state.policyId = p.id;
  save();
  console.log(`4. created policy ${p.id} (editable only by the owner key)`);
}

// 5. Attach the bot as an additional signer restricted by the policy (owner-authorized).
if (!state.signerAttached) {
  await privy.wallets().update(state.walletId, {
    additional_signers: [{ signer_id: state.botSignerId, override_policy_ids: [state.policyId] }],
    authorization_context: asOwner,
  });
  state.signerAttached = true;
  save();
  console.log("5. attached bot signer with policy");
}

// 6. Sign-only tests. Nothing is broadcast; the blockhash is random, so no tx could ever land.
const tx = (...ixs) => {
  const msg = new TransactionMessage({ payerKey: wallet, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: ixs }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
};
const closeIx = (dest) => new TransactionInstruction({
  programId: TOKEN_PROGRAM, data: Buffer.from([9]),
  keys: [{ pubkey: ata, isSigner: false, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: wallet, isSigner: true, isWritable: false }],
});
const send = (to, lamports = 1000) => SystemProgram.transfer({ fromPubkey: wallet, toPubkey: to, lamports });
const cu = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 });
const stranger = Keypair.generate().publicKey;

const tests = [
  ["bot: send SOL to random address", false, () => privy.wallets().solana().signTransaction(state.walletId, { transaction: tx(cu, send(stranger)), authorization_context: asBot })],
  ["bot: close wSOL account to random address", false, () => privy.wallets().solana().signTransaction(state.walletId, { transaction: tx(closeIx(stranger)), authorization_context: asBot })],
  ["no key (app secret only): send SOL to cold", false, () => privy.wallets().solana().signTransaction(state.walletId, { transaction: tx(send(cold)) })],
  ["bot: remove its own policy", false, () => privy.wallets().update(state.walletId, { additional_signers: [{ signer_id: state.botSignerId }], authorization_context: asBot })],
  ["bot: send SOL to cold wallet", true, () => privy.wallets().solana().signTransaction(state.walletId, { transaction: tx(cu, send(cold)), authorization_context: asBot })],
  ["bot: wrap SOL into own wSOL account", true, () => privy.wallets().solana().signTransaction(state.walletId, { transaction: tx(cu, send(ata)), authorization_context: asBot })],
  ["bot: close wSOL account back to wallet", true, () => privy.wallets().solana().signTransaction(state.walletId, { transaction: tx(closeIx(wallet)), authorization_context: asBot })],
];

console.log("\n6. policy tests (sign-only, never broadcast):");
let failures = 0;
for (const [label, shouldPass, run] of tests) {
  let ok, why = "";
  try { await run(); ok = true; } catch (e) { ok = false; why = ` [${e.status ?? ""} ${String(e.message).slice(0, 140)}]`; }
  const good = ok === shouldPass;
  if (!good) failures++;
  console.log(`  ${good ? "PASS" : "FAIL"}  ${label}: expected ${shouldPass ? "ALLOWED" : "REJECTED"}, got ${ok ? "ALLOWED" : "REJECTED"}${good ? "" : why}`);
}

// 7. Bot credentials file (goes to the VPS later, readable only by the bot user).
writeSecret("bot.env", [
  `PRIVY_APP_ID=${PRIVY_APP_ID}`,
  `PRIVY_APP_SECRET=${PRIVY_APP_SECRET}`,
  `PRIVY_WALLET_ID=${state.walletId}`,
  `PRIVY_WALLET_ADDRESS=${state.walletAddress}`,
  `PRIVY_BOT_SIGNER_ID=${state.botSignerId}`,
  `PRIVY_BOT_AUTH_KEY=${botPriv}`,
  "",
].join("\n"));

console.log(`\nwallet address: ${state.walletAddress}`);
console.log(`wSOL account:   ${ata.toBase58()}`);
console.log(`cold wallet:    ${cold.toBase58()}`);
console.log(failures ? `\n${failures} TEST(S) FAILED — do NOT fund this wallet yet.` : "\nALL TESTS PASSED — policy is enforced.");
