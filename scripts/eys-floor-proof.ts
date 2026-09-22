/**
 * Read-only floor proof: run one real-provider paper scan with the new
 * `[eys] flow_floor_usd` and report whether the previously-dead intake lane
 * (GMGN 1m ≥ floor → exact-pool resolution) and the proposal gate now fire.
 *
 * Usage: FARMER_DB_PATH=<tmp>/farmer.db FARMER_CONFIG_PATH=<tmp>/config.toml \
 *        FARMER_ENV_PATH=<prod>/data/.env FARMER_MODE=paper \
 *        npx tsx scripts/eys-floor-proof.ts
 */
import { config, isLive, effectiveEysFlowFloorUsd } from "../src/config.js";
import { scan } from "../src/scanner/scan.js";
import { eysPlugin } from "../src/strategy/eys.js";
import { gmgnOneMinuteFlow, GMGN_ONE_MINUTE_FRESHNESS_MS, gmgnPaceState } from "../src/scanner/gmgn.js";
import { getDb } from "../src/db/db.js";

if (isLive() || config().exec.mode !== "paper") throw new Error("paper lock required");

const floor = effectiveEysFlowFloorUsd(config().eys.flow_floor_usd);
const start = Date.now();
const scanned = await scan();
const proposals = await eysPlugin.discover({
  candidates: scanned.candidates,
  gmgnByMint: scanned.gmgnByMint ?? new Map(),
});

// Candidate-level flow distribution: how many candidates carry a genuine 1m
// row at all, and how many clear the configured floor.
const nowMs = Date.now();
let withFlow = 0;
let atFloor = 0;
const flows: number[] = [];
for (const c of scanned.candidates) {
  const flow = gmgnOneMinuteFlow(scanned.gmgnByMint?.get(c.tokenMint), nowMs, GMGN_ONE_MINUTE_FRESHNESS_MS);
  if (!flow) continue;
  withFlow++;
  flows.push(flow.volumeUsd);
  if (flow.volumeUsd >= floor) atFloor++;
}
flows.sort((a, b) => b - a);

// Intake-qualified = same rule the scanner uses to pick exact-pool lookups.
const intakeMints = [...(scanned.gmgnByMint ?? new Map()).entries()]
  .filter(([mint, presence]) => {
    const flow = gmgnOneMinuteFlow(presence, nowMs, GMGN_ONE_MINUTE_FRESHNESS_MS);
    const mcap = presence.tokenByInterval.get("1m")?.marketCapUsd ?? 0;
    return flow !== null && flow.volumeUsd >= floor && mcap >= config().eys.market_cap_floor_usd
      ? true : false;
  })
  .map(([mint]) => mint);
const intakeSet = new Set(intakeMints);
const candidatesInIntake = scanned.candidates.filter((c) => intakeSet.has(c.tokenMint)).length;
const rejectedInIntake = scanned.rejected
  .filter((c) => intakeSet.has(c.tokenMint))
  .slice(0, 6);

const db = getDb();
const gates = db.prepare(
  "select failed_gate, count(*) n from decisions where failed_gate is not null group by 1 order by 2 desc",
).all() as { failed_gate: string; n: number }[];

console.log("FLOOR_PROOF " + JSON.stringify({
  mode: "paper",
  elapsedMs: Date.now() - start,
  floorUsd: floor,
  sweptPools: scanned.sweptPools,
  candidates: scanned.candidates.length,
  eysIntake: scanned.eysIntake ?? null,
  // Which of the cycle's intake-qualified mints actually reached candidacy:
  // the lane is only useful if their exact pools survive the core pool gates.
  intakeMints: intakeMints.slice(0, 12),
  intakeInCandidates: candidatesInIntake,
  intakeInRejected: rejectedInIntake.map((r) => ({
    mint: r.tokenMint,
    symbol: r.symbol,
    gates: r.gateFailures.slice(0, 6),
  })),
  candidatesWithFresh1m: withFlow,
  candidatesAtFloor: atFloor,
  topFlows: flows.slice(0, 8),
  proposals: proposals.map((p) => ({
    pool: p.candidate.pool.address,
    mint: p.candidate.tokenMint,
    symbol: p.candidate.symbol,
    stage: p.stage,
    side: p.fundingSide,
    shape: p.shape,
    flowUsdPerMin: p.evidence.flowUsdPerMin,
    flowCadence: p.evidence.flowCadence,
    mcap: p.candidate.pool.marketCapUsd,
  })),
  pace: gmgnPaceState(),
  gates,
}));

db.close();
process.exit(0);
