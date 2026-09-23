import type { VetResult } from "../types.js";
import { vetWithRetry } from "./vet.js";

/**
 * Cross-cycle vet cache.
 *
 * The enter path re-vets every recurring candidate on each ~65s cycle, but
 * vet's Helius cluster scan (paced 130ms x ~26 calls) costs ~3-4s. That latency
 * sits BEFORE the stale-quote guard, so it inflates measured scan->enter drift
 * and was pushing quote_stale skips to 10/hr — the reason hot tokens never
 * reached exec.open. Serving a recent verdict from cache cuts the window
 * without weakening any safety gate: verdicts are only reused for a bounded
 * TTL, different mints never share, and a thrown vet is never cached so
 * transient failures retry next cycle.
 */
const VET_CACHE_TTL_MS = 180_000; // 3 cycles — safety data cannot go meaningfully stale
const vetCache = new Map<string, { vet: VetResult; at: number }>();

export async function vetCached(
  mint: string,
  poolCreatedAtMs: number | null,
  nowMs: number = Date.now(),
): Promise<VetResult> {
  const hit = vetCache.get(mint);
  if (hit && nowMs - hit.at < VET_CACHE_TTL_MS) return hit.vet;
  // A rejection propagates without writing the cache — transient errors retry.
  const vet = await vetWithRetry(mint, poolCreatedAtMs);
  vetCache.set(mint, { vet, at: nowMs });
  return vet;
}

export function resetVetCacheForTests(): void {
  vetCache.clear();
}
