/**
 * Jev wiring for the Eys-only combo (owner, 2026-10-03): the play menu is
 * narrowed to the plays the rule engine says the candidate qualifies for, and a
 * soft-tier volume candidate must clear a stricter composite bar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jevConsult, _resetJevStateForTests } from "./index.js";
import { questionsFor } from "./questions.js";
import { installConfig, restoreConfig } from "../../test/config.js";
import { useMemoryDb, resetTestDb } from "../../test/db.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function answers(composite: number, play = "eys_seat") {
  return {
    redflag_wash_volume: { type: "noul", noul: 0.1 },
    redflag_security: { type: "noul", noul: 0.1 },
    redflag_exhausted_spike: { type: "noul", noul: 0.1 },
    redflag_insider_dumping: { type: "noul", noul: 0.1 },
    redflag_stablecoin_major: { type: "noul", noul: 0.05 },
    positive_fresh_flow: { type: "noul", noul: composite },
    positive_fee_generation_sol: { type: "noul", noul: composite },
    positive_bounce_confirmed: { type: "noul", noul: composite },
    positive_narrative_strength: { type: "noul", noul: composite },
    play: { type: "choice", choice: play, probabilities: { [play]: 0.9 }, confidence: 0.9 },
  };
}

beforeEach(() => {
  useMemoryDb();
  _resetJevStateForTests();
  vi.stubEnv("TYPESAFE_API_KEY", "test-key-not-real");
  installConfig((c) => {
    c.jev = {
      enabled: true, model: "jev-1.13.0", timeout_ms: 500, max_concurrent: 4, max_consults_per_min: 100,
      redflag_veto: 0.6, play_prob_min: 0.3, uncertain_low: 0.45, uncertain_high: 0.55,
      weight_fresh_flow: 0.3, weight_fee_generation: 0.3, weight_bounce: 0.25, weight_narrative: 0.15,
      entry_threshold_eys_seat: 0.55, entry_threshold_eys_tight: 0.55, entry_threshold_eys_breakout: 0.65,
      entry_threshold_eys_ape: 0.7, entry_threshold_eys_dump_bonus: 0.55,
    };
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); restoreConfig(); resetTestDb(); });

const input = (over: Record<string, unknown> = {}) => ({
  lane: "enter" as const, state: { candidate: {} }, fallbackVerdict: "yes" as const,
  play: "eys_seat", mint: "M", pool: "P", question: "enter with play eys_seat?", ...over,
});

describe("questionsFor — the play menu", () => {
  it("lists only the qualifying plays plus none", () => {
    const play = questionsFor("enter", ["eys_seat", "eys_tight"])["play"] as { criteria: Record<string, string> };
    expect(Object.keys(play.criteria).sort()).toEqual(["eys_seat", "eys_tight", "none"]);
  });
  it("offers the full Eys menu (and no retired plays) when no list is given; exit lane untouched", () => {
    const play = questionsFor("enter")["play"] as { criteria: Record<string, string> };
    expect(Object.keys(play.criteria).sort()).toEqual(["eys_ape", "eys_breakout", "eys_dump_bonus", "eys_seat", "eys_tight", "none"]);
    expect(questionsFor("exit", ["eys_seat"])).toBe(questionsFor("exit"));
  });
  it("sends the narrowed menu in the request body", async () => {
    const fetchMock = vi.fn(async () => json({ model: "jev-1.13.0", answers: answers(0.9), usage: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await jevConsult(input({ qualifyingPlays: ["eys_seat", "eys_breakout"] }));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body) as {
      questions: { play: { criteria: Record<string, string> } };
    };
    expect(Object.keys(body.questions.play.criteria).sort()).toEqual(["eys_breakout", "eys_seat", "none"]);
  });
});

describe("jevConsult — soft-tier volume needs a stricter composite (minComposite)", () => {
  it("composite 0.60 clears eys_seat's own 0.55 bar...", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers: answers(0.6), usage: {} })));
    const r = await jevConsult(input());
    expect(r.verdict).toBe("yes");
  });
  it("...but not the 0.65 soft-tier bar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers: answers(0.6), usage: {} })));
    const r = await jevConsult(input({ minComposite: 0.65 }));
    expect(r.verdict).toBe("no");
    expect(r.reason).toMatch(/below|threshold|0\.6/i);
  });
  it("composite 0.70 clears the soft bar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers: answers(0.7), usage: {} })));
    expect((await jevConsult(input({ minComposite: 0.65 }))).verdict).toBe("yes");
  });
  it("minComposite only RAISES a play's bar: eys_ape's own 0.70 stays when the soft bar is lower", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers: answers(0.66, "eys_ape"), usage: {} })));
    expect((await jevConsult(input({ play: "eys_ape", minComposite: 0.65 }))).verdict).toBe("no");
  });
  it("breakout (token-sided) keeps the conservative skip when Jev is genuinely uncertain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ model: "jev-1.13.0", answers: answers(0.5, "eys_breakout"), usage: {} })));
    const r = await jevConsult(input({ play: "eys_breakout" }));
    expect(r.verdict).toBe("no");
    expect(r.outcome).toBe("uncertain");
  });
});
