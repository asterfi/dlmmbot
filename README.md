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

The tracked default remains the core DLMbot strategy. Hosted strategies are opt-in
through both `strategy.mode` and the strategy-specific enable flag. The Eys plugin owns exact-pool identity, fresh GMGN mint-level one-minute flow
evidence associated with that pool, persistence, stage/range intent, and flow-decay
exit recommendations. DLMbot core remains authoritative for vetting,
score/alpha admission, sizing, reserves, rent, execution, management,
reconciliation, and accounting. Token-side Eys proposals are recorded but fail
closed until a core-owned funding/accounting service is available.

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
