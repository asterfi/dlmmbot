/**
 * Sends ONE Telegram image card per card kind using realistic sample data, so
 * the owner can eyeball the whole redesign in one go. Read-only with respect
 * to the bot's own state — no DB writes, no trading, no live config changes.
 *
 * Every card gets a "TEST" status pill (forced, regardless of live/paper
 * mode) and the caption is prefixed "[TEST]" so it can never be mistaken for
 * a real alert in chat history.
 *
 * Run as user dlmmbot with the bot's env (TELEGRAM_* + the DNS workaround):
 *   systemd-run --uid=dlmmbot --gid=dlmmbot \
 *     --property=EnvironmentFile=/etc/dlmmbot/bot.env \
 *     --setenv=NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection" \
 *     --setenv=HOME=/var/lib/dlmmbot \
 *     --wait --pipe --working-directory=/opt/dlmmbot-live \
 *     node_modules/.bin/tsx scripts/alerts-demo.ts
 */
import { buildCardNode, type CardSpec } from "../src/alerts/layout.js";
import { renderCardWithTimeout } from "../src/alerts/render.js";
import { sendPhotoAwait } from "../src/alerts/telegramPhoto.js";
import {
  buildOpenedCard, buildClosedCard, buildFeesClaimedCard, buildProfitLockCard,
  buildAccountCard, buildJevDecisionCard, buildApeOpenedCard, buildApeClosedCard,
  buildSkipSummaryCard, buildReconcileCard, buildErrorCard, buildWarningCard,
  buildStartupCard, buildTruthPnlCard, buildFallbackCard, type BuiltCard,
} from "../src/alerts/cards.js";

/** Force every demo card to a TEST pill and prefix the caption, regardless of mode. */
function asTest(built: BuiltCard): BuiltCard {
  const spec: CardSpec = { ...built.spec, statusPill: "TEST" };
  return { spec, caption: `[TEST] ${built.caption}`.slice(0, 200) };
}

function samples(): Array<{ name: string; built: BuiltCard }> {
  return [
    { name: "opened", built: buildOpenedCard({
      symbol: "WIF", posId: 4821, sizeSol: 0.42, entryPrice: 0.0003841,
      score: 78, depthPct: 32, play: "molu ladder",
    }) },
    { name: "closed", built: buildClosedCard({
      symbol: "WIF", posId: 4821, pnlSol: 0.0612, pnlPct: 14.6,
      entrySol: 0.420, exitSol: 0.481, feesSol: 0.0038, holdTime: "2h14m",
      reason: "profit target", play: "molu ladder",
    }) },
    { name: "fees_claimed", built: buildFeesClaimedCard({
      symbol: "BONK", posId: 4790, claimedSol: 0.0091,
    }) },
    { name: "profit_lock", built: buildProfitLockCard({
      symbol: "POPCAT", posId: 4802, gainPct: 65, withdrawnSol: 0.112,
    }) },
    { name: "account", built: buildAccountCard({
      acctSol: 0.834, acctPct: 8.34, walletSol: 6.21, inPositionsSol: 1.90,
      baselineSol: 10.0, closedCount: 57, realizedSol: 1.112,
    }) },
    { name: "jev_decision", built: buildJevDecisionCard({
      symbol: "MEW", verdict: "yes", redFlagMax: 0.18, composite: 0.74,
      play: "danko trap",
      keyAnswers: [
        { q: "organic flow", a: "yes" },
        { q: "red flag", a: "none" },
        { q: "fee gen", a: "strong" },
      ],
    }) },
    { name: "ape_opened", built: buildApeOpenedCard({
      symbol: "PNUT", posId: 4830, sizeSol: 0.90, multiple: 3.0, play: "Eys ape",
    }) },
    { name: "ape_closed", built: buildApeClosedCard({
      symbol: "PNUT", posId: 4830, pnlSol: -0.081, pnlPct: -9.0, multiple: 3.0,
    }) },
    { name: "skip_summary", built: buildSkipSummaryCard({
      windowLabel: "last 6h", skipped: 212,
      topReasons: [
        { reason: "score_below_gate", count: 94 },
        { reason: "tvl_too_low", count: 51 },
        { reason: "young_token_risk_cut", count: 33 },
        { reason: "pool_share_cap", count: 20 },
      ],
    }) },
    { name: "reconcile_orphan", built: buildReconcileCard({
      orphaned: ["WIF pos#4711"], adopted: ["7xKX...pool"],
    }) },
    { name: "error", built: buildErrorCard(
      "swap failed", "Jupiter /swap returned 422 after 3 retries — pos#4821 close aborted, retrying next tick",
    ) },
    { name: "warning", built: buildWarningCard(
      "RPC degraded", "3 consecutive timeouts on primary RPC — failing over to backup endpoint",
    ) },
    { name: "startup", built: buildStartupCard("live", "0 open positions — reconcile clean") },
    { name: "truth_pnl_daily", built: buildTruthPnlCard({
      equitySol: 10.834, netDepositsSol: 10.0, pnlSol: 0.834, pnlPct: 8.34,
      unexplainedOutflowSol: 0,
      history: [9.8, 9.95, 10.1, 9.9, 10.3, 10.5, 10.4, 10.6, 10.7, 10.834],
    }) },
    { name: "truth_pnl_daily_outflow_flag", built: buildTruthPnlCard({
      equitySol: 9.2, netDepositsSol: 10.0, pnlSol: -0.8, pnlPct: -8.0,
      unexplainedOutflowSol: 0.35,
      history: [10.0, 9.9, 9.6, 9.5, 9.3, 9.2],
    }) },
    { name: "fallback", built: buildFallbackCard(
      "info", "some future alert text this parser has never seen before\nextra detail line",
    ) },
  ];
}

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in environment — aborting demo");
    process.exit(1);
  }

  const items = samples();
  let ok = 0;
  let failed = 0;
  for (const { name, built } of items) {
    const test = asTest(built);
    try {
      const node = buildCardNode(test.spec);
      const png = await renderCardWithTimeout(node, 5000);
      if (!png) throw new Error("render timed out or failed");
      await sendPhotoAwait(token, chatId, png, test.caption);
      console.log(`[demo] OK   ${name} (${(png.length / 1024).toFixed(1)} KB)`);
      ok++;
    } catch (e) {
      console.error(`[demo] FAIL ${name}:`, (e as Error).message);
      failed++;
    }
  }
  console.log(`[demo] done: ${ok}/${items.length} sent OK, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("[demo] fatal:", e);
  process.exit(1);
});
