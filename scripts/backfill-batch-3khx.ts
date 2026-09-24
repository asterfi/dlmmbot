/**
 * Backfill the uncredited pre-fix batch ATA close.
 *   tx 3KHRxZdjjCufQ4qSZbJzkjkFXHCkR6QmYcW33DKRW3hYuztBWtNUZ5fQ9P3wk4cbYxDt1p6jy7GQbYptVP1Csccg
 *   2026-09-23T20:42:10Z, wallet delta +4,418,178 lamports (net of fee)
 * Closed mints → positions (preTokenBalances.accountIndex + preBalances):
 *   pos#3 CALI   GwoyFeshR3gtg8oGhF2azfAFnsVutMvFHCcB5fwhkVpm  1,513,840 lamports
 *   pos#4 KCAT   oxMACFpsHi38PwYQ8mV4q8JQF7BhtwwYiBdM7wN1uJE   1,513,840
 *   pos#5 WALTER CEH5YMWGziW8o7c725F5jTLVng9LMRHjtfy38m49TiRc  1,488,440
 * Pro-rata by pre-close lamports (mirrors allocateBatchReclaim), fee borne
 * pro-rata, last allocation absorbs the remainder so the sum equals the
 * measured wallet delta exactly (chain truth: booked total == wallet delta).
 *
 * Writes through the production bookRentReclaim (same shape as cde9207):
 * one rent_reclaim receipt keyed by tx_sig + three positions.recovered_sol
 * credits. Idempotent: the tx_sig check makes a re-run a no-op.
 * Dry-run by default; pass --apply to write.
 */
import { getDb } from "../src/db/db.js";
import { bookRentReclaim } from "../src/executor/live.js";

const TX =
  "3KHRxZdjjCufQ4qSZbJzkjkFXHCkR6QmYcW33DKRW3hYuztBWtNUZ5fQ9P3wk4cbYxDt1p6jy7GQbYptVP1Csccg";
const DELTA_SOL = 0.004418178; // chain truth: walletDelta = +4,418,178 lamports
const ACCOUNTS = [
  { positionId: 3, mint: "8k4sBtEeK4pf26noKqApv8NBTnuSJcbdwpKYknk5PbAA", symbol: "CALI", account: "GwoyFeshR3gtg8oGhF2azfAFnsVutMvFHCcB5fwhkVpm", lamports: 1513840 },
  { positionId: 4, mint: "MboMMGXjGDi45hfjCVzYru32kEM5nw7VzCqCofZpump", symbol: "KCAT", account: "oxMACFpsHi38PwYQ8mV4q8JQF7BhtwwYiBdM7wN1uJE", lamports: 1513840 },
  { positionId: 5, mint: "AbkkkbRU8SZ69sZWsykkeutL1sf1Ds1fiu1yDQ8mMVo7", symbol: "WALTER", account: "CEH5YMWGziW8o7c725F5jTLVng9LMRHjtfy38m49TiRc", lamports: 1488440 },
];

const deltaLamports = Math.round(DELTA_SOL * 1e9);
const totalLamports = ACCOUNTS.reduce((s, a) => s + a.lamports, 0);
const allocations = ACCOUNTS.map((a, i) => {
  const share =
    i < ACCOUNTS.length - 1 ? Math.floor((deltaLamports * a.lamports) / totalLamports) : 0;
  return { positionId: a.positionId, creditSol: share / 1e9, lamports: share };
});
const last = allocations[allocations.length - 1]!;
last.lamports = deltaLamports - allocations.slice(0, -1).reduce((s, x) => s + x.lamports, 0);
last.creditSol = last.lamports / 1e9;

const sum = allocations.reduce((s, a) => s + a.lamports, 0);
if (sum !== deltaLamports) throw new Error(`allocation sum ${sum} != delta ${deltaLamports}`);

const apply = process.argv.includes("--apply");
console.log(`tx ${TX}`);
console.log(`delta ${DELTA_SOL} SOL over ${ACCOUNTS.length} accounts (sum lamports ${totalLamports}):`);
for (const a of allocations) {
  console.log(`  pos#${a.positionId}: ${a.creditSol} SOL (${a.lamports} lamports)`);
}

if (!apply) {
  console.log("DRY RUN — pass --apply to write.");
  process.exit(0);
}

const db = getDb();
const seen = db.prepare("SELECT 1 FROM events WHERE type = 'rent_reclaim' AND tx_sig = ?").get(TX);
if (seen) {
  console.log("ALREADY BOOKED — no-op (idempotent).");
  process.exit(0);
}
const before = db
  .prepare("SELECT id, recovered_sol FROM positions WHERE id IN (3,4,5) ORDER BY id")
  .all();
const booked = bookRentReclaim({
  positionId: null,
  deltaSol: DELTA_SOL,
  txSig: TX,
  detail: {
    accounts: ACCOUNTS.map((a) => a.account),
    tokens: ACCOUNTS.map((a) => ({ mint: a.mint, symbol: a.symbol, account: a.account })),
    backfilledFrom: "chain:preBalances+preTokenBalances",
  },
  allocations: allocations.map((a) => ({ positionId: a.positionId, creditSol: a.creditSol })),
});
console.log(`bookRentReclaim wrote receipt: ${booked}`);
const after = db
  .prepare("SELECT id, recovered_sol FROM positions WHERE id IN (3,4,5) ORDER BY id")
  .all();
for (let i = 0; i < after.length; i++) {
  const b = after[i] as { id: number; recovered_sol: number };
  const p = (before[i] as { id: number; recovered_sol: number }).id;
  console.log(`  pos#${b.id}: recovered ${(before[i] as any).recovered_sol} → ${b.recovered_sol} (was ${p})`);
}
const credited = db
  .prepare("SELECT detail_json FROM events WHERE type = 'rent_reclaim' AND tx_sig = ?")
  .get(TX) as { detail_json: string };
console.log(`receipt detail: ${credited.detail_json}`);
console.log("APPLIED.");
