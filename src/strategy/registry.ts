import { config } from "../config.js";
import type { StrategyPlugin, StrategyProposal } from "./plugin.js";
import { eysPlugin } from "./eys.js";

const corePlugin: StrategyPlugin = {
  id: "core",
  admissionClass: "core",

  async discover({ candidates }): Promise<StrategyProposal[]> {
    return candidates.map((candidate) => ({
      strategyId: "core",
      candidate,
      stage: "core",
      fundingSide: "sol",
      shape: "bidask",
      requestedSizeSol: null,
      evidence: {
        exactPool: candidate.pool.address,
        flowUsdPerMin: null,
        flowObservedAtMs: null,
        flowSource: null,
        persistentObservations: 0,
        gmgnIntervals: [],
        priceChangePct1h: null,
      },
    }));
  },

  evaluate() {
    return { accepted: true };
  },

  plan() {
    return null;
  },

  manage() {
    return null;
  },
};

let warnedDisabled = false;

/**
 * Core is the safe fallback. Eys becomes active only when both the mode and its
 * explicit enable flag are present in the runtime config.
 */
export function activeStrategyPlugin(): StrategyPlugin {
  const selected = config().strategy?.mode ?? "core";
  const enabled = config().eys?.enabled === true;
  if (selected === "eys" && enabled) return eysPlugin;
  if (selected === "eys" && !enabled && !warnedDisabled) {
    warnedDisabled = true;
    console.warn("[strategy] mode=eys but [eys].enabled is false — using core fallback");
  }
  return corePlugin;
}

export function resetStrategyRegistryForTests(): void {
  warnedDisabled = false;
}

export { corePlugin };
