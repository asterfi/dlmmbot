// PNG card renderer: satori (object tree -> SVG) + @resvg/resvg-js (SVG -> PNG).
// Pure and side-effect-free apart from reading bundled font files once. Callers
// MUST wrap renderCardWithTimeout so a render hang/crash can never affect the
// trading loop — see src/alerts/cards.ts for the fire-and-forget wrapper.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

export const CARD_WIDTH = 1000;
export const CARD_HEIGHT = 560;

interface FontEntry {
  name: string;
  data: Buffer;
  weight: 400 | 700;
  style: "normal";
}

let fonts: FontEntry[] | null = null;

/** Repo-relative so it resolves the same under systemd's WorkingDirectory and plain `tsx`. */
function fontsDir(): string {
  return resolve(process.cwd(), "assets/fonts");
}

function loadFonts(): FontEntry[] {
  if (fonts) return fonts;
  const dir = fontsDir();
  fonts = [
    { name: "JetBrains Mono", data: readFileSync(resolve(dir, "JetBrainsMono-Regular.ttf")), weight: 400, style: "normal" },
    { name: "JetBrains Mono", data: readFileSync(resolve(dir, "JetBrainsMono-Bold.ttf")), weight: 700, style: "normal" },
    { name: "IBM Plex Sans", data: readFileSync(resolve(dir, "IBMPlexSans-Regular.ttf")), weight: 400, style: "normal" },
    { name: "IBM Plex Sans", data: readFileSync(resolve(dir, "IBMPlexSans-Bold.ttf")), weight: 700, style: "normal" },
  ];
  return fonts;
}

/** Satori's object-node shape (we build cards with plain objects — no JSX pragma configured). */
export interface SatoriNode {
  type: string;
  props: { style?: Record<string, unknown>; children?: SatoriNode[] | string; [k: string]: unknown };
}

/**
 * Render a card tree to a PNG buffer at 2x for crispness. Throws on any
 * failure (missing fonts, bad node tree, resvg error) — callers must catch.
 */
export async function renderCardPng(node: SatoriNode): Promise<Buffer> {
  const svg = await satori(node as unknown as Parameters<typeof satori>[0], {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts: loadFonts(),
  });
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: CARD_WIDTH * 2 },
    background: "#0D0D0D",
  });
  const rendered = resvg.render();
  return rendered.asPng();
}

/**
 * Render with a hard wall-clock timeout. Never throws: returns null on any
 * failure or timeout so the caller can fall back to plain-text Telegram.
 * This is the ONLY entry point alert code should call.
 */
export async function renderCardWithTimeout(node: SatoriNode, timeoutMs = 3000): Promise<Buffer | null> {
  try {
    return await Promise.race([
      renderCardPng(node),
      new Promise<null>((res) => setTimeout(() => res(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}
