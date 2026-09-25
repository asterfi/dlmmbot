import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  txErrorDetail,
  landedTxError,
  rangeGapTooLarge,
  shouldRebuildOpenOnSlippage,
  wealthDeltaLamports,
  OPEN_SLIPPAGE_REBUILDS,
  requireOpenCostSol,
  bookRentReclaim,
  allocateBatchReclaim,
} from "./live.js";
import { classifyLeftover, RESIDUAL_SWEEP_MIN_SOL } from "./executor.js";
import { UNDERFILL_INCIDENT_SHARE } from "./live.js";
import { PublicKey } from "@solana/web3.js";
import { SOL_MINT } from "../config.js";
import { useMemoryDb, insertClosedPosition, resetTestDb } from "../test/db.js";
import { getDb, REALIZED_PNL_SQL } from "../db/db.js";

describe("txErrorDetail", () => {
  it("extracts ExceededBinSlippageTolerance from 0x1774", () => {
    const d = txErrorDetail({
      message: "Simulation failed.\nCustom program error: 0x1774",
      logs: ["Program log: AnchorError caused by account: bin_array. Error Code: ExceededBinSlippageTolerance. Error Number: 6004."],
    });
    expect(d.code).toBe("ExceededBinSlippageTolerance");
    expect(d.summary).toContain("ExceededBinSlippageTolerance");
    expect(d.summary).not.toMatch(/^ExceededBinSlippageTolerance — Simulation failed\.?$/);
  });

  it("does not let truncated Simulation failed. win as the tip alone without code", () => {
    const d = txErrorDetail({
      message: "Simulation failed.\nCustom program error: 0x1774",
      logs: [],
    });
    expect(d.code).toBe("ExceededBinSlippageTolerance");
    expect(d.summary.toLowerCase()).not.toBe("simulation failed.");
  });

  it("reads named Error Code from logs", () => {
    const d = txErrorDetail({
      message: "Transaction failed",
      logs: ["Error Code: InsufficientFunds"],
    });
    expect(d.code).toBe("InsufficientFunds");
  });
});

describe("landedTxError", () => {
  it("names the program code from a confirmed-but-failed tx so open can rebuild", () => {
    const e = landedTxError("SIG", {
      err: { InstructionError: [2, { Custom: 6004 }] },
      logMessages: [
        "Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo invoke [1]",
        "Program log: AnchorError thrown in programs/lb_clmm/src/instructions/deposit/add_liquidity_by_strategy.rs:41. Error Code: ExceededBinSlippageTolerance. Error Number: 6004. Error Message: Exceeded bin slippage tolerance.",
      ],
    });
    expect(e.code).toBe("ExceededBinSlippageTolerance");
    expect(e.message).toMatch(/SIG — ExceededBinSlippageTolerance/);
    expect(txErrorDetail(e).code).toBe("ExceededBinSlippageTolerance");
    expect(shouldRebuildOpenOnSlippage(txErrorDetail(e).code, 0)).toBe(true);
  });

  it("still reports the signature when the tx cannot be fetched", () => {
    const e = landedTxError("SIG", null);
    expect(e.code).toBeNull();
    expect(e.message).toBe("tx landed with on-chain error: SIG — tx not retrievable");
  });
});

describe("live open/mark guards", () => {
  it("refuses range gap > 150 bins", () => {
    expect(rangeGapTooLarge(1000, 1200)).toBe(true);
    expect(rangeGapTooLarge(1000, 1100)).toBe(false);
  });

  it("rebuilds on slippage for early attempts only", () => {
    expect(shouldRebuildOpenOnSlippage("ExceededBinSlippageTolerance", 0)).toBe(true);
    expect(shouldRebuildOpenOnSlippage("ExceededBinSlippageTolerance", OPEN_SLIPPAGE_REBUILDS)).toBe(false);
    expect(shouldRebuildOpenOnSlippage("InsufficientFunds", 0)).toBe(false);
  });

  it("requires a known positive wallet debit before recording an open", () => {
    expect(requireOpenCostSol(-0.105)).toBeCloseTo(0.105, 9);
    expect(() => requireOpenCostSol(null)).toThrow(/unknown/i);
    expect(() => requireOpenCostSol(0)).toThrow(/positive/i);
    expect(() => requireOpenCostSol(Number.NaN)).toThrow(/unknown/i);
  });
});

describe("wealthDeltaLamports", () => {
  const wallet = new PublicKey("9DTThTbggnp2P2ZGLFRfN1A3j5JUsXez1dRJak3TixB2");
  const other = new PublicKey("11111111111111111111111111111111");

  it("counts native + wSOL as one wealth figure", () => {
    const keys = [{ pubkey: other }, { pubkey: wallet }];
    const meta = {
      preBalances: [0, 1_000_000_000],
      postBalances: [0, 999_992_970], // -0.00000703 native
      preTokenBalances: [
        { accountIndex: 2, mint: SOL_MINT, owner: wallet.toBase58(), uiTokenAmount: { amount: "0", decimals: 9, uiAmount: 0 } },
      ],
      postTokenBalances: [
        { accountIndex: 2, mint: SOL_MINT, owner: wallet.toBase58(), uiTokenAmount: { amount: "603934037", decimals: 9, uiAmount: 0.603934037 } },
      ],
    };
    const d = wealthDeltaLamports(meta as never, keys, wallet);
    expect(d).toBe(603934037 - 7030);
  });

  it("nets unwrap (native up, wSOL down) to ~0", () => {
    const keys = [{ pubkey: wallet }];
    const meta = {
      preBalances: [1_000_000_000],
      postBalances: [1_600_000_000],
      preTokenBalances: [
        { accountIndex: 1, mint: SOL_MINT, owner: wallet.toBase58(), uiTokenAmount: { amount: "600000000", decimals: 9, uiAmount: 0.6 } },
      ],
      postTokenBalances: [],
    };
    const d = wealthDeltaLamports(meta as never, keys, wallet);
    expect(d).toBe(0);
  });
});

describe("classifyLeftover — what a close left in the wallet", () => {
  const MARK = 0.22;

  it("reports nothing when the close swept the token side clean", () => {
    expect(classifyLeftover(null, MARK, false)).toEqual({ kind: "none", share: null, creditSol: 0 });
  });

  // pos#15 BUTTHOLE, 2026-08-17: a WINNING close (+0.0002 SOL) that filed an
  // error over 0.00045 SOL of dust and claimed "residual sweep will sell it" —
  // for an amount sweepResiduals is guaranteed to skip.
  it("treats a leftover under the sweep floor as dust, not an incident", () => {
    const r = classifyLeftover(0.00045059, MARK, true);
    expect(r.kind).toBe("dust");
    expect(r.creditSol).toBe(0); // nothing will convert it — book the loss now
  });

  it("treats a leftover at or above the sweep floor as a recoverable strand", () => {
    const r = classifyLeftover(RESIDUAL_SWEEP_MIN_SOL, MARK, true);
    expect(r.kind).toBe("strand");
    expect(r.creditSol).toBe(RESIDUAL_SWEEP_MIN_SOL);
  });

  // ANSEM pos#8: 0.5327 SOL, 75% of mark — the case the detector exists for.
  it("flags a large under-fill and carries its full value as credit", () => {
    const r = classifyLeftover(0.532672767, 0.7144471699792198, true);
    expect(r.kind).toBe("strand");
    expect(r.creditSol).toBeCloseTo(0.532672767, 9);
    expect(r.share!).toBeGreaterThan(0.25); // clears the alert bar
  });

  // The three reports that motivated the split (2026-08-17/18), all "strand"
  // by the sweep floor, all winners, all sold by the sweep within minutes:
  //   BUTTHOLE pos#15  0.00045 / 0.22   (dust, handled above)
  //   Z500     pos#102 0.0022  / 0.254  = 0.9%
  //   67coin   pos#112 0.0098  / 0.633  = 1.5%
  // A strand is real (the sweep must sell it) but it is only an INCIDENT — a
  // paged report — when it is a material share of the mark. The alert has
  // drawn that line at 25% since v0.8.0; the log level now follows it.
  it("a sliver strand is under the incident line; ANSEM's 75% is over it", () => {
    const z500 = classifyLeftover(0.002220877, 0.25391442071265596, true);
    const coin = classifyLeftover(0.009793362, 0.6332123136224322, true);
    const ansem = classifyLeftover(0.532672767, 0.7144471699792198, true);
    expect(z500.kind).toBe("strand");
    expect(coin.kind).toBe("strand");
    expect(z500.share!).toBeLessThan(UNDERFILL_INCIDENT_SHARE);
    expect(coin.share!).toBeLessThan(UNDERFILL_INCIDENT_SHARE);
    expect(ansem.share!).toBeGreaterThanOrEqual(UNDERFILL_INCIDENT_SHARE);
  });

  it("flags an unquotable leftover rather than assuming it is dust", () => {
    // Being unable to price it is exactly when we must not write it off.
    const r = classifyLeftover(null, MARK, true);
    expect(r.kind).toBe("strand");
    expect(r.share).toBeNull();
    expect(r.creditSol).toBe(0); // but PnL may only count what we can value
  });

  it("returns no share when the mark is zero (empty close)", () => {
    expect(classifyLeftover(0.05, 0, true).share).toBeNull();
  });
});

describe("bookRentReclaim — reclaimed rent must reach realized PnL", () => {
  // pos#1 JEANPHIL and pos#2 PAID each had an ATA closed ~24h after the
  // position closed, returning 0.001508818 SOL. The receipt (the events row)
  // was written; the credit was not, so REALIZED_PNL_SQL — which reads
  // recovered_sol — never saw the money. Everything downstream reported the
  // book worse than chain truth. The receipt and the credit must be one
  // atomic, replayable-safe act.
  const RECLAIM = 0.001508818;
  const SIG = "5ReclaimSigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());

  function recoveredOf(id: number): number {
    const row = getDb().prepare("SELECT recovered_sol AS r FROM positions WHERE id = ?").get(id) as { r: number | null };
    return row.r ?? 0;
  }

  function pnlFor(id: number): number | null {
    const row = getDb().prepare(`SELECT (${REALIZED_PNL_SQL}) AS pnl FROM positions WHERE id = ?`).get(id) as { pnl: number | null };
    return row.pnl;
  }

  function reclaimReceipts(): Array<{ position_id: number | null; sol_delta: number | null }> {
    return getDb().prepare("SELECT position_id, sol_delta FROM events WHERE type = 'rent_reclaim' ORDER BY id").all() as Array<{
      position_id: number | null;
      sol_delta: number | null;
    }>;
  }

  function reclaimDetail(): Array<{ credited?: number }> {
    return (getDb().prepare("SELECT detail_json FROM events WHERE type = 'rent_reclaim' ORDER BY id").all() as Array<{
      detail_json: string;
    }>).map((r) => JSON.parse(r.detail_json) as { credited?: number });
  }

  /** A closed row measured on the real basis so REALIZED_PNL_SQL returns a number. */
  function closedPos(): number {
    return insertClosedPosition({
      entrySol: 0.1,
      exitSol: 0.100219,
      openCostSol: 0.143427, // 0.1 deploy + 0.043427 rents/fees
      closeReturnSol: 0.142212,
      feesMeasuredSol: 0.000572,
    });
  }

  it("credits the reclaim to recovered_sol AND writes the receipt, atomically", () => {
    const id = closedPos();
    const before = pnlFor(id)!;

    const booked = bookRentReclaim({ positionId: id, deltaSol: RECLAIM, txSig: SIG });

    expect(booked).toBe(true);
    expect(recoveredOf(id)).toBeCloseTo(RECLAIM, 9);
    expect(pnlFor(id)!).toBeCloseTo(before + RECLAIM, 9);
    expect(reclaimReceipts()).toHaveLength(1);
    expect(reclaimReceipts()[0]!.sol_delta).toBeCloseTo(RECLAIM, 9);
    expect(reclaimReceipts()[0]!.position_id).toBe(id);
    // The receipt must carry the marker, or a later backfill cannot tell this
    // credited reclaim from a pre-fix one and would book it a second time.
    expect(reclaimDetail()[0]!.credited).toBeCloseTo(RECLAIM, 9);
  });

  // The reclaim path can retry. Two inserts for one signature would book the
  // rent twice — turning an accounting bug into an accounting forger.
  it("is idempotent on txSig: a replayed reclaim credits exactly once", () => {
    const id = closedPos();

    expect(bookRentReclaim({ positionId: id, deltaSol: RECLAIM, txSig: SIG })).toBe(true);
    expect(bookRentReclaim({ positionId: id, deltaSol: RECLAIM, txSig: SIG })).toBe(false);

    expect(recoveredOf(id)).toBeCloseTo(RECLAIM, 9);
    expect(reclaimReceipts()).toHaveLength(1);
  });

  // closeEmptyAccounts only resolves a position when the batch held one
  // account. A multi-account batch's walletDelta spans several mints and must
  // not be blamed on whichever position sorts last.
  it("writes the receipt but credits nothing when no single position owns the batch", () => {
    const id = closedPos();

    expect(bookRentReclaim({ positionId: null, deltaSol: RECLAIM, txSig: SIG })).toBe(true);

    expect(recoveredOf(id)).toBe(0);
    expect(reclaimReceipts()).toHaveLength(1);
    expect(reclaimReceipts()[0]!.position_id).toBeNull();
    expect(reclaimDetail()[0]!.credited).toBeUndefined(); // nothing was credited, so say so
  });

  // walletDelta returns null when the tx cannot be fetched. An unknown amount
  // must not be invented — the receipt stands, the credit does not.
  it("writes the receipt but credits nothing when the delta is unknown", () => {
    const id = closedPos();

    expect(bookRentReclaim({ positionId: id, deltaSol: null, txSig: SIG })).toBe(true);

    expect(recoveredOf(id)).toBe(0);
    expect(reclaimReceipts()).toHaveLength(1);
    expect(reclaimReceipts()[0]!.sol_delta).toBe(0);
    expect(reclaimDetail()[0]!.credited).toBeUndefined();
  });

  // recovered_sol is also written by the residual sweep. The rent reclaim must
  // ADD to it, never reset it, and must not touch stranded_sol (the sweep owns
  // that transition).
  it("accumulates onto an existing recovered credit and leaves stranded_sol alone", () => {
    const id = insertClosedPosition({
      entrySol: 0.75,
      exitSol: 0.7144,
      openCostSol: 0.8669,
      closeReturnSol: 0.2955,
      feesMeasuredSol: 0.0292,
      recoveredSol: 0.5323, // what the residual sweep already booked
      strandedSol: 0, // the sweep zeroed it as it credited
    });

    bookRentReclaim({ positionId: id, deltaSol: RECLAIM, txSig: SIG });

    expect(recoveredOf(id)).toBeCloseTo(0.5323 + RECLAIM, 9);
    const row = getDb().prepare("SELECT stranded_sol AS s FROM positions WHERE id = ?").get(id) as { s: number };
    expect(row.s).toBe(0);
  });

  // Two ATAs closed for two different positions must not be collapsed.
  it("credits each position independently", () => {
    const a = closedPos();
    const b = closedPos();

    bookRentReclaim({ positionId: a, deltaSol: RECLAIM, txSig: SIG + "a" });
    bookRentReclaim({ positionId: b, deltaSol: RECLAIM, txSig: SIG + "b" });

    expect(recoveredOf(a)).toBeCloseTo(RECLAIM, 9);
    expect(recoveredOf(b)).toBeCloseTo(RECLAIM, 9);
    expect(reclaimReceipts()).toHaveLength(2);
  });

});

// The 2026-09-23 20:42:10Z batch (tx 3KHRxZdjjCufQ4…) closed three ATAs in ONE
// transaction: WALTER 1,488,440 lamports, CALI 1,513,840, KCAT 1,513,840, for a
// measured wallet delta of 4,418,178 (fee 97,942). closeEmptyAccounts only
// resolved a position when `batch.length === 1`, so posId was null, the credit
// was withheld, and +0.004418178 SOL never reached any position — the money is
// on the chain and absent from the book. Each closed account's own pre-close
// lamports ARE its rent, and each mint maps to exactly one position, so the
// batch can be attributed instead of abandoned.
describe("allocateBatchReclaim — per-account attribution of a multi-account batch", () => {
  // Real lamports from tx 3KHRxZdjjCufQ4…, real wallet delta, real fee.
  const LAMPORTS = [1_488_440, 1_513_840, 1_513_840];
  const DELTA = 4_418_178 / 1e9;
  const POS = [5, 3, 4]; // WALTER, CALI, KCAT

  const batch = (positionIds: Array<number | null>) =>
    positionIds.map((positionId, i) => ({ lamports: LAMPORTS[i]!, positionId }));

  it("gives each owning position its own rent share", () => {
    const out = allocateBatchReclaim(batch(POS), DELTA)!;

    expect(out).toHaveLength(3);
    expect(out.map((a) => a.positionId)).toEqual(POS);
    // WALTER's ATA was the cheaper one — it must get the smaller share, not an
    // equal split. Each position is credited its own rent NET of its pro-rata
    // share of the 97,942-lamport fee, so the three shares sum to the wallet delta.
    expect(out[0]!.creditSol).toBeCloseTo(1_456_159.903262092 / 1e9, 9);
    expect(out[1]!.creditSol).toBeCloseTo(1_513_840 / 1e9 * (DELTA * 1e9 / 4_516_120), 9);
    expect(out[0]!.creditSol).toBeLessThan(out[1]!.creditSol);
  });

  // Chain truth: what the book credits must EQUAL what the wallet received.
  it("allocations sum exactly to the measured wallet delta", () => {
    const out = allocateBatchReclaim(batch(POS), DELTA)!;
    const sum = out.reduce((s, a) => s + a.creditSol, 0);
    expect(sum).toBeCloseTo(DELTA, 12);
  });

  it("leaves an unowning account's share uncredited instead of guessing", () => {
    const out = allocateBatchReclaim(batch([5, null, 4]), DELTA)!;

    expect(out.map((a) => a.positionId)).toEqual([5, 4]);
    const sum = out.reduce((s, a) => s + a.creditSol, 0);
    // The unowned account's proportional share stays out of the book — no
    // position owns it, so nothing may claim it. The receipt still records the
    // full wallet delta.
    expect(sum).toBeLessThan(DELTA);
    expect(sum).toBeCloseTo(DELTA - 1_481_009.048368954 / 1e9, 9);
  });

  // pos#41 OP: the exit swap routed through USDC and pumpCmXq hop mints and
  // created a fresh ATA for each (1,488,440 + 1,539,240 lamports). Those mints
  // are not position mints, so positionIdOf() returns null — yet the wallet
  // paid that rent inside the swap and received it back in the reclaim. With
  // ONE owning position in the batch the creator is not a guess: there is only
  // one possible owner, so the share must be credited or the book records a
  // loss the chain never took.
  it("attributes a hop-mint ATA's share when the batch has one owning position", () => {
    const out = allocateBatchReclaim(batch([5, null, null]), DELTA)!;

    expect(out).toHaveLength(3);
    expect(out.every((a) => a.positionId === 5)).toBe(true);
    // What the book credits must EQUAL what the wallet received.
    const sum = out.reduce((s, a) => a.creditSol + s, 0);
    expect(sum).toBeCloseTo(DELTA, 12);
  });

  // Two distinct owning positions in one batch makes the unowned account's
  // creator genuinely unknowable — it still goes uncredited rather than guessed.
  it("still refuses to guess when one batch spans two owning positions", () => {
    const out = allocateBatchReclaim(batch([5, null, 4]), DELTA)!;
    expect(out.map((a) => a.positionId)).toEqual([5, 4]);
    const sum = out.reduce((s, a) => a.creditSol + s, 0);
    expect(sum).toBeLessThan(DELTA);
  });

  // An unknown delta must not be invented from lamports alone: the fee is only
  // knowable from the landed tx.
  it("returns null when the wallet delta is unknown", () => {
    expect(allocateBatchReclaim(batch(POS), null)).toBeNull();
    expect(allocateBatchReclaim(batch(POS), Number.NaN)).toBeNull();
  });

  it("returns null when no account's lamports could be read", () => {
    const zeroed = POS.map((positionId) => ({ lamports: 0, positionId }));
    expect(allocateBatchReclaim(zeroed, DELTA)).toBeNull();
  });

  it("degenerates to a single credit when the batch held one account", () => {
    const out = allocateBatchReclaim([{ lamports: 1_513_840, positionId: 7 }], 1_513_840 / 1e9)!;
    expect(out).toEqual([{ positionId: 7, creditSol: 1_513_840 / 1e9 }]);
  });
});

describe("bookRentReclaim — batch allocations", () => {
  const SIG = "3BatchReclaimSigAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const DELTA = 4_418_178 / 1e9;

  beforeEach(() => useMemoryDb());
  afterEach(() => resetTestDb());

  function recoveredOf(id: number): number {
    const row = getDb().prepare("SELECT recovered_sol AS r FROM positions WHERE id = ?").get(id) as { r: number | null };
    return row.r ?? 0;
  }
  function receipts(): Array<{ position_id: number | null; sol_delta: number | null }> {
    return getDb().prepare("SELECT position_id, sol_delta FROM events WHERE type = 'rent_reclaim' ORDER BY id").all() as Array<{
      position_id: number | null; sol_delta: number | null;
    }>;
  }
  function detail(): Array<Record<string, unknown>> {
    return (getDb().prepare("SELECT detail_json FROM events WHERE type = 'rent_reclaim' ORDER BY id").all() as Array<{ detail_json: string }>)
      .map((r) => JSON.parse(r.detail_json) as Record<string, unknown>);
  }
  function closedPos(): number {
    return insertClosedPosition({
      entrySol: 0.1, exitSol: 0.100219, openCostSol: 0.143427,
      closeReturnSol: 0.142212, feesMeasuredSol: 0.000572,
    });
  }

  // THE BUG: one receipt for the batch, but the credit must reach all three
  // positions — otherwise the money stays invisible to REALIZED_PNL_SQL.
  it("credits every owning position and writes ONE receipt for the batch", () => {
    const walter = closedPos(), cali = closedPos(), kcat = closedPos();

    const booked = bookRentReclaim({
      positionId: null,
      deltaSol: DELTA,
      txSig: SIG,
      allocations: [
        { positionId: walter, creditSol: 1_456_159.903262092 / 1e9 },
        { positionId: cali, creditSol: 1_481_009.048368954 / 1e9 },
        { positionId: kcat, creditSol: 1_481_009.048368954 / 1e9 },
      ],
    });

    expect(booked).toBe(true);
    expect(recoveredOf(walter)).toBeCloseTo(1_456_159.903262092 / 1e9, 9);
    expect(recoveredOf(cali)).toBeCloseTo(1_481_009.048368954 / 1e9, 9);
    expect(recoveredOf(kcat)).toBeCloseTo(1_481_009.048368954 / 1e9, 9);
    // One receipt per landed tx — idempotency stays keyed on txSig.
    expect(receipts()).toHaveLength(1);
    expect(receipts()[0]!.sol_delta).toBeCloseTo(DELTA, 9);
    expect(receipts()[0]!.position_id).toBeNull();
    // The reconciler's marker must equal the total actually credited.
    const credited = recoveredOf(walter) + recoveredOf(cali) + recoveredOf(kcat);
    expect(detail()[0]!.credited).toBeCloseTo(credited, 9);
    expect(detail()[0]!.credited).toBeCloseTo(DELTA, 9);
    expect(detail()[0]!.allocations).toHaveLength(3);
  });

  // A replayed reclaim must not book the batch twice.
  it("is idempotent on txSig: a replayed batch credits exactly once", () => {
    const a = closedPos(), b = closedPos();
    const allocations = [
      { positionId: a, creditSol: 2_000_000 / 1e9 },
      { positionId: b, creditSol: 2_000_000 / 1e9 },
    ];

    expect(bookRentReclaim({ positionId: null, deltaSol: 4_000_000 / 1e9, txSig: SIG, allocations })).toBe(true);
    expect(bookRentReclaim({ positionId: null, deltaSol: 4_000_000 / 1e9, txSig: SIG, allocations })).toBe(false);

    expect(recoveredOf(a)).toBeCloseTo(2_000_000 / 1e9, 9);
    expect(recoveredOf(b)).toBeCloseTo(2_000_000 / 1e9, 9);
    expect(receipts()).toHaveLength(1);
  });

  // Book must never claim more than the wallet actually received.
  it("withholds the whole credit when allocations exceed the measured delta", () => {
    const a = closedPos(), b = closedPos();

    const booked = bookRentReclaim({
      positionId: null,
      deltaSol: DELTA,
      txSig: SIG,
      allocations: [
        { positionId: a, creditSol: 3_000_000 / 1e9 },
        { positionId: b, creditSol: 3_000_000 / 1e9 },
      ],
    });

    expect(booked).toBe(true); // receipt still stands
    expect(recoveredOf(a)).toBe(0);
    expect(recoveredOf(b)).toBe(0);
    expect(receipts()).toHaveLength(1);
    expect(detail()[0]!.credited).toBeUndefined();
    expect(detail()[0]!.creditWithheld).toMatch(/exceed/);
  });

  it("withholds when an allocation names a non-positive amount", () => {
    const a = closedPos();

    bookRentReclaim({ positionId: null, deltaSol: DELTA, txSig: SIG, allocations: [{ positionId: a, creditSol: 0 }] });

    expect(recoveredOf(a)).toBe(0);
    expect(detail()[0]!.credited).toBeUndefined();
    expect(detail()[0]!.creditWithheld).toBeTruthy();
  });

  // delta unknown → the receipt stands, nothing is credited, same as the
  // single-account path.
  it("withholds when the wallet delta is unknown", () => {
    const a = closedPos();

    bookRentReclaim({ positionId: null, deltaSol: null, txSig: SIG, allocations: [{ positionId: a, creditSol: 0.001 }] });

    expect(recoveredOf(a)).toBe(0);
    expect(detail()[0]!.credited).toBeUndefined();
  });

  it("adds onto an existing recovered credit and leaves stranded_sol alone", () => {
    const id = insertClosedPosition({
      entrySol: 0.75, exitSol: 0.7144, openCostSol: 0.8669, closeReturnSol: 0.2955,
      feesMeasuredSol: 0.0292, recoveredSol: 0.5323, strandedSol: 0,
    });

    bookRentReclaim({ positionId: null, deltaSol: DELTA, txSig: SIG, allocations: [{ positionId: id, creditSol: DELTA }] });

    expect(recoveredOf(id)).toBeCloseTo(0.5323 + DELTA, 9);
    const row = getDb().prepare("SELECT stranded_sol AS s FROM positions WHERE id = ?").get(id) as { s: number };
    expect(row.s).toBe(0);
  });
});

