import { describe, expect, it, afterEach, vi } from "vitest";
import { Keypair, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import {
  METEORA_DLMM_PROGRAM_ID,
  _resetMeteoraEventCacheForTests,
  discoverRecentMeteoraPools,
  parseMeteoraPoolEvents,
} from "./meteora-events.js";
import { fetchPool, type RawPoolExtras } from "./meteora.js";
import {
  gmgnOneMinuteFlow,
  mergeGmgnPresenceMaps,
  parseTokenInfo,
  type GmgnPresence,
} from "./gmgn.js";
import { installConfig, restoreConfig } from "../test/config.js";
import { _resetDbForTests, getDb } from "../db/db.js";

vi.mock("./meteora.js", () => ({ fetchPool: vi.fn() }));

const CUSTOMIZABLE_DISCRIMINATOR = [46, 39, 41, 135, 111, 183, 200, 64];
const CUSTOMIZABLE2_DISCRIMINATOR = [243, 73, 129, 126, 51, 19, 241, 107];
const LB_PAIR_DISCRIMINATOR = [45, 154, 237, 210, 221, 15, 166, 92];
const LB_PAIR2_DISCRIMINATOR = [73, 59, 36, 120, 237, 83, 108, 198];
const PERMISSIONED_DISCRIMINATOR = [108, 102, 213, 85, 251, 3, 53, 21];

function key(): PublicKey {
  return Keypair.generate().publicKey;
}

function transaction(
  discriminator: number[],
  accounts: PublicKey[],
  opts: { inner?: boolean; programId?: PublicKey } = {},
): ParsedTransactionWithMeta {
  const instruction = {
    programId: opts.programId ?? new PublicKey(METEORA_DLMM_PROGRAM_ID),
    accounts,
    data: bs58.encode(Uint8Array.from([...discriminator, 1, 2, 3])),
  };
  return {
    slot: 123,
    blockTime: 1_700_000_000,
    meta: {
      err: null,
      innerInstructions: opts.inner ? [{ index: 0, instructions: [instruction] }] : [],
    },
    transaction: {
      message: { instructions: opts.inner ? [] : [instruction] },
    },
  } as unknown as ParsedTransactionWithMeta;
}

function presence(token: GmgnPresence["token"], interval: string, at: number): GmgnPresence {
  return {
    token,
    intervals: new Set([interval]),
    tokenByInterval: new Map([[interval, token]]),
    fetchedAtMsByInterval: new Map([[interval, at]]),
  };
}

afterEach(() => {
  restoreConfig();
  _resetMeteoraEventCacheForTests();
  _resetDbForTests();
  vi.mocked(fetchPool).mockReset();
});

describe("Meteora event intake", () => {
  it("decodes the exact pool and mints from a permissionless initializer", () => {
    const pool = key();
    const mintX = key();
    const mintY = key();
    const [event] = parseMeteoraPoolEvents(
      transaction(CUSTOMIZABLE_DISCRIMINATOR, [pool, key(), mintX, mintY]),
      "sig-custom",
      1_700_000_100,
    );

    expect(event).toMatchObject({
      signature: "sig-custom",
      instruction: "initializeCustomizablePermissionlessLbPair",
      pool: pool.toBase58(),
      mintX: mintX.toBase58(),
      mintY: mintY.toBase58(),
      slot: 123,
    });
  });

  it("decodes every published initializer discriminator", () => {
    const variants = [
      [CUSTOMIZABLE_DISCRIMINATOR, 0, 2, 3],
      [CUSTOMIZABLE2_DISCRIMINATOR, 0, 2, 3],
      [LB_PAIR_DISCRIMINATOR, 0, 2, 3],
      [LB_PAIR2_DISCRIMINATOR, 0, 2, 3],
      [PERMISSIONED_DISCRIMINATOR, 1, 3, 4],
    ] as const;
    for (const [discriminator, poolIndex, mintXIndex, mintYIndex] of variants) {
      const accounts = Array.from({ length: 5 }, () => key());
      const events = parseMeteoraPoolEvents(transaction(discriminator, accounts), "sig-variant");
      expect(events).toHaveLength(1);
      expect(events[0]?.pool).toBe(accounts[poolIndex]!.toBase58());
      expect(events[0]?.mintX).toBe(accounts[mintXIndex]!.toBase58());
      expect(events[0]?.mintY).toBe(accounts[mintYIndex]!.toBase58());
    }
  });

  it("handles the legacy permissioned account offset and inner instructions", () => {
    const pool = key();
    const mintX = key();
    const mintY = key();
    const events = parseMeteoraPoolEvents(
      transaction(PERMISSIONED_DISCRIMINATOR, [key(), pool, key(), mintX, mintY], { inner: true }),
      "sig-permissioned",
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      instruction: "initializePermissionLbPair",
      instructionIndex: "0.0",
      pool: pool.toBase58(),
      mintX: mintX.toBase58(),
      mintY: mintY.toBase58(),
    });
  });

  it("rejects a lookalike instruction from another program", () => {
    const events = parseMeteoraPoolEvents(
      transaction(CUSTOMIZABLE_DISCRIMINATOR, [key(), key(), key(), key()], { programId: key() }),
      "sig-other-program",
    );
    expect(events).toEqual([]);
  });

  it("persists signatures and resolves the exact pool only once", async () => {
    installConfig((c) => { c.discovery.event_intake_enabled = true; });
    const pool = key();
    const mintX = key();
    const mintY = key();
    const resolved = {
      address: pool.toBase58(),
      name: "EVENT-SOL",
      mintX: mintX.toBase58(),
      mintY: mintY.toBase58(),
      binStep: 100,
      baseFeePct: 0.1,
      dynamicFeePct: null,
      tvlUsd: 100_000,
      price: 1,
      decimalsX: 6,
      marketCapUsd: 2_000_000,
      vol30mUsd: 50_000,
      vol1hUsd: 100_000,
      vol24hUsd: 500_000,
      feeTvl30mPct: 10,
      feeTvl1hPct: 20,
      feeTvl4hPct: 30,
      feeTvl24hPct: 40,
      feesBothTokens: true,
      createdAt: new Date(1_700_000_000_000).toISOString(),
      extras: {
        holders: 100,
        marketCapUsd: 2_000_000,
        freezeAuthorityDisabled: true,
        launchpad: "",
        collectFeeMode: 0,
      } satisfies RawPoolExtras,
    };
    vi.mocked(fetchPool).mockResolvedValue(resolved);
    let transactionCalls = 0;
    const client = {
      getSignaturesForAddress: async () => [{ signature: "sig-event", slot: 123, blockTime: null, err: null }],
      getParsedTransactions: async () => {
        transactionCalls++;
        return [transaction(CUSTOMIZABLE_DISCRIMINATOR, [pool, key(), mintX, mintY])];
      },
    };

    const first = await discoverRecentMeteoraPools(client);
    const second = await discoverRecentMeteoraPools(client);

    expect(first).toMatchObject({ enabled: true, eventsFound: 1 });
    expect(first.pools).toHaveLength(1);
    expect(first.pools[0]?.address).toBe(pool.toBase58());
    expect(second.eventsFound).toBe(0);
    expect(second.pools).toHaveLength(1);
    expect(transactionCalls).toBe(1);
    expect(fetchPool).toHaveBeenCalledTimes(1);
  });

  it("paginates the bounded signature window", async () => {
    installConfig((c) => {
      c.discovery.event_intake_enabled = true;
      c.discovery.max_signatures_per_poll = 2;
      c.discovery.max_signature_pages_per_poll = 2;
      c.discovery.max_transactions_per_poll = 3;
    });
    const calls: Array<{ limit: number; before?: string; until?: string }> = [];
    const client = {
      getSignaturesForAddress: async (_address: PublicKey, options: { limit: number; before?: string; until?: string }) => {
        calls.push(options);
        if (!options.before) return [
          { signature: "sig-4", slot: 4, blockTime: null, err: null },
          { signature: "sig-3", slot: 3, blockTime: null, err: null },
        ];
        return [{ signature: "sig-2", slot: 2, blockTime: null, err: null }];
      },
      getParsedTransactions: async (signatures: string[]) => signatures.map(() =>
        transaction(CUSTOMIZABLE_DISCRIMINATOR, [key(), key(), key(), key()], { programId: key() })),
    };

    const result = await discoverRecentMeteoraPools(client);
    expect(result.signaturesFetched).toBe(3);
    expect(result.signaturesParsed).toBe(3);
    expect(result.windowTruncated).toBe(false);
    expect(calls).toEqual([{ limit: 2 }, { limit: 2, before: "sig-3" }]);
  });

  it("does not skip a signature when its page slot is malformed", async () => {
    installConfig((c) => {
      c.discovery.event_intake_enabled = true;
      c.discovery.max_signatures_per_poll = 2;
      c.discovery.max_signature_pages_per_poll = 2;
      c.discovery.max_transactions_per_poll = 3;
    });
    const calls: Array<{ limit: number; before?: string }> = [];
    const client = {
      getSignaturesForAddress: async (_address: PublicKey, options: { limit: number; before?: string }) => {
        calls.push(options);
        if (!options.before) return [
          { signature: "sig-bad-slot", slot: undefined as unknown as number, blockTime: null, err: null },
          { signature: "sig-3", slot: 3, blockTime: null, err: null },
        ];
        return [{ signature: "sig-2", slot: 2, blockTime: null, err: null }];
      },
      getParsedTransactions: async (signatures: string[]) => signatures.map(() =>
        transaction([0, 0, 0, 0, 0, 0, 0, 0], [key(), key(), key(), key()])),
    };

    const result = await discoverRecentMeteoraPools(client);
    const stored = getDb().prepare(
      "SELECT slot FROM discovery_signatures WHERE signature = ?",
    ).get("sig-bad-slot") as { slot: number };
    expect(result.signaturesFetched).toBe(3);
    expect(stored.slot).toBe(0);
    expect(calls).toEqual([{ limit: 2 }, { limit: 2, before: "sig-3" }]);
  });

  it.each([2, 3, 4, 5])("prioritizes new head signatures and retains old work for parse budget %i", async (limit) => {
    installConfig((c) => {
      c.discovery.event_intake_enabled = true;
      c.discovery.max_signatures_per_poll = 6;
      c.discovery.max_signature_pages_per_poll = 1;
      c.discovery.max_transactions_per_poll = limit;
    });
    let signaturePolls = 0;
    const transactionBatches: string[][] = [];
    const client = {
      getSignaturesForAddress: async () => {
        signaturePolls++;
        return signaturePolls === 1
          ? Array.from({ length: 6 }, (_, index) => ({
              signature: `old-${6 - index}`,
              slot: 6 - index,
              blockTime: null,
              err: null,
            }))
          : Array.from({ length: 6 }, (_, index) => ({
              signature: `new-${6 - index}`,
              slot: 16 - index,
              blockTime: null,
              err: null,
            }));
      },
      getParsedTransactions: async (signatures: string[]) => {
        transactionBatches.push([...signatures]);
        return signatures.map(() =>
          transaction([0, 0, 0, 0, 0, 0, 0, 0], [key(), key(), key(), key()], { programId: key() }),
        );
      },
    };

    await discoverRecentMeteoraPools(client);
    await discoverRecentMeteoraPools(client);

    const secondBatch = transactionBatches[1]!;
    expect(secondBatch).toHaveLength(limit);
    expect(secondBatch[0]).toBe("new-6");
    expect(secondBatch.some((signature) => signature.startsWith("old-"))).toBe(true);
    expect(new Set(secondBatch).size).toBe(limit);
  });

  it("bounds sustained head truncation and reports a capped backlog", async () => {
    installConfig((c) => {
      c.discovery.event_intake_enabled = true;
      c.discovery.max_signatures_per_poll = 2;
      c.discovery.max_signature_pages_per_poll = 1;
      c.discovery.max_transactions_per_poll = 1;
      c.discovery.max_pending_signatures = 100;
      c.discovery.max_backfill_ranges = 2;
    });
    let headPoll = 0;
    const client = {
      getSignaturesForAddress: async (_address: PublicKey, options: { limit: number; before?: string; until?: string }) => {
        if (options.before && options.until) return [
          { signature: `old-${headPoll}-1`, slot: headPoll * 2, blockTime: null, err: null },
          { signature: `old-${headPoll}-0`, slot: headPoll * 2 - 1, blockTime: null, err: null },
        ];
        headPoll++;
        return [
          { signature: `head-${headPoll}-1`, slot: headPoll * 2, blockTime: null, err: null },
          { signature: `head-${headPoll}-0`, slot: headPoll * 2 - 1, blockTime: null, err: null },
        ];
      },
      getParsedTransactions: async (signatures: string[]) => signatures.map(() =>
        transaction([0, 0, 0, 0, 0, 0, 0, 0], [key(), key(), key(), key()])),
    };

    let last = await discoverRecentMeteoraPools(client);
    for (let i = 0; i < 6; i++) last = await discoverRecentMeteoraPools(client);
    const ranges = (getDb().prepare("SELECT COUNT(*) AS count FROM discovery_backfill_ranges").get() as { count: number }).count;
    const pending = (getDb().prepare("SELECT COUNT(*) AS count FROM discovery_signatures WHERE status = 'pending'").get() as { count: number }).count;
    expect(ranges).toBeLessThanOrEqual(2);
    expect(pending).toBeLessThanOrEqual(100);
    expect(last.backlogCapped).toBe(true);
  });

  it("retains and drains a backfill range after a later head-window overload", async () => {
    installConfig((c) => {
      c.discovery.event_intake_enabled = true;
      c.discovery.max_signatures_per_poll = 2;
      c.discovery.max_signature_pages_per_poll = 1;
      c.discovery.max_transactions_per_poll = 10;
    });
    const calls: Array<{ limit: number; before?: string; until?: string }> = [];
    const client = {
      getSignaturesForAddress: async (_address: PublicKey, options: { limit: number; before?: string; until?: string }) => {
        calls.push(options);
        if (options.before === "sig-5" && options.until === "sig-4") {
          return [
            { signature: "sig-4", slot: 4, blockTime: null, err: null },
            { signature: "sig-3", slot: 3, blockTime: null, err: null },
          ];
        }
        if (options.until === "sig-4") {
          return [
            { signature: "sig-6", slot: 6, blockTime: null, err: null },
            { signature: "sig-5", slot: 5, blockTime: null, err: null },
          ];
        }
        if (options.until === "sig-6") return [];
        return [
          { signature: "sig-4", slot: 4, blockTime: null, err: null },
          { signature: "sig-3", slot: 3, blockTime: null, err: null },
        ];
      },
      getParsedTransactions: async (signatures: string[]) => signatures.map(() =>
        transaction(CUSTOMIZABLE_DISCRIMINATOR, [key(), key(), key(), key()], { programId: key() })),
    };

    await discoverRecentMeteoraPools(client);
    const overloaded = await discoverRecentMeteoraPools(client);
    expect(overloaded.windowTruncated).toBe(true);
    expect((getDb().prepare("SELECT COUNT(*) AS count FROM discovery_backfill_ranges").get() as { count: number }).count).toBe(1);

    await discoverRecentMeteoraPools(client);
    expect((getDb().prepare("SELECT COUNT(*) AS count FROM discovery_backfill_ranges").get() as { count: number }).count).toBe(0);
    expect(calls).toContainEqual({ limit: 2, before: "sig-5", until: "sig-4" });
  });

  it("retries null parsed transactions and then records them unavailable", async () => {
    installConfig((c) => {
      c.discovery.event_intake_enabled = true;
      c.discovery.max_signatures_per_poll = 10;
      c.discovery.max_signature_pages_per_poll = 1;
      c.discovery.max_transactions_per_poll = 2;
      c.discovery.max_transaction_retries = 2;
    });
    let signaturePolls = 0;
    let transactionPolls = 0;
    const client = {
      getSignaturesForAddress: async () => {
        signaturePolls++;
        return signaturePolls === 1
          ? [
              { signature: "sig-new", slot: 2, blockTime: null, err: null },
              { signature: "sig-old", slot: 1, blockTime: null, err: null },
            ]
          : [];
      },
      getParsedTransactions: async () => {
        transactionPolls++;
        return transactionPolls === 1
          ? [null, transaction(CUSTOMIZABLE_DISCRIMINATOR, [key(), key(), key(), key()], { programId: key() })]
          : [null];
      },
    };

    await discoverRecentMeteoraPools(client);
    await discoverRecentMeteoraPools(client);
    await discoverRecentMeteoraPools(client);

    const row = getDb().prepare(
      "SELECT status, attempts FROM discovery_signatures WHERE signature = ?",
    ).get("sig-new") as { status: string; attempts: number };
    expect(row).toEqual({ status: "unavailable", attempts: 2 });
    expect(transactionPolls).toBe(2);
  });

  it("drops a Datapi-blacklisted exact event pool", async () => {
    installConfig((c) => { c.discovery.event_intake_enabled = true; });
    const pool = key();
    const mintX = key();
    const mintY = key();
    vi.mocked(fetchPool).mockResolvedValue({
      address: pool.toBase58(),
      mintX: mintX.toBase58(),
      mintY: mintY.toBase58(),
      isBlacklisted: true,
    } as NonNullable<Awaited<ReturnType<typeof fetchPool>>>);
    const client = {
      getSignaturesForAddress: async () => [{ signature: "sig-blacklisted", slot: 123, blockTime: null, err: null }],
      getParsedTransactions: async () => [transaction(CUSTOMIZABLE_DISCRIMINATOR, [pool, key(), mintX, mintY])],
    };

    const result = await discoverRecentMeteoraPools(client);
    expect(result.pools).toEqual([]);
  });

  it("drops a Datapi response whose address is not the requested event pool", async () => {
    installConfig((c) => { c.discovery.event_intake_enabled = true; });
    const requested = key();
    const wrong = key();
    const mintX = key();
    const mintY = key();
    vi.mocked(fetchPool).mockResolvedValue({
      address: wrong.toBase58(),
      name: "WRONG-SOL",
      mintX: mintX.toBase58(),
      mintY: mintY.toBase58(),
      binStep: 100,
      baseFeePct: 0.1,
      dynamicFeePct: null,
      tvlUsd: 100_000,
      price: 1,
      decimalsX: 6,
      marketCapUsd: 2_000_000,
      vol30mUsd: 50_000,
      vol1hUsd: 100_000,
      vol24hUsd: 500_000,
      feeTvl30mPct: 10,
      feeTvl1hPct: 20,
      feeTvl4hPct: 30,
      feeTvl24hPct: 40,
      feesBothTokens: true,
      createdAt: new Date(1_700_000_000_000).toISOString(),
      extras: {
        holders: 100,
        marketCapUsd: 2_000_000,
        freezeAuthorityDisabled: true,
        launchpad: "",
        collectFeeMode: 0,
      },
    });
    const client = {
      getSignaturesForAddress: async () => [{ signature: "sig-address", slot: 123, blockTime: null, err: null }],
      getParsedTransactions: async () => [transaction(CUSTOMIZABLE_DISCRIMINATOR, [requested, key(), mintX, mintY])],
    };

    const result = await discoverRecentMeteoraPools(client);
    expect(result.pools).toEqual([]);
  });

  it("bounds retries when the parsed transaction RPC rejects", async () => {
    installConfig((c) => {
      c.discovery.event_intake_enabled = true;
      c.discovery.max_transaction_retries = 2;
      c.discovery.max_transactions_per_poll = 1;
    });
    let signaturePolls = 0;
    let transactionCalls = 0;
    const client = {
      getSignaturesForAddress: async () => {
        signaturePolls++;
        return signaturePolls === 1
          ? [{ signature: "sig-rpc-error", slot: 1, blockTime: null, err: null }]
          : [];
      },
      getParsedTransactions: async () => {
        transactionCalls++;
        throw new Error("RPC unavailable");
      },
    };

    await discoverRecentMeteoraPools(client);
    await discoverRecentMeteoraPools(client);

    const row = getDb().prepare(
      "SELECT status, attempts FROM discovery_signatures WHERE signature = ?",
    ).get("sig-rpc-error") as { status: string; attempts: number };
    expect(row).toEqual({ status: "unavailable", attempts: 2 });
    expect(transactionCalls).toBe(2);
  });

  it("rejects malformed account public keys before persistence", () => {
    const malformed = transaction(CUSTOMIZABLE_DISCRIMINATOR, [
      "not-a-public-key" as unknown as PublicKey,
      key(),
      key(),
      key(),
    ]);
    expect(parseMeteoraPoolEvents(malformed, "sig-malformed")).toEqual([]);
  });

  it("does not call the RPC when event intake is off by default", async () => {
    installConfig((c) => { c.discovery.event_intake_enabled = false; });
    let called = false;
    const result = await discoverRecentMeteoraPools({
      getSignaturesForAddress: async () => { called = true; return []; },
      getParsedTransactions: async () => { called = true; return []; },
    });
    expect(result).toMatchObject({ enabled: false, pools: [], eventsFound: 0 });
    expect(called).toBe(false);
  });
});


describe("GMGN event enrichment", () => {
  const mint = "7GPGqsfVK1gG88GuVEetrsVyDiikABTsj9B9aHEHpump";

  it("parses direct token info with the genuine 1m volume field", () => {
    const token = parseTokenInfo(JSON.stringify({
      code: 0,
      data: {
        address: mint,
        symbol: "LOCK",
        circulating_supply: "1000000",
        liquidity: 100795,
        holder_count: 1200,
        dev: { top_10_holder_rate: 0.18, creator_address: "creator" },
        price: { price: "2", price_1h: "1.8", volume_1m: "55104" },
        renounced_mint: true,
        renounced_freeze_account: true,
      },
    }));

    expect(token).toMatchObject({
      address: mint,
      volumeUsd: 55104,
      liquidityUsd: 100795,
      marketCapUsd: 2000000,
      renouncedMint: true,
      renouncedFreeze: true,
    });
    expect(token?.priceChangePct1h).toBeCloseTo(11.111, 2);
  });

  it("adds the event 1m row without mutating the primary trending map", () => {
    const first = {
      address: mint,
      symbol: "LOCK",
      priceChangePct1h: 5,
      volumeUsd: 1000,
      liquidityUsd: 100000,
      marketCapUsd: 2_000_000,
      holderCount: 100,
      top10HolderRate: 0.1,
      renouncedMint: true,
      renouncedFreeze: true,
      launchpad: "",
      creator: "",
      openTimestamp: 0,
    };
    const primary = new Map([[mint, presence(first, "5m", 1000)]]);
    const supplemental = new Map([[mint, presence({ ...first, volumeUsd: 55104 }, "1m", 2000)]]);
    const merged = mergeGmgnPresenceMaps(primary, supplemental);

    expect(primary.get(mint)?.intervals).toEqual(new Set(["5m"]));
    expect(merged.get(mint)?.intervals).toEqual(new Set(["5m", "1m"]));
    expect(gmgnOneMinuteFlow(merged.get(mint), 2000, 10_000)).toMatchObject({
      cadence: "1m",
      volumeUsd: 55104,
      observedAtMs: 2000,
    });
  });
});
