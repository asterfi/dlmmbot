import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTransientRpcError, makeConnection, withRpcRetry } from "./rpc.js";

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

  it("does not amplify a rate limit when both RPC endpoints return 429", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      seen.push(urlOf(input));
      return new Response("slow down", { status: 429 });
    }));

    await expect(makeConnection({ commitment: "confirmed", disableRetryOnRateLimit: false }).getSlot()).rejects.toThrow(/429|Too many requests/i);
    expect(seen).toEqual([PRIMARY, BACKUP]);
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

function rateLimit(message = "429 Too Many Requests: Too Many Requests"): Error & { status?: number } {
  const err = new Error(message) as Error & { status?: number };
  err.status = 429;
  return err;
}

describe("transient RPC error classification", () => {
  it("treats HTTP 429 / 5xx / timeout shapes as transient", () => {
    expect(isTransientRpcError(rateLimit())).toBe(true);
    expect(isTransientRpcError(rateLimit("Server responded with 429 Too Many Requests"))).toBe(true);
    expect(isTransientRpcError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isTransientRpcError(new Error("connect ETIMEDOUT"))).toBe(true);
    expect(isTransientRpcError(Object.assign(new Error("boom"), { status: 500 }))).toBe(true);
  });

  it("does not retry a client or domain error", () => {
    expect(isTransientRpcError(new Error("invalid account data"))).toBe(false);
    expect(isTransientRpcError(Object.assign(new Error("bad request"), { status: 400 }))).toBe(false);
    expect(isTransientRpcError("not an error")).toBe(false);
  });
});

describe("withRpcRetry", () => {
  it("retries a rate-limited read until it succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockResolvedValueOnce(0.5801);

    const value = await withRpcRetry(fn, { attempts: 3, delaysMs: [1, 1] });

    expect(value).toBe(0.5801);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after the bounded number of attempts", async () => {
    const fn = vi.fn().mockRejectedValue(rateLimit());

    await expect(withRpcRetry(fn, { attempts: 3, delaysMs: [1, 1] })).rejects.toThrow("429");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("never retries a non-transient error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("invalid account data"));

    await expect(withRpcRetry(fn, { attempts: 3, delaysMs: [1, 1] })).rejects.toThrow("invalid account data");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns the value on the first attempt without sleeping", async () => {
    const fn = vi.fn().mockResolvedValue(42);

    await expect(withRpcRetry(fn, { attempts: 3, delaysMs: [10_000] })).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
