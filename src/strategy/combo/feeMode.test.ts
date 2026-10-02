import { describe, expect, it } from "vitest";
import { beforeEach } from "vitest";
import { readOnchainCollectFeeMode, _resetFeeModeCacheForTests } from "./feeMode.js";

beforeEach(() => _resetFeeModeCacheForTests());

const loader = (mode: unknown) => async () => ({ lbPair: { parameters: { collectFeeMode: mode as number } } });

describe("readOnchainCollectFeeMode (SDK LbPair.parameters.collectFeeMode)", () => {
  it("0 = InputOnly (fees in both tokens)", async () => {
    expect(await readOnchainCollectFeeMode("pool", loader(0))).toBe(0);
  });
  it("1 = OnlyY (quote-only: SOL fees)", async () => {
    expect(await readOnchainCollectFeeMode("pool", loader(1))).toBe(1);
  });
  it("an unrecognised value or a missing field is unreadable (null)", async () => {
    expect(await readOnchainCollectFeeMode("pool", loader(2))).toBeNull();
    expect(await readOnchainCollectFeeMode("pool", async () => ({}))).toBeNull();
  });
  it("a successful read is cached for the process (the mode is fixed at pool creation); failures are not", async () => {
    let calls = 0;
    const load = async () => { calls++; return { lbPair: { parameters: { collectFeeMode: 1 } } }; };
    expect(await readOnchainCollectFeeMode("p1", load)).toBe(1);
    expect(await readOnchainCollectFeeMode("p1", load)).toBe(1);
    expect(calls).toBe(1);
    let fails = 0;
    const flaky = async () => { fails++; throw new Error("x"); };
    expect(await readOnchainCollectFeeMode("p2", flaky)).toBeNull();
    expect(await readOnchainCollectFeeMode("p2", flaky)).toBeNull();
    expect(fails).toBe(2);
  });

  it("an RPC/SDK failure is null, never a throw", async () => {
    expect(await readOnchainCollectFeeMode("pool", async () => { throw new Error("rpc down"); })).toBeNull();
  });
});
