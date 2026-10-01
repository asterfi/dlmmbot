/**
 * Plain-English playbook handed to Jev as `state.playbook` (docs.typesafe.ai:
 * state should include the rules the model is judging against, not just raw
 * numbers). Kept short and in English per the docs' token-budget guidance.
 */
export const COMBO_PLAYBOOK =
  "molu_ladder (core): token age < 48h, mcap >= $1,000,000. Enter only AFTER a real dip " +
  "(>=20% off the local high) then a bounce (>=5% off the low) -- never on the initial " +
  "vertical. One-sided SOL bid-ask below price. Exit at +15% position value bounce " +
  "(+5% for top-tier position sizes), or when flow/volume dies.\n" +
  "danko_trap (deep): mcap >= $1,000,000 AND token age >= 48h (both required, a proven " +
  "floor). One-sided SOL bid-ask from current price down to -85%/-90%, bottom-weighted. " +
  "Max 1 concurrent. Exit at break-even-or-better after a bounce, or +15-20% if it runs.\n" +
  "eys_seat (fast): mcap >= $100,000, >=10 SOL lifetime fees earned in the pool, high " +
  "volume rate (>=100k USD/min). Spot, SOL-side only, narrow range, no token-sided leg. " +
  "Exit at +1-3% green (default 2%) or flow death.\n" +
  "eys_ape (riskiest): a Stonks Launchpad graduate paying SOL-only fees. Token-sided: a " +
  "small fixed SOL ticket is swapped into the token and deposited as liquidity ABOVE the " +
  "current price, selling into the pump for SOL fees. Max 1 concurrent. Can go to zero -- " +
  "no stop-loss. Exit on flow death or once price has run through the top of the range " +
  "(fully converted back to SOL).\n" +
  "none: no coherent play fits this candidate under any of the above -- not every pump is a trade.";
