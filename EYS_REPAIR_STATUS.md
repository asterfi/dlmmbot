# Eys integration repair — validation status

## Scope actually implemented

- Bounded refresh of stale/missing genuine GMGN 1m evidence (maximum five distinct candidate mints through existing provider budget).
- Persisted stale/unavailable diagnostics.
- Anchor-only automatic proposals: SOL funding, Spot shape. Unsupported child stages fail closed; invalid non-core plans cannot fall back to core geometry.
- No changes to live config, production source, shared execution/safety logic, or funds.

This is NOT the complete staged Eys strategy. The legacy percentage-stage helpers/settings do not authorize child entries.

## Verified

- RED/GREEN observed for child-plan rejection and hourly-change-independent anchor discovery.
- 28 strategy tests passed.
- npm test exited 0; typecheck/build/profile validation/diff check passed.
- Independent bounded review passed (deleg_289fbdfe); applies only to configured anchor canary, with generic follow/tranche disabled.
- Real-provider isolated paper discovery smoke: 300 pools swept; 136 candidates; 0 proposals; 117 eys_flow_unavailable decisions. Scan plus plugin took 52,965 ms. No position or wallet execution invoked.
- Raw smoke result: /tmp/eys-integration-smoke/result.log. Harness: scripts/eys-readonly-smoke.ts.

## Remaining live acceptance gaps

- No qualifying real candidate completed paper entry-to-exit in this repair.
- Full source selection (fee denomination/10 SOL condition, lore, trend and developer-fee mapping) is not implemented by this simple plugin selector.
- No restart-safe staged ownership, breakout/watch/high context or stage-specific child lifecycle is implemented.
- Current one-position cap and zero same-token reentry remain unchanged; they cannot demonstrate the full staged strategy.
- Current smoke proves reachable providers and rejection diagnostics, not full discovery coverage, strategy readiness, or profitability.

Do not label this complete Eys or enable live execution merely because the bounded review passed. Production remains unchanged by this repair.

## Rollback

Production DB/config/log backup: /opt/hermes-projects/dlmmbot-backups/eys-integration-20260922T073554Z (SQLite quick_check passed).
Working branch: fix/eys-integration-20260922; base c22a1b0.

## Live deployment (2026-09-22 10:29 UTC)

Authorized by the operator after both remaining gaps were closed (commit e301953).

- Independent pre-live review: VERDICT APPROVE, no findings (deleg_2b68d011).
- Pre-live backup: /opt/hermes-projects/dlmmbot-backups/prelive-20260922T101730Z (integrity_check ok).
- State before start: 0 open positions, 0 pending acquisition intents, no farmer.lock, no competing process.
- Launch: `cd /opt/hermes-projects/dlmmbot && npm run run >> data/live-canary.log 2>&1`.
- Readback: leaf pid 3343065, build e301953, cwd production worktree, fd/1 and fd/2 both point at data/live-canary.log, `[live] executor armed`, reconcile 0/0/0/0, `starting in live mode`, strategy=eys, eys.enabled=true, entry_sol=0.1, flow_floor_usd=100000, exec.mode=live + FARMER_MODE=live, max_positions=1, sizing.mode=fixed. Wallet 0.5901 SOL.
- Liveness: pool_snapshots and decisions both advanced across consecutive cycles; 138 fresh `eys_flow_unavailable` rows in 3 minutes, 0 proposals, 0 positions.

Still NOT complete Eys: single anchor stage only, no child stages, no restart-safe staged ownership, no full source selection (fee denomination/10 SOL, lore, developer-fee mapping), one-position cap, zero same-token reentry. Real-provider evidence shows the lane currently qualifies 0 of ~137 candidates per cycle — running live proves health and evidence flow, not opportunity capture or profitability.

