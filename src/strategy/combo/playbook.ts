/**
 * Plain-English playbook handed to Jev as `state.playbook` (docs.typesafe.ai:
 * state should include the rules the model is judging against, not just raw
 * numbers). Kept short and in English per the docs' token-budget guidance.
 * Eys-only combo (owner, 2026-10-03), from Eys's two articles.
 */
export const COMBO_PLAYBOOK =
  "Eys token selection: watch GMGN Trending for 100k+ mcap, at least 10 SOL in fees, " +
  "100K+ volume per minute (a softer dynamic tier is allowed when volume is accelerating " +
  "and ranks near the top of today's trending tokens, with a stricter bar), no dev fees, a " +
  "good lore, and strong upward spikes that keep an upward trend. Never force a trade. " +
  "Fake-volume red flag: a 500K-1M mcap with only 8-10 SOL in fees.\n" +
  "eys_seat: the FIRST entry on a qualifying token. Spot, SOL-side, the default range (safest). " +
  "Exit when green (+1-3%, default 2%) or when flow dies. Never a stop-loss.\n" +
  "eys_breakout: a token-sided SECOND position on a token whose seat is open, only when price " +
  "breaks above the top of the seat's range, volume is 3x the seat's threshold (100K -> 300K/min) " +
  "and there is a strong spike. The seat stays open as the backup that catches a dump. Exit when " +
  "the range has fully converted back to SOL, when green, or when flow dies.\n" +
  "eys_tight: Spot SOL-side tight range (10-20 bins) when volume clears the seat threshold, the " +
  "token has been watched 1-2 minutes with no major dump, and the chart is still moving steadily " +
  "in a small pump-and-dump range. Exit when green or when flow dies.\n" +
  "eys_ape: a Stonks-style launchpad graduate whose pool collects SOL-only (quote) fees, so the " +
  "fees stay in SOL even if the token is rugged. Token-sided, a small fixed 0.1 SOL ticket, risk " +
  "money. Exit when the range has fully converted back to SOL or flow dies.\n" +
  "eys_dump_bonus: once an Eys token's per-minute volume has peaked and is slowing while price is " +
  "still near its all-time high, a wide Bid-Ask SOL-side range from -85% to -90% as a bonus play. " +
  "Exit when green on a real fill; flow dying is its premise, not an exit.\n" +
  "none: no coherent play fits this candidate under any of the above -- not every pump is a trade.";
