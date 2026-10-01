import { describe, expect, it, vi, afterEach } from "vitest";
import { queuePhoto } from "./telegramPhoto.js";

describe("queuePhoto", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never throws synchronously, even when the network call fails", () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => queuePhoto("tok", "chat", Buffer.from([1]), "caption")).not.toThrow();
    vi.unstubAllGlobals();
    errSpy.mockRestore();
  });

  it("does not throw when Telegram responds non-OK", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad request" }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => queuePhoto("tok", "chat", Buffer.from([1]), "caption")).not.toThrow();
    await new Promise((r) => setTimeout(r, 1100));
    expect(errSpy).toHaveBeenCalled();
    vi.unstubAllGlobals();
    errSpy.mockRestore();
  }, 3000);
});
