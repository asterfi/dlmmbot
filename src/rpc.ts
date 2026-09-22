import { Connection, type ConnectionConfig } from "@solana/web3.js";
import { env } from "./config.js";

/**
 * Per-attempt RPC timeout. A node that accepts the TCP connection and never
 * answers otherwise wedges the manager tick indefinitely — the one failure
 * shape the watchdog cannot help with, because the loop never gets to run it.
 */
const RPC_TIMEOUT_MS = 20_000;

/** Primary-side failures worth a second shot at the backup node. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Is this failure worth a bounded second attempt, or a real error to surface?
 *
 * The live tick proves the stakes: `enterNewPositions` reads the wallet before
 * it sizes anything, and one transient Helius 429 there aborts the whole
 * manager tick — the proposal goes stale and the entry is lost (logged
 * 2026-09-22: `Main loop interrupted: failed to get balance ... 429` sitting
 * directly under a `1/131 ... qualifying proposals` line).
 */
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
const TRANSIENT_MESSAGE = /\b(408|429|500|502|503|504)\b|too many requests|service unavailable|socket hang up|fetch failed|ETIMEDOUT|ESOCKETTIMEDOUT/i;

export function isTransientRpcError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : null;
  if (status !== null && TRANSIENT_STATUS.has(status)) return true;
  if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
  return typeof e.message === "string" && TRANSIENT_MESSAGE.test(e.message);
}

export interface RpcRetryOptions {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Backoff before attempt 2, 3, ... The last entry repeats. Default [400, 1500]. */
  delaysMs?: number[];
}

/**
 * Bounded retry for read-only RPC calls on the hot path.
 *
 * Deliberately narrow: it retries only when `isTransientRpcError` says the
 * failure was a rate-limit/connect blip, it never retries a domain error, and
 * it never retries past `attempts` — a stuck provider must fail the tick, not
 * hang it. Writes are not wrapped here; Solana dedupes by signature and the
 * acquisition-quarantine path owns ambiguous-send handling.
 */
export async function withRpcRetry<T>(fn: () => Promise<T>, opts: RpcRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const delays = opts.delaysMs?.length ? opts.delaysMs : [400, 1_500];
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isTransientRpcError(error)) throw error;
      const delay = delays[Math.min(attempt - 1, delays.length - 1)];
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * A Connection that actually honours RPC_URL_FALLBACK.
 *
 * The setting has been offered in the dashboard as "used if the primary RPC
 * fails" since it was added, but nothing read `env().rpcUrlFallback` — every
 * call site built its own `new Connection(env().rpcUrl)`, so a primary outage
 * took the bot down with a backup node configured and idle. That includes the
 * live boot path, where the failure mode is the bot refusing to start while
 * positions sit on chain.
 *
 * Failover is per-request, not per-process: each request tries the primary,
 * and on a connect-level throw or a retryable status tries the fallback once.
 * There is no stickiness — a primary that recovers is used again immediately,
 * and a fallback that is only needed for one request costs one extra call.
 *
 * Re-sending a transaction to a second node is safe: Solana dedupes by
 * signature, so the worst case is the same signed transaction reaching the
 * cluster twice, which is what any rebroadcast does anyway.
 */
export function makeConnection(config: ConnectionConfig = { commitment: "confirmed" }): Connection {
  const { rpcUrl, rpcUrlFallback } = env();
  return new Connection(rpcUrl, {
    ...config,
    disableRetryOnRateLimit: true,
    fetch: async (input, init) => {
      // A fresh signal per attempt: reusing the caller's would hand the
      // fallback an already-aborted signal after a primary timeout, so the
      // retry would fail instantly and the failover would be decorative.
      const send = (url: Parameters<typeof fetch>[0]) =>
        fetch(url, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
      if (!rpcUrlFallback) return send(input);
      try {
        const res = await send(input);
        if (!RETRYABLE_STATUS.has(res.status)) return res;
        void res.body?.cancel().catch(() => {});  // don't hold the socket open on a body we discard
      } catch (e) {
        // Only a connect/timeout failure reaches here; a bad request would
        // have come back as a response. Fall through to the backup node, but
        // keep the original error if that one is down too — it names the
        // endpoint the operator actually configured as primary.
        return send(rpcUrlFallback).catch(() => { throw e; });
      }
      return send(rpcUrlFallback);
    },
  });
}
