import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { PrivyClient, formatRequestForAuthorizationSignature } from "@privy-io/node";

/**
 * Load the burner-wallet keypair. Sources, in priority order:
 *   1. WALLET_PRIVATE_KEY — base58 secret key string as exported by Phantom
 *   2. WALLET_KEYPAIR_PATH — solana-keygen JSON array file
 * Only the live executor calls this — scanner and vetting never touch keys.
 * Never log the secret.
 */
export function loadKeypair(
  privateKey: string | undefined,
  path: string | undefined,
): Keypair {
  if (privateKey) {
    let decoded: Uint8Array;
    try {
      decoded = bs58.decode(privateKey.trim());
    } catch {
      throw new Error("WALLET_PRIVATE_KEY is not valid base58 (paste the Phantom export unmodified)");
    }
    if (decoded.length !== 64) {
      throw new Error(`WALLET_PRIVATE_KEY decodes to ${decoded.length} bytes, expected 64`);
    }
    return Keypair.fromSecretKey(decoded);
  }
  if (!path) {
    throw new Error("set WALLET_PRIVATE_KEY or WALLET_KEYPAIR_PATH — required for live mode");
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  if (!Array.isArray(raw) || raw.length !== 64) {
    throw new Error("keypair file is not a 64-byte solana-keygen JSON array");
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/**
 * Anything that can produce the wallet's signature over a transaction.
 * The executor only ever touches `.publicKey` and `.signTransaction` — it
 * never needs to know whether the secret key lives in-process (KeypairSigner)
 * or behind the Privy API (PrivySigner). `signTransaction` only has to add
 * THIS signer's own signature; a caller that also has local extra signers
 * (e.g. a fresh position account keypair) applies those itself before/after,
 * the same way `Transaction.partialSign` composes.
 */
export interface WalletSigner {
  readonly publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
}

/** Existing in-process behavior: sign with the raw Keypair. */
export class KeypairSigner implements WalletSigner {
  constructor(private readonly keypair: Keypair) {}

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (tx instanceof VersionedTransaction) {
      tx.sign([this.keypair]);
    } else {
      (tx as Transaction).partialSign(this.keypair);
    }
    return tx;
  }
}

/**
 * Signs via the Privy API. The bot process never holds the Solana secret
 * key — Privy's server-side policy (program/instruction allowlist bound to
 * PRIVY_BOT_AUTH_KEY) is the actual safety boundary here, not anything in
 * this class. This is just the wire protocol: serialize unsigned (or
 * partially signed) → send to Privy → deserialize what comes back.
 */
/**
 * Signing guard (deploy/hardened/guard): an independent service holding the
 * second key of a 2-of-2 Privy signer. "shadow" asks it about every transaction
 * in the background and only logs the verdict; "enforce" makes its signature
 * part of the request, so a transaction it refuses cannot be signed at all.
 */
export interface GuardOptions {
  url: string;
  token: string;
  mode: "shadow" | "enforce";
  appId: string;
}

interface GuardAnswer { ok: boolean; signature?: string; reasons: string[] }

async function askGuard(g: GuardOptions, payload: Uint8Array): Promise<GuardAnswer> {
  const res = await fetch(`${g.url.replace(/\/$/, "")}/sign`, {
    method: "POST",
    headers: { authorization: `Bearer ${g.token}`, "content-type": "application/json" },
    body: JSON.stringify({ payload: Buffer.from(payload).toString("base64") }),
    signal: AbortSignal.timeout(8000),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; signature?: string; reasons?: string[] };
  return { ok: res.ok && j.ok === true, signature: j.signature, reasons: j.reasons ?? [`HTTP ${res.status}`] };
}

export class PrivySigner implements WalletSigner {
  constructor(
    private readonly privy: PrivyClient,
    private readonly walletId: string,
    readonly publicKey: PublicKey,
    private readonly authKey: string,
    private readonly guard?: GuardOptions,
  ) {}

  /** Shadow mode: the same request the SDK will sign, sent to the guard; never blocks or throws. */
  private shadowCheck(transaction: string): void {
    const g = this.guard!;
    const payload = formatRequestForAuthorizationSignature({
      version: 1, method: "POST", url: `https://api.privy.io/v1/wallets/${this.walletId}/rpc`,
      body: { method: "signTransaction", chain_type: "solana", params: { transaction, encoding: "base64" } },
      headers: { "privy-app-id": g.appId, "privy-request-expiry": String(Date.now() + 5 * 60_000) },
    });
    askGuard(g, payload).then(
      (r) => r.ok
        ? console.log("[guard-shadow] allow")
        : console.warn(`[guard-shadow] REFUSED: ${r.reasons.join("; ")}`),
      (e: unknown) => console.warn(`[guard-shadow] unreachable: ${(e as Error).message}`),
    );
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    const versioned = tx instanceof VersionedTransaction;
    const serialized = versioned
      ? Buffer.from((tx as VersionedTransaction).serialize())
      : (tx as Transaction).serialize({ requireAllSignatures: false, verifySignatures: false });

    const transaction = serialized.toString("base64");
    const g = this.guard;
    if (g?.mode === "shadow") this.shadowCheck(transaction);
    const { signed_transaction } = await this.privy.wallets().solana().signTransaction(this.walletId, {
      transaction,
      authorization_context: g?.mode === "enforce"
        ? {
            authorization_private_keys: [this.authKey],
            sign_fns: [async (payload: Uint8Array) => {
              const r = await askGuard(g, payload);
              if (!r.ok || !r.signature) throw new Error(`signing guard refused: ${r.reasons.join("; ")}`);
              return r.signature;
            }],
          }
        : { authorization_private_keys: [this.authKey] },
    });

    const signedBytes = Buffer.from(signed_transaction, "base64");
    return (versioned
      ? VersionedTransaction.deserialize(signedBytes)
      : Transaction.from(signedBytes)) as T;
  }
}

/** Env inputs needed to build a WalletSigner — see config.ts's Env. */
export interface SignerEnv {
  walletPrivateKey: string | undefined;
  walletKeypairPath: string | undefined;
  privyAppId: string | undefined;
  privyAppSecret: string | undefined;
  privyWalletId: string | undefined;
  privyWalletAddress: string | undefined;
  privyBotAuthKey: string | undefined;
  guardUrl?: string | undefined;
  guardToken?: string | undefined;
  guardMode?: string | undefined;
}

/**
 * PRIVY_WALLET_ID set → Privy signer (production: no local secret key).
 * Otherwise → legacy KeypairSigner from WALLET_PRIVATE_KEY/WALLET_KEYPAIR_PATH.
 * Live mode must refuse to start with neither configured — callers check that
 * (this throws either way: loadKeypair already throws when both are unset).
 */
export function loadSigner(env: SignerEnv): WalletSigner {
  if (env.privyWalletId) {
    if (!env.privyWalletAddress) {
      throw new Error("PRIVY_WALLET_ID is set but PRIVY_WALLET_ADDRESS is missing");
    }
    if (!env.privyAppId || !env.privyAppSecret) {
      throw new Error("PRIVY_WALLET_ID is set but PRIVY_APP_ID/PRIVY_APP_SECRET is missing");
    }
    if (!env.privyBotAuthKey) {
      throw new Error("PRIVY_WALLET_ID is set but PRIVY_BOT_AUTH_KEY is missing");
    }
    const privy = new PrivyClient({ appId: env.privyAppId, appSecret: env.privyAppSecret });
    let guard: GuardOptions | undefined;
    if (env.guardUrl && env.guardToken) {
      const mode = env.guardMode === "enforce" ? "enforce" : "shadow";
      guard = { url: env.guardUrl, token: env.guardToken, mode, appId: env.privyAppId };
    }
    return new PrivySigner(privy, env.privyWalletId, new PublicKey(env.privyWalletAddress), env.privyBotAuthKey, guard);
  }
  return new KeypairSigner(loadKeypair(env.walletPrivateKey, env.walletKeypairPath));
}
