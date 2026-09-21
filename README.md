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

## Hosted strategy plugins

The Eys plugin owns exact-pool identity, broad pre-filter intake, fresh GMGN mint-level one-minute flow evidence associated with that pool, persistence, stage/range intent, and flow-decay exit recommendations. DLMbot core remains authoritative for exact-pool verification, token vetting, sizing, reserves, rent, fresh quote/range checks, execution, management, reconciliation, and accounting. When explicitly active, Eys replaces the core economic discovery filters and alpha-score reservation. Its intake also avoids the core TVL ceiling, new-token bin-step fit, and listing-level freeze flag; freeze is rechecked from fresh on-chain mint facts, while bin-step/depth/rent remains a later executable check. Core mode is unchanged. Token-side Eys proposals are recorded but fail closed until a core-owned funding/accounting service is available.

The scanner also has an opt-in, bounded Meteora DLMM event-intake path. It polls the
configured Solana RPC (Helius recommended), decodes published pool-initialization
instructions, persists signatures, resolves the exact pool through Datapi, and can
fetch direct GMGN `token info` for the event mint so Eys can see a fresh 1m row even
when the mint is outside the capped trending snapshot. It supplements the normal
sweep and, when Eys is active, joins the broad Eys intake; it never bypasses shared
vetting, quote, sizing, rent, or executor gates. `[discovery].event_intake_enabled = false` is the tracked default.

### Optional local Laya gate

The Eys plugin can send a bounded normalized snapshot to a localhost Laya
sidecar. `laya.mode = "off"` is the tracked default. `shadow` records model
outputs without changing admission; `gate` is an explicit fail-closed veto
after core vetting, quote, sizing, range, reserve, and rent checks. Laya never
receives secrets and never signs, broadcasts, sizes, manages, or exits a
position. See [`docs/laya-self-hosting.md`](docs/laya-self-hosting.md).

## License

[PolyForm Shield 1.0.0](LICENSE) — run it, read it, modify it for your own operation. You **cannot** ship a competing bot or hosted copy.

## Disclaimer / waiver

Memecoin LP can wipe a wallet. Not financial advice. Burner only. You can lose 100%.  
By using this software you agree to the [Terms of Service & Risk Waiver](TERMS.md). The setup wizard requires acceptance. We are not liable for losses, bugs, or third-party failures — free software, as-is.
