import { describe, expect, it, vi, beforeEach } from "vitest";

const queuePhoto = vi.fn();
vi.mock("./telegramPhoto.js", () => ({ queuePhoto: (...args: unknown[]) => queuePhoto(...args) }));

let renderResult: Buffer | null | "throw" = Buffer.from([1, 2, 3]);
vi.mock("./render.js", () => ({
  CARD_WIDTH: 1000,
  CARD_HEIGHT: 560,
  renderCardWithTimeout: async () => {
    if (renderResult === "throw") throw new Error("boom");
    return renderResult;
  },
}));

const { trySendAlertCard } = await import("./send.js");

describe("trySendAlertCard", () => {
  beforeEach(() => {
    queuePhoto.mockClear();
    renderResult = Buffer.from([1, 2, 3]);
  });

  it("queues a photo when render succeeds", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await trySendAlertCard("entry", "WIF pos#1: entered 0.1 SOL @ 1", send, "tok", "chat", "plain line");
    expect(queuePhoto).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("falls back to plain text when render returns null (timeout)", async () => {
    renderResult = null;
    const send = vi.fn().mockResolvedValue(undefined);
    await trySendAlertCard("entry", "WIF pos#1: entered 0.1 SOL @ 1", send, "tok", "chat", "plain line");
    expect(queuePhoto).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("tok", "chat", "plain line");
  });

  it("falls back to plain text when render throws", async () => {
    renderResult = "throw";
    const send = vi.fn().mockResolvedValue(undefined);
    await trySendAlertCard("close", "garbage", send, "tok", "chat", "plain line");
    expect(queuePhoto).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("tok", "chat", "plain line");
  });

  it("never throws even when the text fallback itself fails", async () => {
    renderResult = "throw";
    const send = vi.fn().mockRejectedValue(new Error("telegram down"));
    await expect(
      trySendAlertCard("close", "garbage", send, "tok", "chat", "plain line"),
    ).resolves.toBeUndefined();
  });
});
