/**
 * HTTP client for the TypeSafe System One API (api.typesafe.ai/v1/systemone).
 *
 * Originally ported from hermes-projects/dlmmbot's src/strategy/jev/client.ts
 * (that contract was verified live: a raw `POST {}` returns 422 requiring
 * `model` and `questions`). Retry policy per docs.typesafe.ai: 429/529 get
 * exponential backoff (honoring a `retry_after`/`retry-after` hint when the
 * API provides one), bounded by the overall timeout so a consult never
 * exceeds its deadline regardless of how many retries fire. 401 is a loud
 * one-time operator problem (index.ts alerts); 422 is OUR bug (index.ts
 * alerts + logs the body). The API key exists only in the Authorization
 * header (a Headers instance, which does not serialize into logs).
 */
import type { JevQuestion } from "./types.js";

const API_URL = "https://api.typesafe.ai/v1/systemone";
const RETRY_STATUSES = new Set([429, 529]);
const MAX_ATTEMPTS = 3;
const MIN_RETRY_MS = 200; // don't bother retrying with less than this much deadline left

export interface JevRequestOptions {
  timeoutMs: number;
  maxResponseBytes: number;
}

export type JevRequestResult =
  | {
      ok: true;
      answers: Record<string, unknown>;
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      attempts: number;
      latencyMs: number;
    }
  | { ok: false; error: string; detail?: string; attempts: number; latencyMs: number };

export interface JevRequestPayload {
  state: Record<string, unknown>;
  model: string;
  questions: Record<string, JevQuestion>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter, honoring a server-provided retry hint when present. */
function backoffMs(attempt: number, retryAfterSec: number | null): number {
  if (retryAfterSec !== null && Number.isFinite(retryAfterSec) && retryAfterSec >= 0) {
    return Math.round(retryAfterSec * 1000);
  }
  const base = 250 * 2 ** (attempt - 1); // 250, 500, 1000...
  return base + Math.floor(Math.random() * 251);
}

function retryAfterFromBody(body: unknown): number | null {
  if (body === null || typeof body !== "object") return null;
  const v = (body as { retry_after?: unknown; retryAfter?: unknown }).retry_after
    ?? (body as { retryAfter?: unknown }).retryAfter;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function jevRequest(payload: JevRequestPayload, opts: JevRequestOptions): Promise<JevRequestResult> {
  const started = Date.now();
  let attempts = 0;
  const fail = (error: string, detail?: string): JevRequestResult => ({
    ok: false,
    error,
    ...(detail === undefined ? {} : { detail }),
    attempts,
    latencyMs: Date.now() - started,
  });

  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return fail("no_api_key");

  const deadline = started + opts.timeoutMs;
  const body = JSON.stringify(payload);

  for (;;) {
    attempts++;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return fail("timeout");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: new Headers({ "content-type": "application/json", authorization: `Bearer ${key}` }),
        body,
        signal: controller.signal,
      });

      if (res.status === 401) return fail("401");
      if (res.status === 422) {
        const detail = await res.text().catch(() => "");
        return fail("422", detail);
      }
      if (RETRY_STATUSES.has(res.status)) {
        const left = deadline - Date.now();
        if (attempts < MAX_ATTEMPTS && left >= MIN_RETRY_MS) {
          const headerRetry = res.headers.get("retry-after");
          let retryAfterSec = headerRetry !== null ? Number(headerRetry) : null;
          if (retryAfterSec === null || !Number.isFinite(retryAfterSec)) {
            const json = await res.json().catch(() => null);
            retryAfterSec = retryAfterFromBody(json);
          }
          const wait = Math.min(backoffMs(attempts, retryAfterSec), Math.max(0, left - 50));
          if (wait > 0) await sleep(wait);
          continue;
        }
        return fail(String(res.status));
      }
      if (res.status !== 200) return fail(`http_${res.status}`);

      const text = await res.text();
      if (Buffer.byteLength(text, "utf8") > opts.maxResponseBytes) return fail("parse_too_large");

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return fail("parse_json");
      }
      if (parsed === null || typeof parsed !== "object") return fail("parse_json");
      const env = parsed as { answers?: unknown; model?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
      const answers = env.answers;
      if (answers === null || answers === undefined || typeof answers !== "object") return fail("parse_missing_answer");
      for (const [id, q] of Object.entries(payload.questions)) {
        const a = (answers as Record<string, unknown>)[id];
        if (a === null || a === undefined || typeof a !== "object") return fail("parse_missing_answer");
        if ((a as { type?: unknown }).type !== q.type) return fail("parse_answer_type");
      }
      const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      return {
        ok: true,
        answers: answers as Record<string, unknown>,
        model: typeof env.model === "string" ? env.model : null,
        inputTokens: num(env.usage?.input_tokens),
        outputTokens: num(env.usage?.output_tokens),
        attempts,
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      if (controller.signal.aborted) return fail("timeout");
      return fail(e instanceof Error ? e.constructor.name : "Error");
    } finally {
      clearTimeout(timer);
    }
  }
}
