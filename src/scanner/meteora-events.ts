import {
  PublicKey,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { config, SOL_MINT } from "../config.js";
import { getDb, logError, now } from "../db/db.js";
import { mapLimit } from "../concurrent.js";
import { makeConnection } from "../rpc.js";
import type { PoolInfo } from "../types.js";
import { fetchPool } from "./meteora.js";

/** Mainnet Meteora DLMM / lb_clmm program, verified from @meteora-ag/dlmm IDL. */
export const METEORA_DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

const CONFIRMED_CONFIG = {
  commitment: "confirmed" as const,
  maxSupportedTransactionVersion: 0 as const,
};

interface InitializationLayout {
  name: string;
  discriminator: readonly number[];
  poolAccount: number;
  mintXAccount: number;
  mintYAccount: number;
}

/**
 * Pool-creation instruction layouts from the Meteora DLMM IDL. The two
 * permissionless variants put lbPair/tokenMintX/tokenMintY at 0/2/3; the
 * permissioned legacy variant has a signer at account 0 and uses 1/3/4.
 */
const INITIALIZATION_LAYOUTS: readonly InitializationLayout[] = [
  {
    name: "initializeCustomizablePermissionlessLbPair",
    discriminator: [46, 39, 41, 135, 111, 183, 200, 64],
    poolAccount: 0,
    mintXAccount: 2,
    mintYAccount: 3,
  },
  {
    name: "initializeCustomizablePermissionlessLbPair2",
    discriminator: [243, 73, 129, 126, 51, 19, 241, 107],
    poolAccount: 0,
    mintXAccount: 2,
    mintYAccount: 3,
  },
  {
    name: "initializeLbPair",
    discriminator: [45, 154, 237, 210, 221, 15, 166, 92],
    poolAccount: 0,
    mintXAccount: 2,
    mintYAccount: 3,
  },
  {
    name: "initializeLbPair2",
    discriminator: [73, 59, 36, 120, 237, 83, 108, 198],
    poolAccount: 0,
    mintXAccount: 2,
    mintYAccount: 3,
  },
  {
    name: "initializePermissionLbPair",
    discriminator: [108, 102, 213, 85, 251, 3, 53, 21],
    poolAccount: 1,
    mintXAccount: 3,
    mintYAccount: 4,
  },
];

const LAYOUT_BY_DISCRIMINATOR = new Map(
  INITIALIZATION_LAYOUTS.map((layout) => [Buffer.from(layout.discriminator).toString("hex"), layout]),
);

export interface DiscoverySignature {
  signature: string;
  slot: number;
  blockTime?: number | null;
  err: unknown | null;
}

export interface MeteoraPoolEvent {
  signature: string;
  slot: number;
  blockTime: number | null;
  instructionIndex: string;
  instruction: string;
  pool: string;
  mintX: string;
  mintY: string;
  observedTs: number;
}

export interface DiscoveryRpcClient {
  getSignaturesForAddress(
    address: PublicKey,
    options: { limit: number; before?: string; until?: string },
  ): Promise<DiscoverySignature[]>;
  getParsedTransactions(
    signatures: string[],
    config: typeof CONFIRMED_CONFIG,
  ): Promise<Array<ParsedTransactionWithMeta | null>>;
}

export interface MeteoraDiscoveryResult {
  enabled: boolean;
  signaturesFetched: number;
  signaturesParsed: number;
  eventsFound: number;
  unavailableSignatures: number;
  backlogCapped: boolean;
  windowTruncated: boolean;
  pools: Array<PoolInfo & { extras: import("./meteora.js").RawPoolExtras }>;
  tokenMints: string[];
}

function isPartiallyDecodedInstruction(
  instruction: ParsedInstruction | PartiallyDecodedInstruction,
): instruction is PartiallyDecodedInstruction {
  return "data" in instruction && typeof instruction.data === "string" && "accounts" in instruction;
}

function publicKeyString(value: unknown): string | null {
  let candidate: string | null = null;
  if (value instanceof PublicKey) candidate = value.toBase58();
  else if (typeof value === "string") candidate = value;
  else if (value && typeof value === "object" && "toBase58" in value && typeof value.toBase58 === "function") {
    const result = value.toBase58();
    candidate = typeof result === "string" ? result : null;
  }
  if (!candidate) return null;
  try {
    return new PublicKey(candidate).toBase58();
  } catch {
    return null;
  }
}

function instructionList(tx: ParsedTransactionWithMeta): Array<{
  index: string;
  instruction: ParsedInstruction | PartiallyDecodedInstruction;
}> {
  const out: Array<{ index: string; instruction: ParsedInstruction | PartiallyDecodedInstruction }> = [];
  tx.transaction.message.instructions.forEach((instruction, index) => {
    out.push({ index: String(index), instruction });
  });
  for (const inner of tx.meta?.innerInstructions ?? []) {
    inner.instructions.forEach((instruction, index) => {
      out.push({ index: `${inner.index}.${index}`, instruction });
    });
  }
  return out;
}

/**
 * Pure transaction decoder. It uses instruction discriminators and account
 * positions from the published Meteora IDL, never guesses a pool from a mint.
 */
export function parseMeteoraPoolEvents(
  tx: ParsedTransactionWithMeta,
  signature: string,
  observedTs = now(),
): MeteoraPoolEvent[] {
  const out: MeteoraPoolEvent[] = [];
  for (const { index, instruction } of instructionList(tx)) {
    if (!isPartiallyDecodedInstruction(instruction)) continue;
    const programId = publicKeyString(instruction.programId);
    if (programId !== METEORA_DLMM_PROGRAM_ID) continue;

    let bytes: Uint8Array;
    try {
      bytes = bs58.decode(instruction.data);
    } catch {
      continue;
    }
    const layout = LAYOUT_BY_DISCRIMINATOR.get(Buffer.from(bytes.subarray(0, 8)).toString("hex"));
    if (!layout) continue;

    const accounts = instruction.accounts ?? [];
    const pool = publicKeyString(accounts[layout.poolAccount]);
    const mintX = publicKeyString(accounts[layout.mintXAccount]);
    const mintY = publicKeyString(accounts[layout.mintYAccount]);
    if (!pool || !mintX || !mintY || pool === mintX || pool === mintY || mintX === mintY) continue;

    out.push({
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime ?? null,
      instructionIndex: index,
      instruction: layout.name,
      pool,
      mintX,
      mintY,
      observedTs,
    });
  }
  return out;
}

function connectionClient(): DiscoveryRpcClient {
  return makeConnection({ commitment: "confirmed" });
}

function stateValue(db: ReturnType<typeof getDb>, key: string): string | null {
  const row = db.prepare("SELECT value FROM discovery_state WHERE key = ?").get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

function saveState(db: ReturnType<typeof getDb>, key: string, value: string): void {
  db.prepare(
    "INSERT INTO discovery_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

function insertSignature(
  db: ReturnType<typeof getDb>,
  row: DiscoverySignature,
  observedTs: number,
  maxPending: number,
): boolean {
  const exists = db.prepare("SELECT 1 AS present FROM discovery_signatures WHERE signature = ?").get(row.signature);
  if (exists) return true;
  const pending = (db.prepare("SELECT COUNT(*) AS count FROM discovery_signatures WHERE status = 'pending'").get() as { count: number }).count;
  if (pending >= maxPending) return false;
  db.prepare(
    `INSERT INTO discovery_signatures
      (signature, slot, block_time, observed_ts, status, attempts, processed_ts)
     VALUES (?, ?, ?, ?, 'pending', 0, NULL)`,
  ).run(row.signature, row.slot, row.blockTime ?? null, observedTs);
  return true;
}

function insertBackfillRange(
  db: ReturnType<typeof getDb>,
  beforeSignature: string,
  untilSignature: string,
  createdTs: number,
  maxRanges: number,
): boolean {
  const exists = db.prepare(
    "SELECT 1 AS present FROM discovery_backfill_ranges WHERE before_signature = ? AND until_signature = ?",
  ).get(beforeSignature, untilSignature);
  if (exists) return true;
  const count = (db.prepare("SELECT COUNT(*) AS count FROM discovery_backfill_ranges").get() as { count: number }).count;
  if (count >= maxRanges) return false;
  db.prepare(
    `INSERT INTO discovery_backfill_ranges
      (before_signature, until_signature, created_ts)
     VALUES (?, ?, ?)`,
  ).run(beforeSignature, untilSignature, createdTs);
  return true;
}

function oldestBackfillRange(db: ReturnType<typeof getDb>): { id: number; beforeSignature: string; untilSignature: string } | null {
  const row = db.prepare(
    `SELECT id, before_signature AS beforeSignature, until_signature AS untilSignature
       FROM discovery_backfill_ranges
      ORDER BY id ASC
      LIMIT 1`,
  ).get() as { id: number; beforeSignature: string; untilSignature: string } | undefined;
  return row ?? null;
}

function advanceBackfillRange(
  db: ReturnType<typeof getDb>,
  range: { id: number },
  nextBefore: string | null,
  complete: boolean,
): void {
  if (complete || !nextBefore) {
    db.prepare("DELETE FROM discovery_backfill_ranges WHERE id = ?").run(range.id);
    return;
  }
  db.prepare("UPDATE discovery_backfill_ranges SET before_signature = ? WHERE id = ?").run(nextBefore, range.id);
}

function pendingSignatures(db: ReturnType<typeof getDb>, limit: number): DiscoverySignature[] {
  return db.prepare(
    `SELECT signature, slot, block_time AS blockTime
       FROM discovery_signatures
      WHERE status = 'pending'
      ORDER BY slot ASC, rowid ASC
      LIMIT ?`,
  ).all(Math.max(1, Math.min(100, limit))).map((row) => ({
    ...(row as { signature: string; slot: number; blockTime: number | null }),
    err: null,
  }));
}

function unavailableSignatureCount(db: ReturnType<typeof getDb>): number {
  const cutoff = now() - Math.max(60, config().discovery.event_ttl_s);
  return (db.prepare(
    "SELECT COUNT(*) AS count FROM discovery_signatures WHERE status = 'unavailable' AND COALESCE(processed_ts, observed_ts) >= ?",
  ).get(cutoff) as { count: number }).count;
}
function markSignatureProcessed(db: ReturnType<typeof getDb>, signature: string, processedTs: number): void {
  db.prepare(
    "UPDATE discovery_signatures SET status = 'processed', processed_ts = ? WHERE signature = ?",
  ).run(processedTs, signature);
}

function noteSignatureRetry(
  db: ReturnType<typeof getDb>,
  signature: string,
  processedTs: number,
  maxAttempts: number,
): void {
  db.prepare(
    `UPDATE discovery_signatures
        SET attempts = attempts + 1,
            status = CASE WHEN attempts + 1 >= ? THEN 'unavailable' ELSE 'pending' END,
            processed_ts = CASE WHEN attempts + 1 >= ? THEN ? ELSE NULL END
      WHERE signature = ?`,
  ).run(maxAttempts, maxAttempts, processedTs, signature);
}

function insertEvent(db: ReturnType<typeof getDb>, event: MeteoraPoolEvent): void {
  db.prepare(
    `INSERT OR IGNORE INTO discovery_pool_events
      (signature, instruction_index, slot, block_time, pool, mint_x, mint_y, instruction, observed_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.signature,
    event.instructionIndex,
    event.slot,
    event.blockTime,
    event.pool,
    event.mintX,
    event.mintY,
    event.instruction,
    event.observedTs,
  );
}

interface SignaturePageBatch {
  rows: DiscoverySignature[];
  truncated: boolean;
  nextBefore: string | null;
  reachedUntil: boolean;
}

async function collectSignaturePages(
  client: DiscoveryRpcClient,
  pageSize: number,
  maxPages: number,
  before: string | undefined,
  until: string | undefined,
): Promise<SignaturePageBatch> {
  const rows: DiscoverySignature[] = [];
  let cursor = before;
  let truncated = false;
  let reachedUntil = false;
  for (let page = 0; page < maxPages; page++) {
    const options: { limit: number; before?: string; until?: string } = { limit: pageSize };
    if (cursor) options.before = cursor;
    if (until) options.until = until;
    const pageRows = await client.getSignaturesForAddress(new PublicKey(METEORA_DLMM_PROGRAM_ID), options);
    if (!pageRows.length) break;
    const normalizedRows = pageRows
      .filter((row) => typeof row.signature === "string" && row.signature.length > 0)
      .map((row) => ({
        ...row,
        slot: Number.isSafeInteger(row.slot) ? row.slot : 0,
      }));
    if (!normalizedRows.length) {
      truncated = true;
      break;
    }
    rows.push(...normalizedRows);
    if (until && pageRows.some((row) => row.signature === until)) {
      reachedUntil = true;
      break;
    }
    if (pageRows.length < pageSize) break;
    const pageCursor = pageRows[pageRows.length - 1]?.signature;
    if (!pageCursor) {
      truncated = true;
      break;
    }
    cursor = pageCursor;
    if (page === maxPages - 1) truncated = true;
  }
  return { rows, truncated, nextBefore: cursor ?? null, reachedUntil };
}

async function pollSignatures(
  client: DiscoveryRpcClient,
  db: ReturnType<typeof getDb>,
): Promise<{ fetched: number; parsed: number; events: MeteoraPoolEvent[]; unavailable: number; backlogCapped: boolean; windowTruncated: boolean }> {
  const d = config().discovery;
  const pageSize = Math.max(1, Math.min(1000, d.max_signatures_per_poll));
  const maxPages = Math.max(1, Math.min(20, d.max_signature_pages_per_poll));
  const previousHead = stateValue(db, "meteora_head_signature");
  const headBatch = await collectSignaturePages(client, pageSize, maxPages, undefined, previousHead ?? undefined);
  const backfillRange = oldestBackfillRange(db);
  const backfillBatch = backfillRange
    ? await collectSignaturePages(client, pageSize, maxPages, backfillRange.beforeSignature, backfillRange.untilSignature)
    : null;
  const fetchedRows: DiscoverySignature[] = [];
  const seenInPoll = new Set<string>();
  for (const row of [...headBatch.rows, ...(backfillBatch?.rows ?? [])]) {
    if (seenInPoll.has(row.signature)) continue;
    seenInPoll.add(row.signature);
    fetchedRows.push(row);
  }

  const observedTs = now();
  const head = headBatch.rows[0]?.signature;
  const maxPending = Number.isFinite(d.max_pending_signatures)
    ? Math.max(1, Math.min(100_000, d.max_pending_signatures))
    : 1_000;
  const maxRanges = Number.isFinite(d.max_backfill_ranges)
    ? Math.max(1, Math.min(100, d.max_backfill_ranges))
    : 8;
  let backlogCapped = false;
  let pendingDropped = 0;
  const insert = db.transaction(() => {
    for (const row of fetchedRows) {
      if (!insertSignature(db, row, observedTs, maxPending)) {
        backlogCapped = true;
        pendingDropped++;
      }
    }
    let canAdvanceHead = pendingDropped === 0;
    if (headBatch.truncated && previousHead && headBatch.nextBefore) {
      if (!insertBackfillRange(db, headBatch.nextBefore, previousHead, observedTs, maxRanges)) {
        backlogCapped = true;
        canAdvanceHead = false;
      }
    }
    if (head && canAdvanceHead) saveState(db, "meteora_head_signature", head);
    if (backfillRange && backfillBatch) {
      advanceBackfillRange(
        db,
        backfillRange,
        backfillBatch.nextBefore,
        !backfillBatch.truncated || backfillBatch.reachedUntil || backfillBatch.rows.length === 0,
      );
    }
  });
  insert();

  const windowTruncated = headBatch.truncated || Boolean(backfillBatch?.truncated);
  if (backlogCapped) {
    logError({
      source: "scanner",
      code: "meteora_event_backlog_capped",
      level: "warn",
      message: "Meteora event intake backlog cap reached; cursors remain conservative until pending work drains",
      dedupeSec: 300,
      detail: {
        maxPending,
        maxRanges,
        pendingDropped,
      },
    });
  }
  if (windowTruncated) {
    logError({
      source: "scanner",
      code: "meteora_event_window_full",
      level: "warn",
      message: "Meteora event signature window reached its page bound; a persistent backfill cursor was retained",
      dedupeSec: 300,
      detail: {
        pageSize,
        maxPages,
        fetched: fetchedRows.length,
        backfill: Boolean(backfillRange),
      },
    });
  }

  const pending = pendingSignatures(db, d.max_transactions_per_poll);
  if (!pending.length) return {
    fetched: fetchedRows.length,
    parsed: 0,
    events: [],
    unavailable: unavailableSignatureCount(db),
    backlogCapped,
    windowTruncated,
  };
  let transactions: Array<ParsedTransactionWithMeta | null>;
  try {
    const response = await client.getParsedTransactions(
      pending.map((row) => row.signature),
      CONFIRMED_CONFIG,
    );
    if (!Array.isArray(response)) throw new Error("parsed transaction response was not an array");
    transactions = response;
  } catch (error) {
    const retryTs = now();
    const retry = db.transaction(() => {
      for (const row of pending) {
        noteSignatureRetry(
          db,
          row.signature,
          retryTs,
          Math.max(1, Math.min(10, d.max_transaction_retries)),
        );
      }
    });
    retry();
    logError({
      source: "scanner",
      code: "meteora_event_tx_fetch",
      level: "warn",
      message: `Meteora parsed transaction batch failed: ${(error as Error).message}`.slice(0, 800),
      dedupeSec: 120,
      detail: { pending: pending.length },
    });
    return {
      fetched: fetchedRows.length,
      parsed: 0,
      events: [],
      unavailable: unavailableSignatureCount(db),
      backlogCapped,
      windowTruncated,
    };
  }
  const events: MeteoraPoolEvent[] = [];
  let parsedCount = 0;
  const processedTs = now();
  const write = db.transaction(() => {
    for (let i = 0; i < pending.length; i++) {
      const row = pending[i]!;
      const tx = transactions[i] ?? null;
      if (!tx) {
        noteSignatureRetry(
          db,
          row.signature,
          processedTs,
          Math.max(1, Math.min(10, d.max_transaction_retries)),
        );
        continue;
      }
      try {
        parsedCount++;
        markSignatureProcessed(db, row.signature, processedTs);
        if (tx.meta?.err) continue;
        for (const event of parseMeteoraPoolEvents(tx, row.signature, processedTs)) {
          insertEvent(db, event);
          events.push(event);
        }
      } catch (error) {
        noteSignatureRetry(
          db,
          row.signature,
          processedTs,
          Math.max(1, Math.min(10, d.max_transaction_retries)),
        );
        logError({
          source: "scanner",
          code: "meteora_event_tx_decode",
          level: "warn",
          message: `Meteora transaction ${row.signature} could not be decoded: ${(error as Error).message}`.slice(0, 800),
          dedupeSec: 300,
          detail: { signature: row.signature },
        });
      }
    }
  });
  write();
  return {
    fetched: fetchedRows.length,
    parsed: parsedCount,
    events,
    unavailable: unavailableSignatureCount(db),
    backlogCapped,
    windowTruncated,
  };
}

function recentEventPools(db: ReturnType<typeof getDb>): Array<{
  pool: string;
  mintX: string;
  mintY: string;
}> {
  const d = config().discovery;
  const cutoff = now() - Math.max(60, d.event_ttl_s);
  const rows = db.prepare(
    `SELECT pool, mint_x AS mintX, mint_y AS mintY
       FROM discovery_pool_events
      WHERE observed_ts >= ?
      ORDER BY slot DESC
      LIMIT ?`,
  ).all(cutoff, Math.max(1, Math.min(500, d.max_event_pools))) as Array<{
    pool: string;
    mintX: string;
    mintY: string;
  }>;
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (!row.pool || seen.has(row.pool)) return false;
    seen.add(row.pool);
    return true;
  });
}

function sameMintSet(a: { mintX: string; mintY: string }, b: PoolInfo): boolean {
  const eventMints = new Set([a.mintX, a.mintY]);
  const poolMints = new Set([b.mintX, b.mintY]);
  return eventMints.size === 2
    && poolMints.size === 2
    && eventMints.size === poolMints.size
    && [...eventMints].every((mint) => poolMints.has(mint));
}

let poolCache: { at: number; byAddress: Map<string, PoolInfo & { extras: import("./meteora.js").RawPoolExtras } | null> } | null = null;

async function resolveRecentPools(
  db: ReturnType<typeof getDb>,
): Promise<Array<PoolInfo & { extras: import("./meteora.js").RawPoolExtras }>> {
  const eventRows = recentEventPools(db);
  if (!eventRows.length) return [];
  const current = Date.now();
  const byAddress = poolCache && current - poolCache.at <= 30_000
    ? new Map(poolCache.byAddress)
    : new Map<string, PoolInfo & { extras: import("./meteora.js").RawPoolExtras } | null>();
  const addresses = eventRows
    .map((row) => row.pool)
    .filter((address) => !byAddress.has(address));
  if (addresses.length) {
    const fetched = await mapLimit(
      addresses,
      async (address) => {
        try {
          return [address, await fetchPool(address)] as const;
        } catch (error) {
          logError({
            source: "scanner",
            code: "event_pool_fetch",
            level: "warn",
            message: `Meteora event pool ${address} fetch failed: ${(error as Error).message}`.slice(0, 800),
            dedupeSec: 300,
            detail: { pool: address },
          });
          return [address, null] as const;
        }
      },
      Math.max(1, Math.min(8, config().discovery.pool_fetch_concurrency)),
    );
    for (const [address, pool] of fetched) byAddress.set(address, pool);
  }
  poolCache = { at: current, byAddress };

  const out: Array<PoolInfo & { extras: import("./meteora.js").RawPoolExtras }> = [];
  for (const row of eventRows) {
    const pool = byAddress.get(row.pool);
    if (!pool) continue;
    if (pool.isBlacklisted === true) {
      logError({
        source: "scanner",
        code: "event_pool_blacklisted",
        level: "warn",
        message: `Meteora event pool ${row.pool} is blacklisted by Datapi; dropping event`,
        dedupeSec: 300,
        detail: { pool: row.pool },
      });
      continue;
    }
    if (pool.address !== row.pool) {
      logError({
        source: "scanner",
        code: "event_pool_address_mismatch",
        level: "warn",
        message: `Meteora event pool ${row.pool} resolved to Datapi address ${pool.address}; dropping event`,
        dedupeSec: 300,
        detail: { requestedPool: row.pool, datapiPool: pool.address },
      });
      continue;
    }
    if (!sameMintSet(row, pool)) {
      logError({
        source: "scanner",
        code: "event_pool_identity_mismatch",
        level: "warn",
        message: `Meteora event pool ${row.pool} mint identity did not match Datapi; dropping event`,
        dedupeSec: 300,
        detail: { eventMintX: row.mintX, eventMintY: row.mintY, datapiMintX: pool.mintX, datapiMintY: pool.mintY },
      });
      continue;
    }
    out.push(pool);
  }
  return out;
}

/**
 * Poll the bounded event window, persist exact initialization evidence, then
 * resolve only those exact pool addresses through Datapi. A discovery outage
 * degrades to an empty supplemental source; the existing sweep remains intact.
 */
export async function discoverRecentMeteoraPools(
  client?: DiscoveryRpcClient,
): Promise<MeteoraDiscoveryResult> {
  const d = config().discovery;
  if (!d.event_intake_enabled) {
    return {
      enabled: false,
      signaturesFetched: 0,
      signaturesParsed: 0,
      eventsFound: 0,
      unavailableSignatures: 0,
      backlogCapped: false,
      windowTruncated: false,
      pools: [],
      tokenMints: [],
    };
  }

  const db = getDb();
  let polled: { fetched: number; parsed: number; events: MeteoraPoolEvent[]; unavailable: number; backlogCapped: boolean; windowTruncated: boolean };
  try {
    polled = await pollSignatures(client ?? connectionClient(), db);
  } catch (error) {
    logError({
      source: "scanner",
      code: "meteora_event_poll",
      level: "warn",
      message: `Meteora event poll failed: ${(error as Error).message}`.slice(0, 800),
      dedupeSec: 120,
    });
    return {
      enabled: true,
      signaturesFetched: 0,
      signaturesParsed: 0,
      eventsFound: 0,
      unavailableSignatures: 0,
      backlogCapped: false,
      windowTruncated: false,
      pools: [],
      tokenMints: [],
    };
  }

  let pools: Array<PoolInfo & { extras: import("./meteora.js").RawPoolExtras }> = [];
  try {
    pools = await resolveRecentPools(db);
  } catch (error) {
    logError({
      source: "scanner",
      code: "meteora_event_resolve",
      level: "warn",
      message: `Meteora event pool resolution failed: ${(error as Error).message}`.slice(0, 800),
      dedupeSec: 120,
    });
  }

  const tokenMints = [...new Set(
    pools
      .flatMap((pool) => [pool.mintX, pool.mintY])
      .filter((mint) => mint && mint !== SOL_MINT),
  )];
  return {
    enabled: true,
    signaturesFetched: polled.fetched,
    signaturesParsed: polled.parsed,
    eventsFound: polled.events.length,
    unavailableSignatures: polled.unavailable,
    backlogCapped: polled.backlogCapped,
    windowTruncated: polled.windowTruncated,
    pools,
    tokenMints,
  };
}

/** Test hook for process-local Datapi resolution cache. */
export function _resetMeteoraEventCacheForTests(): void {
  poolCache = null;
}
