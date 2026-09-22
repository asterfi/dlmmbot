/**
 * Read-only floor sampler: one GMGN trending snapshot per minute for N minutes,
 * counting how many mints carry a genuine `1m` row at each candidate floor and
 * how many of those also clear the Eys market-cap floor. This is the metric
 * that decides the operating floor: a floor nobody crosses still yields zero
 * trades, which is the exact failure being fixed.
 *
 * Usage: FARMER_DB_PATH=... FARMER_CONFIG_PATH=... FARMER_ENV_PATH=... \
 *        FARMER_MODE=paper npx tsx scripts/eys-floor-sampler.ts [minutes]
 */
import { appendFileSync } from "node:fs";
import { config, effectiveEysFlowFloorUsd, isLive } from "../src/config.js";
import { trendingByMint, gmgnOneMinuteFlow, GMGN_ONE_MINUTE_FRESHNESS_MS, gmgnPaceState } from "../src/scanner/gmgn.js";

if (isLive()) throw new Error("paper lock required");

const minutes = Number(process.argv[2] ?? 12);
const out = process.env.EYS_SAMPLER_OUT ?? "/tmp/eys-floor-sampler.jsonl";
const floors = [10_000, 15_000, 20_000, 25_000, 30_000, 50_000, 100_000];
const mcapFloor = config().eys.market_cap_floor_usd;
const configuredFloor = effectiveEysFlowFloorUsd(config().eys.flow_floor_usd);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let banEvents = 0;

for (let i = 0; i < minutes; i++) {
  const startedAt = Date.now();
  const byMint = await trendingByMint();
  const nowMs = Date.now();
  const rows: { flow: number; mcap: number }[] = [];
  for (const presence of byMint.values()) {
    const flow = gmgnOneMinuteFlow(presence, nowMs, GMGN_ONE_MINUTE_FRESHNESS_MS);
    if (!flow) continue;
    const token = presence.tokenByInterval.get("1m");
    rows.push({ flow: flow.volumeUsd, mcap: token?.marketCapUsd ?? 0 });
  }
  const sample = {
    ts: new Date(nowMs).toISOString(),
    trendingMints: byMint.size,
    withFresh1m: rows.length,
    configuredFloor,
    counts: Object.fromEntries(floors.map((f) => [f, rows.filter((r) => r.flow >= f).length])),
    countsMcapQualified: Object.fromEntries(
      floors.map((f) => [f, rows.filter((r) => r.flow >= f && r.mcap >= mcapFloor).length]),
    ),
    top5: rows.sort((a, b) => b.flow - a.flow).slice(0, 5),
    pace: gmgnPaceState(),
  };
  appendFileSync(out, JSON.stringify(sample) + "\n");
  console.log(`[${i + 1}/${minutes}] ${JSON.stringify(sample)}`);
  const elapsed = Date.now() - startedAt;
  if (gmgnPaceState().bannedUntil > Date.now()) banEvents++;
  await sleep(Math.max(0, 62_000 - elapsed));
}

console.log(`SAMPLER_DONE samples=${minutes} banEvents=${banEvents} out=${out}`);
process.exit(0);
