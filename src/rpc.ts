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
 * Backoff for a RATE-LIMITED primary when there is NO fallback configured
 * (2026-10-02). With no backup node, the old code just handed a bare 429
 * straight through to @solana/web3.js's own internal retry — which has no
 * jitter and no Retry-After awareness, and on this host's Helius plan that
 * produced storms of 15-20+ consecutive "Server responded with 429... Retrying
 * after Nms delay" log lines per vetted token (measured 2026-10-01, see the
 * input-coverage report: 15 tokens took 3m10s to vet). The WITH-fallback path
 * is untouched — falling over to a working backup immediately is strictly
 * better than retrying a failing primary, and that behavior is tested.
 */
const BACKOFF_MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 400;
const BACKOFF_MAX_MS = 6_000;
const BACKOFF_JITTER_MS = 250;

/** `Retry-After` is seconds (an integer) or an HTTP-date; either form is legal. */
export function parseRetryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const dateMs = Date.parse(h);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a single host on 429 with jittered backoff, honoring `Retry-After`
 * when the server sends one. Exported for tests (fetch is injected, no real
 * network/timers needed).
 */
export async function sendWithBackoff(
  attempt: () => Promise<Response>,
  maxAttempts = BACKOFF_MAX_ATTEMPTS,
): Promise<Response> {
  let res: Response | null = null;
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      const retryAfterMs = res ? parseRetryAfterMs(res) : null;
      const backoff = retryAfterMs ?? Math.min(BACKOFF_BASE_MS * 2 ** (i - 1), BACKOFF_MAX_MS);
      await sleep(backoff + Math.floor(Math.random() * BACKOFF_JITTER_MS));
    }
    if (res) void res.body?.cancel().catch(() => {});
    res = await attempt();
    if (res.status !== 429) return res;
  }
  return res!; // exhausted — hand the last 429 back to the caller rather than retry forever
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
    fetch: async (input, init) => {
      // A fresh signal per attempt: reusing the caller's would hand the
      // fallback an already-aborted signal after a primary timeout, so the
      // retry would fail instantly and the failover would be decorative.
      const send = (url: Parameters<typeof fetch>[0]) =>
        fetch(url, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
      if (!rpcUrlFallback) return sendWithBackoff(() => send(input));
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
