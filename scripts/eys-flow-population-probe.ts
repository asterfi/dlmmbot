/**
 * Read-only probe: what does the genuine GMGN 1m volume distribution look like
 * across the FULL trending population (not just the candidates we happen to
 * refresh)? Used to set the Eys flow floor on evidence instead of guesswork.
 *
 * Usage: npx tsx scripts/eys-flow-population-probe.ts
 */
import { trendingByMint, gmgnOneMinuteFlow, gmgnPaceState, GMGN_ONE_MINUTE_FRESHNESS_MS } from "../src/scanner/gmgn.js";

const start = Date.now();
const byMint = await trendingByMint();
const nowMs = Date.now();

let with1m = 0;
const rows: { mint: string; flow: number; mcap: number; liq: number }[] = [];
for (const [mint, presence] of byMint) {
  const flow = gmgnOneMinuteFlow(presence, nowMs, GMGN_ONE_MINUTE_FRESHNESS_MS);
  if (!flow) continue;
  with1m++;
  const t = presence.tokenByInterval.get("1m")!;
  rows.push({ mint, flow: flow.volumeUsd, mcap: t.marketCapUsd, liq: t.liquidityUsd });
}
rows.sort((a, b) => b.flow - a.flow);

const vals = rows.map((r) => r.flow);
const pct = (p: number) => {
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => b - a);
  return s[Math.max(0, Math.ceil(s.length * p) - 1)];
};

const buckets = [100_000, 75_000, 50_000, 40_000, 30_000, 25_000, 20_000, 15_000, 10_000, 5_000];
const distribution = buckets.map((f) => ({
  floor: f,
  mints: rows.filter((r) => r.flow >= f).length,
}));

console.log("PROBE_RESULT " + JSON.stringify({
  elapsedMs: Date.now() - start,
  trendingMints: byMint.size,
  mintsWithFresh1m: with1m,
  pace: gmgnPaceState(),
  top10: rows.slice(0, 10),
  percentiles: { top05: pct(0.005), top1: pct(0.01), top2: pct(0.02), top5: pct(0.05), top10: pct(0.1), median: pct(0.5) },
  distribution,
}));
process.exit(0);
