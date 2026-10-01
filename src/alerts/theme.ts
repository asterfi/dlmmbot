// Design tokens mirrored from dashboard/src/index.css so Telegram cards match
// the web dashboard's look. Keep in sync by hand — the dashboard is owned by
// a different workstream; this file does not import from dashboard/.
export const COLOR = {
  bg: "#0D0D0D",
  panel: "#141414",
  border: "#2A2A2A",
  fg: "#FFFFFF",
  muted: "#A3A3A3",
  dim: "#6B6B6B",
  accent: "#1E90FF",
  sol: "#B56BFF",
  ok: "#00FF85",
  warn: "#FFB020",
  danger: "#FF4D6A",
  pink: "#FF0099",
} as const;

export const FONT_MONO = "JetBrains Mono";
export const FONT_SANS = "IBM Plex Sans";

/** Pill background tints (low-alpha panel-on-bg look, flat colors — satori has no color-mix). */
export const PILL_BG: Record<string, string> = {
  [COLOR.ok]: "#0A2A1C",
  [COLOR.danger]: "#2A0F16",
  [COLOR.warn]: "#2A1F0A",
  [COLOR.accent]: "#0A1A2A",
  [COLOR.sol]: "#1E1430",
  [COLOR.muted]: "#1A1A1A",
};
