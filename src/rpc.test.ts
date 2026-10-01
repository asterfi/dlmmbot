import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeConnection, parseRetryAfterMs, sendWithBackoff } from "./rpc.js";

const PRIMARY = "http://primary.test";
const BACKUP = "http://backup.test";

/** A minimal well-formed JSON-RPC reply for getSlot. */
function slotReply(slot: number, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", result: slot, id: "1" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function urlOf(input: unknown): string {
  return typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
}

describe("makeConnection RPC failover", () => {
  const saved = { url: process.env.RPC_URL, fallback: process.env.RPC_URL_FALLBACK };

  beforeEach(() => {
    process.env.RPC_URL = PRIMARY;
    process.env.RPC_URL_FALLBACK = BACKUP;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (saved.url === undefined) delete process.env.RPC_URL; else process.env.RPC_URL = saved.url;
    if (saved.fallback === undefined) delete process.env.RPC_URL_FALLBACK; else process.env.RPC_URL_FALLBACK = saved.fallback;
  });

  it("falls back to the backup node when the primary refuses the connection", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = urlOf(input);
      seen.push(url);
      // Exactly what undici throws for DNS/refused/TLS — the shape that took
      // the bot down at boot with a backup configured and unused.
      if (url.startsWith(PRIMARY)) throw new TypeError("fetch failed");
      return slotReply(4242);
    }));

    await expect(makeConnection().getSlot()).resolves.toBe(4242);
    expect(seen[0]).toContain("primary.test");
    expect(seen[1]).toContain("backup.test");
  });

  it("falls back on a retryable status (rate-limited primary)", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = urlOf(input);
      seen.push(url);
      if (url.startsWith(PRIMARY)) return new Response("slow down", { status: 429 });
      return slotReply(77);
    }));

    await expect(makeConnection().getSlot()).resolves.toBe(77);
    expect(seen.some((u) => u.includes("backup.test"))).toBe(true);
  });

  it("does not retry a primary response that simply is not retryable", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      seen.push(urlOf(input));
      return slotReply(9);
    }));

    await expect(makeConnection().getSlot()).resolves.toBe(9);
    expect(seen.every((u) => u.includes("primary.test"))).toBe(true);
  });

  it("surfaces the primary's error when no fallback is configured", async () => {
    delete process.env.RPC_URL_FALLBACK;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));

    await expect(makeConnection().getSlot()).rejects.toThrow(/fetch failed/);
  });

  it("keeps the primary's error when the fallback is down too", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      if (urlOf(input).startsWith(PRIMARY)) throw new TypeError("primary is down");
      throw new TypeError("backup is down too");
    }));

    await expect(makeConnection().getSlot()).rejects.toThrow(/primary is down/);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses an integer-seconds Retry-After", () => {
    const res = new Response(null, { status: 429, headers: { "retry-after": "2" } });
    expect(parseRetryAfterMs(res)).toBe(2000);
  });

  it("parses an HTTP-date Retry-After", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const res = new Response(null, { status: 429, headers: { "retry-after": future } });
    const ms = parseRetryAfterMs(res)!;
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(5100);
  });

  it("returns null when the header is absent", () => {
    expect(parseRetryAfterMs(new Response(null, { status: 429 }))).toBeNull();
  });
});

describe("sendWithBackoff", () => {
  it("returns immediately on a non-429 response, no backoff", async () => {
    const attempt = vi.fn(async () => new Response("ok", { status: 200 }));
    const res = await sendWithBackoff(attempt);
    expect(res.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After between attempts", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
      return new Response("ok", { status: 200 });
    });
    const p = sendWithBackoff(attempt);
    await vi.advanceTimersByTimeAsync(1300); // retry-after (1s) + max jitter (250ms) + margin
    const res = await p;
    expect(res.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("falls back to jittered exponential backoff with no Retry-After header", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls++;
      if (calls < 3) return new Response("slow down", { status: 429 });
      return new Response("ok", { status: 200 });
    });
    const p = sendWithBackoff(attempt);
    await vi.advanceTimersByTimeAsync(400 + 250);   // attempt 2 backoff
    await vi.advanceTimersByTimeAsync(800 + 250);   // attempt 3 backoff
    const res = await p;
    expect(res.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("gives up after maxAttempts and returns the last 429 rather than retrying forever", async () => {
    vi.useFakeTimers();
    const attempt = vi.fn(async () => new Response("still slow", { status: 429 }));
    const p = sendWithBackoff(attempt, 3);
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await p;
    expect(res.status).toBe(429);
    expect(attempt).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
