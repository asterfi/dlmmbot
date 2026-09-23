/**
 * One-time backfill for rent reclaims recorded BEFORE bookRentReclaim existed.
 *
 * closeEmptyAccounts wrote the events row but never credited
 * positions.recovered_sol, so REALIZED_PNL_SQL — which reads recovered_sol —
 * never saw money that had already landed in the wallet. pos#1 JEANPHIL and
 * pos#2 PAID each returned 0.001508818 SOL that stayed off the book.
 *
 * Idempotent on `detail.credited`, the marker bookRentReclaim now writes on
 * every credit: a receipt that already carries it was booked and is skipped.
 * Runs dry unless --apply, matching repair-close.
 *
 * Usage: npx tsx scripts/backfill-rent-reclaim.ts [--apply]
 */
import { getDb, REALIZED_PNL_SQL, now } from "../src/db/db.js";

interface ReclaimRow {
  id: number;
  position_id: number | null;
  sol_delta: number | null;
  detail_json: string | null;
}

const apply = process.argv.includes("--apply");
const db = getDb();

const rows = db
  .prepare(
    `SELECT id, position_id, sol_delta, detail_json
       FROM events WHERE type = 'rent_reclaim' ORDER BY id`,
  )
  .all() as ReclaimRow[];

if (!rows.length) {
  console.log("no rent_reclaim receipts found — nothing to backfill");
  process.exit(0);
}

let planned = 0;
let total = 0;

for (const ev of rows) {
  const detail = ev.detail_json ? (JSON.parse(ev.detail_json) as { credited?: number }) : {};

  // Already booked by bookRentReclaim or by an earlier run of this script.
  if (detail.credited !== undefined) {
    console.log(`ev#${ev.id}: already credited ${detail.credited} — skip`);
    continue;
  }

  // Withheld for the same reasons bookRentReclaim withholds it: no single
  // position owns a multi-account batch, or the delta was never fetched.
  if (ev.position_id === null) {
    console.log(`ev#${ev.id}: no position owns this receipt — cannot attribute, leave for reconciliation`);
    continue;
  }
  const delta = ev.sol_delta ?? 0;
  if (delta === 0) {
    console.log(`ev#${ev.id}: delta 0 — nothing to credit`);
    continue;
  }

  const row = db
    .prepare(`SELECT id, symbol, recovered_sol, (${REALIZED_PNL_SQL}) AS pnl FROM positions WHERE id = ?`)
    .get(ev.position_id) as { id: number; symbol: string; recovered_sol: number | null; pnl: number | null };
  const after = (row.recovered_sol ?? 0) + delta;

  console.log(
    `pos#${row.id} ${row.symbol}: recovered_sol ${(row.recovered_sol ?? 0).toFixed(9)} -> ${after.toFixed(9)}`
    + `  (+${delta.toFixed(9)})  realized ${row.pnl === null ? "?" : row.pnl.toFixed(6)}`
    + ` -> ${row.pnl === null ? "?" : (row.pnl + delta).toFixed(6)}`,
  );

  if (!apply) continue;
  planned++;
  total += delta;

  // Credit and marker in one transaction — a crash between them would leave
  // the row credited but still eligible here, i.e. double-bookable.
  db.transaction(() => {
    db.prepare("UPDATE positions SET recovered_sol = COALESCE(recovered_sol, 0) + ? WHERE id = ?").run(delta, ev.position_id);
    detail.credited = delta;
    db.prepare("UPDATE events SET detail_json = ? WHERE id = ?").run(JSON.stringify(detail), ev.id);
  })();
}

if (!apply) {
  console.log(`\n(dry run — pass --apply to write ${rows.length} receipt(s) checked)`);
} else {
  console.log(`\nWRITTEN: ${planned} credit(s), +${total.toFixed(9)} SOL — re-running is a no-op`);
}

db.close();
