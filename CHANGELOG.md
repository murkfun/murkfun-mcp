# Changelog

Releases are GitHub Releases of this repository (tag `v<version>`): `murkfun-mcp-<version>.tgz`, the same file as
`murkfun-mcp.tgz` (the stable URL below) and `SHA256SUMS`. Install or update the latest release with

```bash
npm install -g https://github.com/murkfun/murkfun-mcp/releases/latest/download/murkfun-mcp.tgz
```

## 1.0.0

First release of the MurkFun MCP server and CLI for BNB Smart Chain mainnet. Targets the MurkFun contracts v1.1
(`networks/bsc.json`).

- Every order (buy, sell, fund, withdraw, launch with the creator buy, dev fee claims) is signed by your wallet for
  that exact order and proven locally (Noir, Barretenberg `bb` 6.0.0); the relayer submits it, your wallet never sends
  a MurkFun transaction.
- Wallets: a local key, or the Binance Agentic Wallet through its CLI (`MURKFUN_SIGNER=baw`).
- Funding from 0xbow Privacy Pools (default) or Railgun.
- Encrypted local vault, backups and recovery from the wallet (`export_recovery`, `recover_from_wallet`).
- `murkfun-mcp init` sets up `~/.murkfun` (passphrase file, circuits, the order prover) and prints the MCP client config.
- Every MCP tool also runs as a shell command (`murkfun-mcp <tool> --arg value`).
- Safety: a deployment, relayer or verifier hash other than the bundled ones is reported (stderr, `status`); the order
  verifier check stays on with a custom deployment. Withdrawals and fee recipients only to `MURKFUN_WITHDRAW_ALLOWLIST`
  (unset: the user's own wallet, with a privacy warning). `export_recovery` writes only inside `MURKFUN_HOME` or
  `MURKFUN_EXPORT_DIR`; `backup` never replaces a file unasked. A signed order's validity is bounded by
  `MURKFUN_MAX_ORDER_VALIDITY_S`.
