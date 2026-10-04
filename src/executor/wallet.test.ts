import { describe, it, expect, vi } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { PrivySigner, KeypairSigner, loadSigner } from "./wallet.js";

/** Minimal stand-in for the `PrivyClient` surface PrivySigner calls. */
function fakePrivy(signImpl: (walletId: string, input: { transaction: string; authorization_context?: { authorization_private_keys: string[] } }) => Promise<{ signed_transaction: string }>) {
  const signTransaction = vi.fn(signImpl);
  return {
    client: { wallets: () => ({ solana: () => ({ signTransaction } as any) } as any) } as any,
    signTransaction,
  };
}

describe("PrivySigner", () => {
  it("round-trips a legacy Transaction: serializes unsigned, deserializes the signed response", async () => {
    const walletKp = Keypair.generate();
    const { blockhash } = { blockhash: Keypair.generate().publicKey.toBase58() }; // any 32-byte-ish string works for a local-only test
    const tx = new Transaction({ feePayer: walletKp.publicKey, recentBlockhash: blockhash });
    tx.add(SystemProgram.transfer({ fromPubkey: walletKp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));

    const { client, signTransaction } = fakePrivy(async (walletId, { transaction }) => {
      expect(walletId).toBe("wallet-1");
      // The request must be the unsigned (or partially-signed), base64-encoded tx.
      const sent = Transaction.from(Buffer.from(transaction, "base64"));
      expect(sent.feePayer?.equals(walletKp.publicKey)).toBe(true);
      // Server signs for the wallet key.
      sent.partialSign(walletKp);
      return { signed_transaction: sent.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") };
    });

    const signer = new PrivySigner(client, "wallet-1", walletKp.publicKey, "auth-key");
    const signed = await signer.signTransaction(tx);

    expect(signTransaction).toHaveBeenCalledTimes(1);
    const [, input] = signTransaction.mock.calls[0]!;
    expect(input.authorization_context).toEqual({ authorization_private_keys: ["auth-key"] });
    expect(signed.signatures.find((s) => s.publicKey.equals(walletKp.publicKey))?.signature).not.toBeNull();
  });

  it("round-trips a VersionedTransaction", async () => {
    const walletKp = Keypair.generate();
    const msg = new TransactionMessage({
      payerKey: walletKp.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [SystemProgram.transfer({ fromPubkey: walletKp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);

    const { client } = fakePrivy(async (_walletId, { transaction }) => {
      const sent = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
      sent.sign([walletKp]);
      return { signed_transaction: Buffer.from(sent.serialize()).toString("base64") };
    });

    const signer = new PrivySigner(client, "wallet-1", walletKp.publicKey, "auth-key");
    const signed = await signer.signTransaction(tx);

    expect(signed).toBeInstanceOf(VersionedTransaction);
    expect(signed.signatures.length).toBeGreaterThan(0);
  });

  it("preserves an extra local signer already applied before the Privy round trip", async () => {
    const walletKp = Keypair.generate();
    const extraKp = Keypair.generate();
    const blockhash = Keypair.generate().publicKey.toBase58();
    const tx = new Transaction({ feePayer: walletKp.publicKey, recentBlockhash: blockhash });
    tx.add({
      programId: Keypair.generate().publicKey,
      keys: [{ pubkey: extraKp.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from("memo"),
    });
    tx.partialSign(extraKp); // caller applies local extra signers before handing to the WalletSigner

    const { client } = fakePrivy(async (_walletId, { transaction }) => {
      const sent = Transaction.from(Buffer.from(transaction, "base64"));
      // The extra signer's signature must have survived the trip to "Privy" already.
      expect(sent.signatures.find((s) => s.publicKey.equals(extraKp.publicKey))?.signature).not.toBeNull();
      sent.partialSign(walletKp);
      return { signed_transaction: sent.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") };
    });

    const signer = new PrivySigner(client, "wallet-1", walletKp.publicKey, "auth-key");
    const signed = await signer.signTransaction(tx);

    expect(signed.signatures.find((s) => s.publicKey.equals(extraKp.publicKey))?.signature).not.toBeNull();
    expect(signed.signatures.find((s) => s.publicKey.equals(walletKp.publicKey))?.signature).not.toBeNull();
  });

  it("propagates an error from the Privy API (e.g. a policy rejection) without swallowing it", async () => {
    const walletKp = Keypair.generate();
    const client = {
      wallets: () => ({
        solana: () => ({
          signTransaction: vi.fn(async () => { throw new Error("policy violation: instruction not allowlisted"); }),
        }),
      }),
    } as any;
    const tx = new Transaction({ feePayer: walletKp.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() });
    tx.add(SystemProgram.transfer({ fromPubkey: walletKp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));

    const signer = new PrivySigner(client, "wallet-1", walletKp.publicKey, "auth-key");
    await expect(signer.signTransaction(tx)).rejects.toThrow("policy violation");
  });
});

describe("KeypairSigner", () => {
  it("signs a legacy Transaction in place", async () => {
    const kp = Keypair.generate();
    const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() });
    tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
    const signer = new KeypairSigner(kp);
    const signed = await signer.signTransaction(tx);
    expect(signed.signatures.find((s) => s.publicKey.equals(kp.publicKey))?.signature).not.toBeNull();
  });
});

describe("loadSigner", () => {
  it("refuses to build a signer when neither Privy nor a raw keypair is configured", () => {
    expect(() => loadSigner({
      walletPrivateKey: undefined,
      walletKeypairPath: undefined,
      privyAppId: undefined,
      privyAppSecret: undefined,
      privyWalletId: undefined,
      privyWalletAddress: undefined,
      privyBotAuthKey: undefined,
    })).toThrow(/WALLET_PRIVATE_KEY or WALLET_KEYPAIR_PATH/);
  });

  it("requires PRIVY_WALLET_ADDRESS/APP credentials/auth key when PRIVY_WALLET_ID is set", () => {
    const base = {
      walletPrivateKey: undefined,
      walletKeypairPath: undefined,
      privyWalletId: "wallet-1",
      privyWalletAddress: undefined,
      privyAppId: undefined,
      privyAppSecret: undefined,
      privyBotAuthKey: undefined,
    };
    expect(() => loadSigner(base)).toThrow(/PRIVY_WALLET_ADDRESS/);
    expect(() => loadSigner({ ...base, privyWalletAddress: new PublicKey(Keypair.generate().publicKey).toBase58() }))
      .toThrow(/PRIVY_APP_ID/);
    expect(() => loadSigner({
      ...base,
      privyWalletAddress: Keypair.generate().publicKey.toBase58(),
      privyAppId: "app",
      privyAppSecret: "secret",
    })).toThrow(/PRIVY_BOT_AUTH_KEY/);
  });
});

describe("PrivySigner signing guard", () => {
  const tx = () => {
    const kp = Keypair.generate();
    const t = new Transaction({ feePayer: kp.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() });
    t.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
    return { kp, t };
  };
  const guard = (mode: "shadow" | "enforce") => ({ url: "https://guard.example/", token: "tok", mode, appId: "app-1" });

  it("enforce: adds a sign_fn that returns the guard's signature", async () => {
    const { kp, t } = tx();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, signature: "GUARDSIG" }), { status: 200 })));
    let ctx: any;
    const { client } = fakePrivy(async (_w, input: any) => { ctx = input.authorization_context; return { signed_transaction: t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") }; });
    await new PrivySigner(client, "wallet-1", kp.publicKey, "bot-key", guard("enforce")).signTransaction(t);
    expect(ctx.authorization_private_keys).toEqual(["bot-key"]);
    expect(await ctx.sign_fns[0](new Uint8Array([1, 2, 3]))).toBe("GUARDSIG");
    vi.unstubAllGlobals();
  });

  it("enforce: a guard refusal makes the sign_fn throw (the transaction cannot be signed)", async () => {
    const { kp, t } = tx();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, reasons: ["SOL transfer to X not allowed"] }), { status: 403 })));
    let ctx: any;
    const { client } = fakePrivy(async (_w, input: any) => { ctx = input.authorization_context; return { signed_transaction: t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") }; });
    await new PrivySigner(client, "wallet-1", kp.publicKey, "bot-key", guard("enforce")).signTransaction(t);
    await expect(ctx.sign_fns[0](new Uint8Array([1]))).rejects.toThrow(/signing guard refused: SOL transfer/);
    vi.unstubAllGlobals();
  });

  it("shadow: signs with the bot key alone and asks the guard without waiting on it", async () => {
    const { kp, t } = tx();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, reasons: ["x"] }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    let ctx: any;
    const { client } = fakePrivy(async (_w, input: any) => { ctx = input.authorization_context; return { signed_transaction: t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") }; });
    await new PrivySigner(client, "wallet-1", kp.publicKey, "bot-key", guard("shadow")).signTransaction(t);
    expect(ctx).toEqual({ authorization_private_keys: ["bot-key"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    const payload = JSON.parse(Buffer.from(body.payload, "base64").toString());
    expect(payload.url).toBe("https://api.privy.io/v1/wallets/wallet-1/rpc");
    expect(payload.body.method).toBe("signTransaction");
    vi.unstubAllGlobals();
  });

  it("no guard configured: unchanged behaviour", async () => {
    const { kp, t } = tx();
    let ctx: any;
    const { client } = fakePrivy(async (_w, input: any) => { ctx = input.authorization_context; return { signed_transaction: t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") }; });
    await new PrivySigner(client, "wallet-1", kp.publicKey, "bot-key").signTransaction(t);
    expect(ctx).toEqual({ authorization_private_keys: ["bot-key"] });
  });
});
