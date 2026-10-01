/**
 * jevConsult fallback + policy matrix. No network ever runs here — fetch is
 * stubbed per test. TELEGRAM_* are explicitly unset so the 401/422 alert path
 * never attempts a real send regardless of the host's environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jevConsult, _resetJevStateForTests } from "./index.js";
import { installConfig, restoreConfig } from "../../test/config.js";
import { useMemoryDb, resetTestDb } from "../../test/db.js";
import { getDb } from "../../db/db.js";

const json = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function lastDecisionRow(): any {
  return getDb().prepare("SELECT * FROM jev_decisions ORDER BY id DESC LIMIT 1").get();
}

const GOOD_ENTRY_ANSWERS = {
  redflag_wash_volume: { type: "noul", noul: 0.1 },
  redflag_security: { type: "noul", noul: 0.1 },
  redflag_exhausted_spike: { type: "noul", noul: 0.1 },
  redflag_insider_dumping: { type: "noul", noul: 0.1 },
  redflag_stablecoin_major: { type: "noul", noul: 0.05 },
  positive_fresh_flow: { type: "noul", noul: 0.9 },
  positive_fee_generation_sol: { type: "noul", noul: 0.9 },
  positive_bounce_confirmed: { type: "noul", noul: 0.9 },
  positive_narrative_strength: { type: "noul", noul: 0.5 },
  play: { type: "choice", choice: "eys_seat", probabilities: { eys_seat: 0.9 }, confidence: 0.9 },
};

beforeEach(() => {
  useMemoryDb();
  _resetJevStateForTests();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  installConfig((c) => {
    c.jev = {
      enabled: true, model: "jev-1.13.0", timeout_ms: 500, max_concurrent: 4, max_consults_per_min: 100,
      redflag_veto: 0.6, play_prob_min: 0.3, uncertain_low: 0.45, uncertain_high: 0.55,
      weight_fresh_flow: 0.3, weight_fee_generation: 0.3, weight_bounce: 0.25, weight_narrative: 0.15,
      entry_threshold_molu_ladder: 0.6, entry_threshold_danko_trap: 0.6, entry_threshold_eys_seat: 0.55, entry_threshold_eys_ape: 0.7,
    };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  restoreConfig();
  resetTestDb();
});

const enterInput = (overrides: Partial<Parameters<typeof jevConsult>[0]> = {}) => ({
  lane: "enter" as const,
  state: { candidate: { rule_play: "eys_seat" } },
  fallbackVerdict: "yes" as const,
  play: "eys_seat", mint: "MINT", pool: "POOL", question: "enter with play eys_seat?",
  ...overrides,
});

describe("jevConsult — transport fallback paths", () => {
  it("disabled: falls back without calling fetch", async () => {
    installConfig((c) => { c.jev = { enabled: false }; });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await jevConsult(enterInput());
    expect(r.consulted).toBe(false);
    expect(r.fallback).toBe(true);
    expect(r.outcome).toBe("disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no API key: falls back", async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const r = await jevConsult(enterInput({ fallbackVerdict: "no" }));
      expect(r.fallback).toBe(true);
      expect(r.verdict).toBe("no");
      expect(r.outcome).toBe("no_api_key");
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
  });

  it("timeout: falls back to the rule verdict on a hung request", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    const hang = (_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    vi.stubGlobal("fetch", vi.fn(hang));
    const r = await jevConsult(enterInput({ fallbackVerdict: "yes" }));
    expect(r.fallback).toBe(true);
    expect(r.outcome).toBe("timeout");
    expect(r.verdict).toBe("yes");
  }, 2000);

  it("401: falls back and logs the outcome (loud one-time alert path, no real send without TELEGRAM_*)", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "bad-key");
    const fetchMock = vi.fn(async () => json({ error: "unauthorized" }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const r = await jevConsult(enterInput({ fallbackVerdict: "no" }));
    expect(r.fallback).toBe(true);
    expect(r.outcome).toBe("401");
    expect(r.verdict).toBe("no");
  });

  it("422: falls back (our bug) and logs the body", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    const fetchMock = vi.fn(async () => json("missing model/questions", 422));
    vi.stubGlobal("fetch", fetchMock);
    const r = await jevConsult(enterInput({ fallbackVerdict: "yes" }));
    expect(r.fallback).toBe(true);
    expect(r.outcome).toBe("422");
  });

  it("malformed response: falls back on parse error", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers: {} })));
    const r = await jevConsult(enterInput({ fallbackVerdict: "yes" }));
    expect(r.fallback).toBe(true);
    expect(r.outcome).toBe("parse_error");
  });

  it("rate cap: falls back without calling fetch once max_consults_per_min is exhausted", async () => {
    installConfig((c) => { c.jev = { ...c.jev, enabled: true, max_consults_per_min: 1 } as any; });
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    const fetchMock = vi.fn(async () => json({ model: "jev-1.13.0", answers: GOOD_ENTRY_ANSWERS, usage: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await jevConsult(enterInput());
    const second = await jevConsult(enterInput({ fallbackVerdict: "no" }));
    expect(second.fallback).toBe(true);
    expect(second.outcome).toBe("rate_capped");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("jevConsult — entry policy (composite scoring)", () => {
  it("approves on a clean, strong, agreeing answer", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers: GOOD_ENTRY_ANSWERS, usage: { input_tokens: 500 } })));
    const r = await jevConsult(enterInput());
    expect(r.consulted).toBe(true);
    expect(r.verdict).toBe("yes");
    expect(r.outcome).toBe("ok");
    expect(r.playChoice).toBe("eys_seat");
    const row = lastDecisionRow();
    expect(row.model).toBe("jev-1.13.0");
    expect(row.input_tokens).toBe(500);
    expect(JSON.parse(row.answers_json).play.choice).toBe("eys_seat");
  });

  it("rejects on a redflag veto even with strong positives", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    const answers = { ...GOOD_ENTRY_ANSWERS, redflag_security: { type: "noul", noul: 0.9 } };
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers, usage: {} })));
    const r = await jevConsult(enterInput());
    expect(r.verdict).toBe("no");
    expect(r.outcome).toBe("ok");
    expect(r.reason).toMatch(/redflag_veto/);
  });

  it("rejects on play mismatch", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    const answers = { ...GOOD_ENTRY_ANSWERS, play: { type: "choice", choice: "none", probabilities: { none: 0.9, eys_seat: 0.05 }, confidence: 0.9 } };
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers, usage: {} })));
    const r = await jevConsult(enterInput());
    expect(r.verdict).toBe("no");
    expect(r.reason).toMatch(/play_mismatch/);
  });

  it("with uncertain_entry=skip, an uncertain composite skips — verdict no, outcome uncertain, not a fallback", async () => {
    // Owner's decision 2026-10-02 made "rules" (enter) the DEFAULT for SOL-side
    // plays — see the dedicated "uncertain-entry policy" describe block below
    // for that behavior. This test pins the explicit opt-in "skip" path.
    installConfig((c) => { c.jev = { ...c.jev, uncertain_entry: "skip" } as any; });
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    const answers = {
      ...GOOD_ENTRY_ANSWERS,
      positive_fresh_flow: { type: "noul", noul: 0.5 },
      positive_fee_generation_sol: { type: "noul", noul: 0.5 },
      positive_bounce_confirmed: { type: "noul", noul: 0.5 },
      positive_narrative_strength: { type: "noul", noul: 0.5 },
    };
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers, usage: {} })));
    const r = await jevConsult(enterInput());
    expect(r.consulted).toBe(true);
    expect(r.fallback).toBe(false);
    expect(r.verdict).toBe("no");
    expect(r.outcome).toBe("uncertain");
  });

  it("applies the stricter eys_ape threshold", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    const answers = {
      ...GOOD_ENTRY_ANSWERS,
      positive_fresh_flow: { type: "noul", noul: 0.7 },
      positive_fee_generation_sol: { type: "noul", noul: 0.7 },
      positive_bounce_confirmed: { type: "noul", noul: 0.6 },
      positive_narrative_strength: { type: "noul", noul: 0.3 },
      play: { type: "choice", choice: "eys_ape", probabilities: { eys_ape: 0.9 }, confidence: 0.9 },
    };
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers, usage: {} })));
    const r = await jevConsult(enterInput({ play: "eys_ape", question: "enter with play eys_ape?" }));
    expect(r.verdict).toBe("no");
    expect(r.reason).toMatch(/below_threshold/);
  });
});

describe("jevConsult — exit lane", () => {
  const exitInput = (overrides: Partial<Parameters<typeof jevConsult>[0]> = {}) => ({
    lane: "exit" as const,
    state: { position: {}, trigger: {} },
    fallbackVerdict: "yes" as const,
    positionId: 1, play: "eys_seat", mint: "MINT", pool: "POOL", question: "exit now?",
    ...overrides,
  });

  it("exits when flow is dead and the model agrees", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    const answers = {
      redflag_thesis_broken: { type: "noul", noul: 0.1 },
      exit_flow_dead: { type: "noul", noul: 0.9 },
      exit_action: { type: "choice", choice: "close_now", probabilities: { close_now: 0.9 }, confidence: 0.9 },
    };
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers, usage: {} })));
    const r = await jevConsult(exitInput());
    expect(r.verdict).toBe("yes");
    expect(r.outcome).toBe("ok");
  });

  it("uncertain exit follows the rule's own trigger (fallbackVerdict), not a transport fallback", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    const answers = {
      redflag_thesis_broken: { type: "noul", noul: 0.1 },
      exit_flow_dead: { type: "noul", noul: 0.5 }, // in the uncertain band
      exit_action: { type: "choice", choice: "hold", probabilities: { hold: 0.9 }, confidence: 0.9 },
    };
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers, usage: {} })));
    const r = await jevConsult(exitInput({ fallbackVerdict: "yes" }));
    expect(r.consulted).toBe(true);
    expect(r.fallback).toBe(false);
    expect(r.outcome).toBe("uncertain");
    expect(r.verdict).toBe("yes"); // follows the rule, which already decided to exit
  });

  it("holds when flow is alive and the model agrees", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    const answers = {
      redflag_thesis_broken: { type: "noul", noul: 0.1 },
      exit_flow_dead: { type: "noul", noul: 0.1 },
      exit_action: { type: "choice", choice: "hold", probabilities: { hold: 0.9 }, confidence: 0.9 },
    };
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers, usage: {} })));
    const r = await jevConsult(exitInput());
    expect(r.verdict).toBe("no");
  });
});

describe("jevConsult — bounded concurrency", () => {
  it("falls back without calling fetch once max_concurrent is reached", async () => {
    installConfig((c) => { c.jev = { ...c.jev, enabled: true, max_concurrent: 1, timeout_ms: 200 } as any; });
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchMock = vi.fn(async () => {
      await gate;
      return json({ model: "jev-1.13.0", answers: GOOD_ENTRY_ANSWERS, usage: {} });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = jevConsult(enterInput());
    await new Promise((r) => setTimeout(r, 10));
    const second = await jevConsult(enterInput({ fallbackVerdict: "no" }));
    expect(second.fallback).toBe(true);
    expect(second.verdict).toBe("no");

    release();
    const firstResult = await first;
    expect(firstResult.consulted).toBe(true);
  });
});

describe("jevConsult — uncertain-entry policy (owner's decision 2026-10-02: aggressive, not conservative)", () => {
  const uncertainAnswers = {
    ...GOOD_ENTRY_ANSWERS,
    positive_fresh_flow: { type: "noul", noul: 0.5 },
    positive_fee_generation_sol: { type: "noul", noul: 0.5 },
    positive_bounce_confirmed: { type: "noul", noul: 0.5 },
    positive_narrative_strength: { type: "noul", noul: 0.5 },
    // High probability for every SOL-side play so this fixture works
    // regardless of which rulePlay a given test asks about — only the
    // composite-score uncertainty is under test here, not play agreement.
    play: { type: "choice", choice: "molu_ladder", probabilities: { molu_ladder: 0.9, danko_trap: 0.9, eys_seat: 0.9 }, confidence: 0.9 },
  };

  it("defers to the play's own rules (enters) for a SOL-side play when uncertain_entry=rules (the default)", async () => {
    installConfig((c) => { c.jev = { ...c.jev, uncertain_entry: "rules" } as any; });
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers: uncertainAnswers, usage: {} })));
    const r = await jevConsult(enterInput({ play: "molu_ladder" }));
    expect(r.consulted).toBe(true);
    expect(r.fallback).toBe(false);
    expect(r.verdict).toBe("yes");
    expect(r.outcome).toBe("jev_uncertain_rules_enter");
  });

  it("still skips for eys_ape even when uncertain_entry=rules globally (per-play override defaults to skip)", async () => {
    installConfig((c) => { c.jev = { ...c.jev, uncertain_entry: "rules" } as any; });
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    const apeAnswers = { ...uncertainAnswers, play: { type: "choice", choice: "eys_ape", probabilities: { eys_ape: 0.9 }, confidence: 0.9 } };
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers: apeAnswers, usage: {} })));
    const r = await jevConsult(enterInput({ play: "eys_ape", question: "enter with play eys_ape?" }));
    expect(r.verdict).toBe("no");
    expect(r.outcome).toBe("uncertain");
  });

  it("skips a SOL-side play too when uncertain_entry is explicitly set to skip", async () => {
    installConfig((c) => { c.jev = { ...c.jev, uncertain_entry: "skip" } as any; });
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers: uncertainAnswers, usage: {} })));
    const r = await jevConsult(enterInput({ play: "danko_trap" }));
    expect(r.verdict).toBe("no");
    expect(r.outcome).toBe("uncertain");
  });

  it("red-flag vetoes still reject regardless of uncertain_entry=rules", async () => {
    installConfig((c) => { c.jev = { ...c.jev, uncertain_entry: "rules" } as any; });
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    const vetoAnswers = { ...uncertainAnswers, redflag_security: { type: "noul", noul: 0.9 } };
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers: vetoAnswers, usage: {} })));
    const r = await jevConsult(enterInput({ play: "molu_ladder" }));
    expect(r.verdict).toBe("no");
    expect(r.outcome).toBe("ok");
    expect(r.reason).toMatch(/redflag_veto/);
  });

  it("ape_uncertain_entry can be overridden to rules explicitly", async () => {
    installConfig((c) => { c.jev = { ...c.jev, uncertain_entry: "rules", ape_uncertain_entry: "rules" } as any; });
    vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
    const apeAnswers = { ...uncertainAnswers, play: { type: "choice", choice: "eys_ape", probabilities: { eys_ape: 0.9 }, confidence: 0.9 } };
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers: apeAnswers, usage: {} })));
    const r = await jevConsult(enterInput({ play: "eys_ape", question: "enter with play eys_ape?" }));
    expect(r.verdict).toBe("yes");
    expect(r.outcome).toBe("jev_uncertain_rules_enter");
  });
});
