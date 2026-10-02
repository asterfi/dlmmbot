/**
 * On-chain fee-collection mode of a DLMM pool (Meteora's quote-only / "SOL fees"
 * setting). The installed @meteora-ag/dlmm (1.9.x) exposes it on the LbPair
 * account: `lbPair.parameters.collectFeeMode`, enum CollectFeeMode
 * { InputOnly = 0 (fees in whichever token came in), OnlyY = 1 (quote/Y only —
 * SOL here, since every pool we trade is X/SOL) }.
 *
 * eys_ape's whole premise (Eys, $CTO: "even if the token ended up getting
 * rugged, I would still be earning SOL fees") is a quote-only pool, so the
 * entry pipeline reads the chain rather than trusting the datapi's copy of the
 * field alone. Returns null when it cannot be read (RPC/SDK failure) — the
 * caller then keeps the datapi value and logs fee_mode_unknown.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";
import { makeConnection } from "../../rpc.js";

interface LbPairLike {
  lbPair?: { parameters?: { collectFeeMode?: number } };
}
interface DlmmStatic {
  create(connection: Connection, dlmm: PublicKey): Promise<LbPairLike>;
}

const dlmmMod = createRequire(import.meta.url)("@meteora-ag/dlmm") as { default?: DlmmStatic } & DlmmStatic;
const DLMM: DlmmStatic = dlmmMod.default ?? dlmmMod;

let sharedConn: Connection | null = null;

export type PoolLoader = (poolAddress: string) => Promise<LbPairLike>;

const defaultLoader: PoolLoader = async (poolAddress) => {
  sharedConn ??= makeConnection({ commitment: "confirmed" });
  return DLMM.create(sharedConn, new PublicKey(poolAddress));
};

// A pool's collect-fee mode is fixed at creation, so one successful read is good for the
// life of the process (DLMM.create is several RPC calls — never repeat it per sweep).
const modeCache = new Map<string, 0 | 1>();

export function _resetFeeModeCacheForTests(): void {
  modeCache.clear();
}

/** 0 = both tokens (InputOnly), 1 = quote-only (OnlyY), null = unreadable. */
export async function readOnchainCollectFeeMode(
  poolAddress: string,
  load: PoolLoader = defaultLoader,
): Promise<0 | 1 | null> {
  const hit = modeCache.get(poolAddress);
  if (hit !== undefined) return hit;
  try {
    const pool = await load(poolAddress);
    const mode = pool.lbPair?.parameters?.collectFeeMode;
    if (mode === 0 || mode === 1) {
      modeCache.set(poolAddress, mode);
      return mode;
    }
    return null;
  } catch {
    return null;
  }
}
