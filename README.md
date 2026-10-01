<p align="center">
  <img src="docs/assets/readme-banner.png" alt="DLMM Bot — BidAsk liquidity bins" width="100%" />
</p>

<p align="center">
  <a href="https://dlmmbot.com"><img src="https://img.shields.io/badge/website-dlmmbot.com-00FF85?style=flat-square&labelColor=141414" alt="Website" /></a>
  <a href="https://dlmmbot.com/setup/"><img src="https://img.shields.io/badge/docs-setup-1E90FF?style=flat-square&labelColor=141414" alt="Docs" /></a>
  <a href="https://dlmmbot.com/setup/easy"><img src="https://img.shields.io/badge/deploy-Railway-F4F4F5?style=flat-square&labelColor=141414" alt="Deploy on Railway" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Shield-B56BFF?style=flat-square&labelColor=141414" alt="PolyForm Shield License" /></a>
</p>

# DLMM Bot

Automated [Meteora DLMM](https://meteora.ag) liquidity bot for Solana. Scans, vets, opens one-sided SOL below price, exits by rules. **Paper first.**

**Everything you need is on the site — not in this README.**

| | |
|---|---|
| Website | [dlmmbot.com](https://dlmmbot.com) |
| Docs | [dlmmbot.com/setup](https://dlmmbot.com/setup/) |
| Easy setup | [Railway](https://dlmmbot.com/setup/easy) |
| For AI agents | [Install playbook](https://dlmmbot.com/setup/agents) · [llms.txt](https://dlmmbot.com/llms.txt) |
| Advanced | [local / VPS / PM2](https://dlmmbot.com/setup/advanced) |
| Fees | [GNME 1% on live wins](https://dlmmbot.com/setup/fees) |

## About this fork

This fork tracks [CryptoGnome/dlmmbot](https://github.com/CryptoGnome/dlmmbot) `develop` and adds a hardened deployment, non-custodial signing, an independent P&L check and a combo strategy. Only two branches are maintained:

- **`develop`**: upstream `develop` + the changes below
- **`main`**: the commit currently deployed

### What changed vs upstream

| Area | Change | Where |
|---|---|---|
| **Signing** | The bot no longer needs a raw private key. A `WalletSigner` interface supports the classic in-process `Keypair` *or* a **Privy server wallet**: the Solana key stays in Privy and the bot signs through an authorization key that a Privy **policy** restricts. Every send path (`send()`, Jupiter swaps, profit burns) goes through the signer; extra signers (position keypairs) are re-applied per retry. | `src/executor/wallet.ts`, `src/executor/live.ts`, `src/executor/jupiter.ts` |
| **Policy** | Example policy: allow only Compute Budget, Meteora DLMM, Jupiter v6, Associated Token and Memo programs; System transfers only to your cold wallet or the wallet's own wSOL account; token `CloseAccount` only back to the wallet. A plain "send everything to another address" (the classic key-leak drain) is rejected by Privy. | `deploy/hardened/privy/setup.mjs` |
| **Emergency exit** | Owner-key script, run on your own machine: closes all DLMM positions, swaps leftovers to SOL, closes token accounts and sends everything to your cold wallet. Dry run by default. | `deploy/hardened/privy/emergency-withdraw.mjs` |
| **Truth P&L** | Equity is measured on-chain (wallet SOL + wSOL + open positions + tokens) against net external deposits. It doesn't use the bot's own ledger, and it flags any unexplained outflow. Daily Telegram report. | `scripts/truth-pnl.ts` |
| **Combo strategy** | Four plays, each recorded on the position (`positions.play`): **molu ladder** (fresh coins, dip + bounce, SOL-side bid-ask below price), **Danko trap** (proven coins, deep −85/−90% SOL-side ladder, max 1), **Eys seat** (fresh pumps with heavy real fees, quick SOL-side seat, skipped when costs exceed the expected win), **Eys ape** (Stonks Launchpad coins, token-sided fixed ticket). Sizing per the playbooks: 30% of equity active, 70% never deployed; canary mode for tiny accounts (1 slot). While combo is enabled, no other entry lane can open positions. | `src/strategy/combo/`, `src/scanner/stonkfun.ts`, `[combo]` in `config.toml` |
| **Jev master gate** | Every combo entry and exit is put to [TypeSafe Jev](https://docs.typesafe.ai) (pinned `jev-1.13.0`) as one request of atomic noul/choice questions over a structured state. Red flags veto in code; positive signals are combined per play; an uncertain answer skips entries and defers exits to the rules; transport failures fall back to the rules. Every consult's raw answers are stored in `jev_decisions` for later calibration against realized P&L. | `src/strategy/jev/`, `[jev]` in `config.toml` |
| **Risk knobs** | Per-position stop-loss and the daily-loss circuit breaker are **disabled** (`stop_loss_frac = 0`, `circuit_daily_loss_pct = 0`): risk is controlled by play sizing. Upstream's rug-safety exits (P0) remain active. Re-enable them if you prefer upstream behavior. | `config.toml` |
| **Hardened deploy** | The bot runs as a dedicated non-login user under sandboxed systemd units. Code is read-only to the bot, secrets live in a root-owned env file outside the repo, the dashboard binds to loopback and is exposed only through Caddy (HTTPS + basic auth, read-only from the internet, token redacted from logs). | `deploy/hardened/` |

### Hardened deployment (summary)

1. Create a system user and directories: code in `/opt/dlmmbot-live` (`root:dlmmbot`, 0750/0640), data in `/var/lib/dlmmbot`, secrets in `/etc/dlmmbot/bot.env` (`root:dlmmbot`, 0640). See `deploy/hardened/bot.env.example`.
2. Install dependencies with `npm ci --ignore-scripts`, then rebuild only the known native modules.
3. On **your own machine**, run `deploy/hardened/privy/setup.mjs` to create the Privy wallet, owner key, restricted bot signer and policy. It runs sign-only tests proving the policy rejects drains. Keep the owner key off the server (password manager).
4. Install the systemd units from `deploy/hardened/*.service|*.timer` and start in **paper** mode. Live mode needs both `FARMER_MODE=live` and `[exec].mode = "live"`.
5. Optional: expose the dashboard with `deploy/hardened/Caddyfile.example`.
6. Never give an AI agent, CI job or any other user account read access to the bot's secrets or root on the host. That is how the original key of this deployment was lost.

> ⚠️ **Not financial advice.** LP on new tokens can lose 100%. The combo plays copy published playbooks; they do not guarantee those authors' results. Judge performance only by `scripts/truth-pnl.ts`.

---

## License

[PolyForm Shield 1.0.0](LICENSE) — run it, read it, modify it for your own operation. You **cannot** ship a competing bot or hosted copy.

## Disclaimer / waiver

Memecoin LP can wipe a wallet. Not financial advice. Burner only. You can lose 100%.  
By using this software you agree to the [Terms of Service & Risk Waiver](TERMS.md). The setup wizard requires acceptance. We are not liable for losses, bugs, or third-party failures — free software, as-is.
