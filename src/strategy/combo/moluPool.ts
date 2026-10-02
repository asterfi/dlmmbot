/**
 * molu pool choice (owner, 2026-10-03; molu's Book 1: "Fee tier 5 to 10% if
 * it's fresh, or use the pool with the most volume"). For a young token with
 * several Meteora DLMM SOL pools: take the 5-10% base-fee pool when it has real
 * volume, otherwise the pool with the most 30m volume (NOT the deepest TVL,
 * which is what the scanner's generic pick optimises). Pure; only called for
 * molu_ladder candidates — other plays keep the scanner's pool.
 */
import type { PoolInfo } from "../../types.js";

export interface MoluPoolChoice {
  pool: PoolInfo;
  /** Recorded as `molu_pool_choice`. */
  reason: "fee_tier_5_10" | "highest_vol30m" | "single_pool";
}

export function chooseMoluPool(
  pools: PoolInfo[],
  cfg: { molu_fee_pool_min_vol30m_usd: number },
  current: PoolInfo,
): MoluPoolChoice {
  if (pools.length <= 1) return { pool: current, reason: "single_pool" };
  const byVolDesc = (a: PoolInfo, b: PoolInfo) =>
    b.vol30mUsd - a.vol30mUsd || (a.address === current.address ? -1 : b.address === current.address ? 1 : 0);
  const feeTier = pools
    .filter((p) => p.baseFeePct >= 5 && p.baseFeePct <= 10 && p.vol30mUsd >= cfg.molu_fee_pool_min_vol30m_usd)
    .sort(byVolDesc);
  if (feeTier.length > 0) return { pool: feeTier[0]!, reason: "fee_tier_5_10" };
  return { pool: [...pools].sort(byVolDesc)[0]!, reason: "highest_vol30m" };
}
