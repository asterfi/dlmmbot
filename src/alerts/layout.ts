// Turns a CardSpec (plain data) into a satori object-node tree styled to
// match the dashboard: dark panel, thin borders, uppercase mono labels, big
// numbers, a status pill and a play badge. No JSX pragma is configured for
// this project, so nodes are built as plain objects matching satori's shape.
import { CARD_HEIGHT, CARD_WIDTH, type SatoriNode } from "./render.js";
import { COLOR, FONT_MONO, FONT_SANS, PILL_BG } from "./theme.js";

export interface CardRow {
  label: string;
  value: string;
  color?: string;
}

export type StatusPill = "LIVE" | "PAPER" | "TEST";

export interface CardSpec {
  /** Short uppercase kind pill, e.g. OPENED / CLOSED / ERROR / JEV. */
  kindLabel: string;
  kindColor: string;
  statusPill: StatusPill;
  /** Headline, e.g. token symbol + pos id. */
  title: string;
  subtitle?: string;
  /** Optional play badge, e.g. "molu ladder" / "Danko trap" / "Eys seat" / "Eys ape". */
  play?: string;
  /** The big hero number, e.g. "+0.0421 SOL". */
  bigValue?: string;
  bigValueColor?: string;
  bigValueSub?: string;
  rows: CardRow[];
  /** Optional mini equity history, oldest -> newest, rendered as bars. */
  sparkline?: number[];
  footerNote?: string;
}

function node(type: string, style: Record<string, unknown>, children?: SatoriNode[] | string): SatoriNode {
  return { type, props: { style, children } };
}

function text(value: string, style: Record<string, unknown>): SatoriNode {
  return node("div", style, value);
}

function pill(label: string, color: string): SatoriNode {
  return node("div", {
    display: "flex",
    alignItems: "center",
    padding: "4px 12px",
    borderRadius: 4,
    border: `1px solid ${color}`,
    backgroundColor: PILL_BG[color] ?? "#1A1A1A",
    color,
    fontFamily: FONT_MONO,
    fontSize: 20,
    fontWeight: 700,
    letterSpacing: 1,
  }, label);
}

function sparklineNode(values: number[]): SatoriNode {
  const max = Math.max(...values, 1e-9);
  const min = Math.min(...values, 0);
  const span = Math.max(max - min, 1e-9);
  const bars = values.map((v) => {
    const frac = (v - min) / span;
    const h = Math.max(4, Math.round(frac * 60));
    const color = v >= (values[0] ?? 0) ? COLOR.ok : COLOR.danger;
    return node("div", {
      display: "flex",
      width: 8,
      height: h,
      marginLeft: 3,
      backgroundColor: color,
      borderRadius: 1,
      alignSelf: "flex-end",
    });
  });
  return node("div", {
    display: "flex",
    flexDirection: "row",
    alignItems: "flex-end",
    height: 64,
    marginTop: 16,
  }, bars);
}

export function buildCardNode(spec: CardSpec): SatoriNode {
  const headerRight: SatoriNode[] = [pill(spec.statusPill, spec.statusPill === "LIVE" ? COLOR.ok : spec.statusPill === "TEST" ? COLOR.accent : COLOR.muted)];

  const rowNodes: SatoriNode[] = spec.rows.map((r) =>
    node("div", {
      display: "flex",
      flexDirection: "row",
      justifyContent: "space-between",
      padding: "10px 0",
      borderTop: `1px solid ${COLOR.border}`,
    }, [
      text(r.label.toUpperCase(), { fontFamily: FONT_MONO, fontSize: 18, color: COLOR.dim, letterSpacing: 0.5, display: "flex" }),
      text(r.value, { fontFamily: FONT_MONO, fontSize: 20, color: r.color ?? COLOR.fg, fontWeight: 700, display: "flex" }),
    ]));

  const children: SatoriNode[] = [
    // Header row: kind pill + play badge on the left, status pill on the right.
    node("div", {
      display: "flex",
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    }, [
      node("div", { display: "flex", flexDirection: "row", alignItems: "center" }, [
        pill(spec.kindLabel, spec.kindColor),
        ...(spec.play ? [node("div", { display: "flex", marginLeft: 12 }, [pill(spec.play.toUpperCase(), COLOR.sol)])] : []),
      ]),
      node("div", { display: "flex", flexDirection: "row" }, headerRight),
    ]),
    // Title / subtitle.
    node("div", { display: "flex", flexDirection: "column", marginTop: 28 }, [
      text(spec.title, { fontFamily: FONT_SANS, fontSize: 40, fontWeight: 700, color: COLOR.fg, display: "flex" }),
      ...(spec.subtitle ? [text(spec.subtitle, { fontFamily: FONT_MONO, fontSize: 20, color: COLOR.muted, marginTop: 6, display: "flex" })] : []),
    ]),
    // Hero number.
    ...(spec.bigValue ? [node("div", { display: "flex", flexDirection: "row", alignItems: "baseline", marginTop: 20 }, [
      text(spec.bigValue, { fontFamily: FONT_MONO, fontSize: 64, fontWeight: 700, color: spec.bigValueColor ?? COLOR.fg, display: "flex" }),
      ...(spec.bigValueSub ? [text(spec.bigValueSub, { fontFamily: FONT_MONO, fontSize: 28, color: spec.bigValueColor ?? COLOR.muted, marginLeft: 16, display: "flex" })] : []),
    ])] : []),
    ...(spec.sparkline && spec.sparkline.length > 1 ? [sparklineNode(spec.sparkline)] : []),
    // Rows.
    node("div", { display: "flex", flexDirection: "column", marginTop: 24, flexGrow: 1 }, rowNodes),
    // Footer.
    node("div", {
      display: "flex",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingTop: 16,
      borderTop: `1px solid ${COLOR.border}`,
    }, [
      text(spec.footerNote ?? "", { fontFamily: FONT_MONO, fontSize: 16, color: COLOR.dim, display: "flex" }),
      text(`${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC · dlmmbot`, { fontFamily: FONT_MONO, fontSize: 16, color: COLOR.dim, display: "flex" }),
    ]),
  ];

  return node("div", {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    display: "flex",
    flexDirection: "column",
    backgroundColor: COLOR.bg,
    border: `1px solid ${COLOR.border}`,
    padding: 40,
    fontFamily: FONT_SANS,
    color: COLOR.fg,
  }, children);
}
