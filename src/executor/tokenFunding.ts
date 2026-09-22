export const TOKEN_SIDE_BINS_PER_ACCOUNT = 69;

export interface TokenBalanceSnapshot {
  mint: string;
  owner?: string | null;
  uiTokenAmount: { amount: string };
}

export interface TokenSideChunk {
  min: number;
  max: number;
  share: number;
}

export function positiveTokenDelta(before: bigint, after: bigint): bigint {
  if (before < 0n || after < 0n) throw new Error("token balance cannot be negative");
  if (after < before) throw new Error("token balance decreased during acquisition");
  const delta = after - before;
  if (delta <= 0n) throw new Error("token acquisition produced no attributable token delta");
  return delta;
}

function ownedTokenTotal(
  rows: readonly TokenBalanceSnapshot[],
  wallet: string,
  mint: string,
): bigint {
  let total = 0n;
  for (const row of rows) {
    if (row.mint !== mint) continue;
    if (row.owner == null) throw new Error("token balance owner attribution unavailable");
    if (row.owner !== wallet) continue;
    if (!/^\d+$/.test(row.uiTokenAmount.amount)) {
      throw new Error("token balance amount is malformed");
    }
    total += BigInt(row.uiTokenAmount.amount);
  }
  return total;
}

/** Attribute the SOL→token acquisition to this wallet and confirmed swap only. */
export function attributedTokenDelta(
  pre: readonly TokenBalanceSnapshot[],
  post: readonly TokenBalanceSnapshot[],
  wallet: string,
  mint: string,
): bigint {
  return positiveTokenDelta(
    ownedTokenTotal(pre, wallet, mint),
    ownedTokenTotal(post, wallet, mint),
  );
}

export function allocateTokenSideChunks(
  activeBin: number,
  plannedMaxBin: number,
  binsPerAccount = TOKEN_SIDE_BINS_PER_ACCOUNT,
): TokenSideChunk[] {
  if (!Number.isSafeInteger(activeBin) || !Number.isSafeInteger(plannedMaxBin)) {
    throw new Error("token-side range bins must be safe integers");
  }
  if (!Number.isSafeInteger(binsPerAccount) || binsPerAccount < 1) {
    throw new Error("token-side bins per account must be a positive integer");
  }
  if (plannedMaxBin <= activeBin) {
    throw new Error("token-side Spot range must extend above the active bin");
  }
  const totalBins = plannedMaxBin - activeBin + 1;
  const chunks: TokenSideChunk[] = [];
  for (let start = 0; start < totalBins; start += binsPerAccount) {
    const count = Math.min(binsPerAccount, totalBins - start);
    chunks.push({
      min: activeBin + start,
      max: activeBin + start + count - 1,
      share: count / totalBins,
    });
  }
  return chunks;
}
