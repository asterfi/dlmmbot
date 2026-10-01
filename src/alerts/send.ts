// Orchestrator wired into src/alerts.ts: build a card from an existing
// alert(kind, message) call, render it, and send it as a photo — all
// fire-and-forget with a hard timeout, falling back to the plain-text send
// on ANY failure. This function must NEVER throw and must NEVER block the
// caller; it is invoked without awaiting from alert().
import { parseAlertToCard } from "./cards.js";
import { renderCardWithTimeout } from "./render.js";
import { buildCardNode } from "./layout.js";
import { queuePhoto } from "./telegramPhoto.js";
import { config } from "../config.js";

const RENDER_TIMEOUT_MS = 3000;

export function cardsEnabled(): boolean {
  try {
    return config().alerts?.cards ?? true;
  } catch {
    return true;
  }
}

/**
 * Attempt the card path for one alert; on any failure, call the supplied
 * fallback (the existing plain-text sendTelegram) instead. Fire-and-forget —
 * callers do not await this.
 */
export async function trySendAlertCard(
  kind: string,
  message: string,
  send: (token: string, chatId: string, line: string) => Promise<void>,
  token: string,
  chatId: string,
  plainLine: string,
): Promise<void> {
  try {
    const built = parseAlertToCard(kind, message);
    const node = buildCardNode(built.spec);
    const png = await renderCardWithTimeout(node, RENDER_TIMEOUT_MS);
    if (!png) {
      await send(token, chatId, plainLine);
      return;
    }
    queuePhoto(token, chatId, png, built.caption);
  } catch (e) {
    console.error("[alert-card] render/send failed, falling back to text:", (e as Error).message);
    try {
      await send(token, chatId, plainLine);
    } catch (e2) {
      console.error("[alert] text fallback also failed:", (e2 as Error).message);
    }
  }
}
