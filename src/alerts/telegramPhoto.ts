// sendPhoto multipart upload + a serialized, rate-limited (<=1/s) send queue,
// kept separate from the plain-text send chain in alerts.ts. Node 22's global
// fetch/FormData/Blob cover multipart without adding a dependency.
const MIN_INTERVAL_MS = 1000;
let chain: Promise<void> = Promise.resolve();

async function sendPhoto(token: string, chatId: string, png: Buffer, caption: string): Promise<void> {
  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) form.append("caption", caption.slice(0, 1024));
  form.append("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "card.png");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`telegram sendPhoto HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}

/** Fire-and-forget, serialized >= MIN_INTERVAL_MS apart. Never throws. */
export function queuePhoto(token: string, chatId: string, png: Buffer, caption: string): void {
  chain = chain
    .then(() => new Promise<void>((r) => setTimeout(r, MIN_INTERVAL_MS)))
    .then(() => sendPhoto(token, chatId, png, caption))
    .catch((e) => console.error("[alert-card] telegram sendPhoto failed:", (e as Error).message));
}

/** Awaited variant for scripts (e.g. the demo) that need real pass/fail per send. */
export async function sendPhotoAwait(token: string, chatId: string, png: Buffer, caption: string): Promise<void> {
  chain = chain.then(() => new Promise<void>((r) => setTimeout(r, MIN_INTERVAL_MS)));
  await chain;
  await sendPhoto(token, chatId, png, caption);
}
