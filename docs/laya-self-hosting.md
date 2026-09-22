# Local Laya sidecar

This worktree contains a localhost-only Laya inference sidecar for the hosted Eys strategy.
It is an advisory/model boundary, not a trading engine.

## Boundary

```text
DLMbot discovery
  -> normalized candidate + complete evidence
  -> deterministic pool/token/quote/risk/rent checks
  -> Laya request (shadow or explicit gate)
  -> DLMbot executor
```

The sidecar receives no wallet key, RPC credential, API key, signer, or executor handle. It cannot discover pools, change the requested size, waive a hard gate, sign/broadcast, manage positions, or replace deterministic exits.

The request contains a bounded normalized snapshot:

- discovery counts and rejection summary;
- exact candidate/pool identity and score components;
- exact pool identity plus fresh GMGN mint-level one-minute flow, age, and Eys stage evidence;
- token/pool vetting facts and hard-gate result;
- executable size, bankroll, and range context;
- the two typed questions: trade approval and Eys stage.

Raw provider payloads are not forwarded.

## Runtime

The runtime is installed separately from Node under `/home/hermes/.cache/laya-venv` and loads one CPU checkpoint at startup. The example user service is `deploy/laya.service.example`; it binds to `127.0.0.1:18150`, serializes inference, and applies memory/CPU limits.

The service is intentionally not enabled by this repository. A deployment operator must copy the sidecar and unit into the intended user-service paths, start it explicitly, and verify:

```text
GET http://127.0.0.1:18150/healthz
GET http://127.0.0.1:18150/readyz
```

The first model start may download the public Hugging Face checkpoint and can take minutes. Subsequent requests use the preloaded model.

## Modes

`config.toml` keeps:

```toml
[laya]
mode = "off"
```

- `off`: no request; core behavior is unchanged.
- `shadow`: request Laya and persist its output, but never block a core-approved entry.
- `gate`: fail closed when Laya is unavailable, malformed, below the configured probability, or rejects the setup.

Gate mode must not be enabled merely because the process responds. The public typed-decisions checkpoint is not Eys-trained. Collect shadow observations, label outcomes, calibrate/fine-tune externally, evaluate a holdout set, and obtain an explicit live-canary approval before changing the mode. Hard safety and execution gates remain in every mode.
