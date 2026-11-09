# murkfun-mcp

The MurkFun MCP server: a local stdio MCP server that lets **your own AI agent** trade on [MurkFun](https://murk.fun), a meme launchpad on BNB Chain. During the bonding curve, while the factory's privacy-funding rule is on (`status.privacyFunding`), buys are paid from a privacy pool: Railgun through MurkFun's Railgun adapter (the default: shield BNB into a Railgun wallet, wait out Railgun's Proof of Innocence standby of about 1 h, then `buy` returns the Railgun transaction to build and `submit_railgun` has the MurkFun relayer send it; your wallet only signs and needs no BNB), or 0xbow Privacy Pools (`source: "note"`: a deposit from your wallet that 0xbow's ASP must approve first, which can take hours or much longer); while the rule is off (as on production since 2026-11-09, pending the timelock) and after graduation a plain wallet can also fund a position (`fund_pseudonym`, `buy source=balance`; its address is public). Every holding sits under a separate pseudonym per token inside the MurkFun contracts. Version 1.0.1 targets the MurkFun contracts v1.1 on BSC mainnet.

> **Notice (Nov 8, 2026):** 0xbow's ASP on BNB Chain is currently not approving new deposits. Use Railgun. BNB already deposited into 0xbow is safe and can be taken back to your wallet any time with 0xbow's ragequit.

> Anonymity is a feature, not a guarantee. Your wallet is your backup: guard it.

Every MurkFun action is an order your wallet signs (one signature per order; the signer sees only an opaque hash). The server proves locally, with the bundled order circuit and Barretenberg `bb`, that the signer holds a SPACE ID Agent ID in MurkFun's holder set without saying which one, and sends the signed, proved order to a MurkFun relayer a random 30 s to 3 min later; the relayer cannot alter it. The wallet never sends a MurkFun transaction and there is no registration. How an order is authorised: the [API page](https://murk.fun/docs/api) on murk.fun; who sees what: [murk.fun/docs/privacy](https://murk.fun/docs/privacy).

The server keeps your secrets in an encrypted file (`~/.murkfun/vault.json`, scrypt + AES-256-GCM, mode 0600): the wallet's signature of the fixed MurkFun seed message ("MurkFun seed: only sign this on MurkFun"; the secret behind every pseudonym, and through HKDF the 0xbow keys and note secrets), plus the wallet key (unless the wallet is the Binance Agentic Wallet, which has no key here). Signing the same message again with the same wallet recovers everything (`recover_from_wallet`). The seed signature is handled like a private key. No tool output contains a secret.

Privacy, in plain words: shield or deposit round amounts (0.5 / 1 / 5 BNB) so you blend in, wait a while after it before buying, and don't buy exactly the amount you shielded or deposited. The proofs do not link your pseudonyms to each other or to your wallet, but other things can: MurkFun's relayer sees your IP address on every order, and by default the server asks MurkFun's holder-set API for your wallet's path from the same IP, so MurkFun can link your wallet and pseudonyms by IP unless you set `MURKFUN_HOLDERS_API=` (empty) and use Tor or a VPN; your RPC sees your wallet's and your pseudonyms' reads together (use your own); the wallet's operator (Binance, for the Agentic Wallet) can compute every pseudonym; timing and amounts can be correlated. Never sign MurkFun typed data (the seed message, an order) anywhere but in murkfun-mcp: a site asking for it is phishing, and the seed signature can spend your 0xbow notes. A 0xbow buy spends one note (any amount it holds, one proof); merging or splitting notes is a 0xbow transaction this server does not make (0xbow's own app can).

- Agent usage, tools, waits and failure handling: the skill file for agents, [skills/murkfun/SKILL.md](skills/murkfun/SKILL.md) (also at https://murk.fun/skill.md)
- Backups and recovery on a new machine: [Recovery on a new machine](skills/murkfun/SKILL.md#recovery-on-a-new-machine) in the skill file
- The guide for people: https://murk.fun/docs; the read and relayer APIs: https://murk.fun/docs/api

## Who can trade: SPACE ID Agent ID holders, from the Binance Agentic Wallet

MurkFun accepts orders only from wallets that hold a **SPACE ID Agent ID** (ERC-721 "SPACE ID Agent ID" on BSC, `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`; soulbound, one per wallet), read from `MurkFunHolderRoots.AGENT_NFT()`. MurkFun cannot mint it: claim it in the **Binance Agentic Wallet** (Binance App → Wallet → AI agent / Agent ID). `setup` checks it (`agentNft: false` otherwise, nothing signed). Holders join MurkFun's holder set without a transaction: its operator adds them in batches, usable 1 h after posting; `status` shows `holderSet`, and orders before that stop with `NOT_A_HOLDER_YET` / `NOT_ACCEPTED_YET`.

The Binance agent wallet has no exportable private key, so the MCP drives it through the Binance Agentic Wallet CLI:

```bash
npm install -g @binance/agentic-wallet && baw auth signin   # scan the QR code with the Binance App
baw wallet agent-id --json                                  # claimed: true
```

Then set `MURKFUN_SIGNER=baw` (and `MURKFUN_BAW_PATH` if `baw` is not on the server's PATH) and run `setup` (or `setup {signer:"baw"}`). Turn on **Developer Mode** in the Binance App (Agentic Wallet management page → Settings → Developer Mode): `sign-message` and `contract-call` need it. What happens:

- **Signatures** (the seed message once, then one `OrderAuth {orderHash}` per order): `baw sign-message preview --binanceChainId 56 --message '<eth_signTypedData_v4 request>' --signType EIP712` → `requestId` → `baw sign-message execute` → `signature` (r‖s) + `signatureRecovery` (00/01 → v 27/28). The seed message is signed twice and refused (`BAW_NONDETERMINISTIC`) if the two differ. The seed signature is never logged or returned; it is stored only encrypted. The agent wallet signs on Binance's side: Binance sees the seed message once and an opaque hash per order (with its time; the MCP sends the order a random 30 s to 3 min later).
- **Transactions** (0xbow only: the keystore registration before the first deposit, the deposit): `baw contract-call preview --from <wallet> --to <contract> --value <wei> --inputData <calldata> [--gasLimit n]` (Binance simulates it and checks risks) → `baw contract-call execute` → `txHash`. The MCP stops before execute when the simulation fails, a risk is flagged, or `requireConfirmation` is true (the Binance App would have to approve): `BAW_CONFIRMATION_REQUIRED`, nothing sent.
- **Backup:** the Binance account. `export_recovery` has nothing to export; `recover_from_wallet {signer:"baw"}` signs again.

## Install

Requires Node ≥ 20. No sudo with a user-level npm prefix (nvm, or `npm config set prefix ~/.local`):

```bash
npm install -g https://github.com/murkfun/murkfun-mcp/releases/latest/download/murkfun-mcp.tgz
murkfun-mcp init
```

The same command updates it to the latest release ([releases](https://github.com/murkfun/murkfun-mcp/releases):
each has the `.tgz` and its `SHA256SUMS`; [CHANGELOG.md](CHANGELOG.md)). From source instead:
`git clone https://github.com/murkfun/murkfun-mcp && cd murkfun-mcp && npm ci && npm run build && npm link`.

`init` creates `~/.murkfun` (mode 0700) and a random vault passphrase file `~/.murkfun/passphrase` (mode 0600) if none
exists (an existing one is never touched; keep a copy of it OFFLINE: encrypted backups are useless without it),
downloads the 0xbow circuits into `~/.murkfun/circuits` and Barretenberg `bb` 6.0.0 (the order prover) into
`~/.murkfun/bin` (skipped when `MURKFUN_BB` names one or a `bb` 6.0.0 is on the PATH; such a `bb` is used as is, not
hash-checked), checks the downloads against their pinned sha256, and prints the client config
(`config claude-code`, then `config json`). It is safe to run again. The printed config starts the installed
`murkfun-mcp` command; `--absolute` (`murkfun-mcp config json --absolute`) prints node and the script by absolute path
instead, for a client started without the shell's PATH (common with nvm). That is also the default when `murkfun-mcp` on
the PATH is not this installation.

An agent that can run shell commands can do all of this itself from the skill file, https://murk.fun/skill.md
(the same file as [skills/murkfun/SKILL.md](skills/murkfun/SKILL.md)).

Contributors install from a checkout of this repository instead: `./install.sh` builds and packs the package, installs
it into `~/.murkfun/npm` (`MURKFUN_PREFIX`) and runs `murkfun-mcp init`.

## Configuration

Everything is set through environment variables in the MCP client config. Secrets never go there; only the passphrase *file* path does.

| Variable | Default | |
|---|---|---|
| `MURKFUN_PASSPHRASE_FILE` / `MURKFUN_PASSPHRASE` | | Vault passphrase, at least 12 characters. Encrypted backups are useless without it. |
| `MURKFUN_HOME` | `~/.murkfun` | Vault and circuits directory. |
| `MURKFUN_NETWORK` | `bsc` | Which bundled `networks/<name>.json` to use. |
| `MURKFUN_RPC` | from the network file (`https://public-bsc.nownodes.io`) | BSC RPC for reads and your wallet's own 0xbow transactions (keystore, deposit). Prefer one that serves `eth_getLogs` over old blocks (see [Holder path](#holder-path-and-rpcs)); `bsc-dataseed.bnbchain.org` does not. |
| `MURKFUN_HOLDERS_API` | from the network file (`https://murk.fun`) | Holder-set API base: where the server gets your wallet's holder Merkle path (`/v1/holders/lookup`). Checked locally and on chain, never trusted. An empty value disables it (the path then comes from the chain's logs only). |
| `MURKFUN_LOG_RPCS` | from the network file | Comma-separated BSC RPCs tried after `MURKFUN_RPC` for `eth_getLogs` scans (the holder path's fallback, 0xbow leaves, recovery). Empty = only `MURKFUN_RPC`. |
| `MURKFUN_RELAYER_URL` | from the network file | Overrides the bundled relayer URL. Required when the network file has a `<...>` placeholder there. |
| `MURKFUN_DEPLOYMENT` | from the network file | Path to, or inline JSON of, `{market, factory, orders, holderRoots, locker, privacyPoolAdapter, railgunAdapter?, deployBlock, holderRootsDeployBlock?}`. Required when the network file has `<...>` placeholders there. Re-pointed contracts are followed on chain (a token's market is `factory.marketOf(token)`, new tokens go to `factory.market()`). A deployment or relayer URL other than the network file's is reported: a warning on stderr at start, in the MCP server's instructions to the agent and in `setup` / `status` (`deployment: "custom"`, `configWarnings`), as are a `MURKFUN_RPC` (other than a local node) or `MURKFUN_HOLDERS_API` other than the bundled one and `MURKFUN_WITHDRAW_ALLOWLIST="*"` (only set them yourself; a pasted config could re-point your funds). The order verifier check stays on. |
| `MURKFUN_VERIFIER_CODE_HASH` | from the network file | keccak256 of the order verifier's code the bundled circuit proves for; an order gate with another verifier is refused before anything is signed. Empty = no check (reported like a custom deployment). |
| `MURKFUN_WITHDRAW_ALLOWLIST` | | Comma-separated addresses withdrawals and fee recipients may go to (`*` = any). Unset: only your own wallet, which links the pseudonym to your wallet in public; add a fresh address here for privacy. Only you set it, never the agent. |
| `MURKFUN_EXPORT_DIR` | | A directory (e.g. a USB stick) `export_recovery` may write the plaintext recovery file to, besides `MURKFUN_HOME`. |
| `MURKFUN_MAX_ORDER_VALIDITY_S` | `600` | The latest deadline a quote may carry, and the longest validity of a signed order (at least 30 min for Railgun-paid orders, whose proof takes a while). |
| `MURKFUN_SIGNER` | `local` | Wallet of a new vault: `local` (key here) or `baw` (the Binance Agentic Wallet through its CLI). |
| `MURKFUN_BAW_PATH` | `baw` | The Binance Agentic Wallet CLI binary. |
| `MURKFUN_BAW_ACCOUNT` | | Optional: which `baw wallet address` BSC address to use (needed only if there are several). |
| `MURKFUN_ORDER_DELAY_MS` | `30000-180000` | Random wait (uniform, `min-max` ms) between the wallet's order signature and the submission, so the submission time differs from the signature time. |
| `MURKFUN_BB` | | A Barretenberg `bb` 6.0.0 binary. Default: `bb` 6.0.0 on the PATH (used as is: it sees the order witness, so only install a `bb` you trust), else the pinned download in `~/.murkfun/bin`. |
| `MURKFUN_BB_DOWNLOAD` | `1` | `0`: never download `bb` (then `MURKFUN_BB` or a `bb` on the PATH is required). |
| `MURKFUN_MAX_DEPOSIT_INDEX` | `64` | Recovery: deposit indices tried per 0xbow `Deposited` event. |
| `MURKFUN_ORDER_WAIT_MS` | `120000` | How long a tool waits for its relayer order to be mined. |
| `MURKFUN_ORDER_RETRIES` | `3` | Resubmissions of the identical order after `broadcast_failed` / `overloaded` / `relayer_unreachable` (nothing was sent) or status `dropped` (not executed). An order never executes twice (its nullifier). |
| `MURKFUN_ORDER_RETRY_BACKOFF_MS` | `2000` | First wait before a resubmission; doubled each time, at most 30 s. |
| `MURKFUN_INDEXER_URL` | from the network file | MurkFun indexer API (`…/v1`). `list_launches` and the `market` block of `token_info` use it, falling back to the chain if it is down, lagging or serving another deployment. Your own balances are always read on chain. An empty value disables it. |

### Network values

`networks/bsc.json` holds the BSC mainnet values: the contract addresses and deploy blocks, the relayer, indexer and
holder-set API URLs, the RPCs and the code hash of the deployed order verifier (the MCP refuses an order gate with
another verifier before anything is signed). `murkfun-mcp network` prints them. Every value can be overridden through
the environment (`MURKFUN_DEPLOYMENT`, `MURKFUN_RELAYER_URL`, `MURKFUN_INDEXER_URL`, `MURKFUN_RPC`,
`MURKFUN_HOLDERS_API`, `MURKFUN_LOG_RPCS`). A network file with a `<...>` placeholder in a required value (a network
you add yourself, say) makes the server refuse to start until the environment sets it; `murkfun-mcp config` then
prints those variables for you to fill in, and `murkfun-mcp network` lists the placeholders.

For maintainers: `scripts/set-network.mjs` writes the file from a MurkFun deployment (usage in its header) and
`node scripts/set-network.mjs --check` fails on any placeholder left, so a release cannot ship one. `rpc` and `logRpcs`
are edited by hand (re-run the probe below first).

### Holder path and RPCs

Every order proves that your wallet is in the latest accepted root of MurkFun's holder set, so the server needs your
wallet's Merkle path in that tree. It gets it in this order:

1. **The holder-set API** (`MURKFUN_HOLDERS_API`, default `https://murk.fun`): one request,
   `GET /v1/holders/lookup?q=<your wallet>`. The answer is only a hint. The server uses its proof only if the leaf is
   `H(your wallet address)`, the 26 siblings hash up to the proof's root (Poseidon2, the same hashing as the order
   circuit), and that root is the holder set's latest accepted root on chain (`MurkFunHolderRoots.acceptedRoot()`,
   one `eth_call`). An older root that the contract would still accept is refused too, because it would set your
   orders apart. If the API is down or a check fails, the server ignores the answer and goes to step 2.
2. **The chain's `Batch` logs**, read from the holder set's deploy block and checked against the same accepted root.
   This needs an RPC that serves `eth_getLogs` over old blocks, and many free BSC endpoints do not:
   `bsc-dataseed.bnbchain.org` refuses every `eth_getLogs` ("limit exceeded"), and `bsc-rpc.publicnode.com` returns
   `[]` for older ranges without an error. Once per process the server probes `MURKFUN_RPC`, then each of
   `MURKFUN_LOG_RPCS` (default: the network file's `logRpcs`). It reads the holder set's batch 0 `Batch` event from
   the blocks whose timestamp is that batch's on-chain `postedAt`. An endpoint that errors, answers `[]` there or is
   another chain is skipped. The first endpoint that passes is used for every log scan: this fallback, the 0xbow
   leaves after the snapshot, and recovery. If none passes, the error is `NO_LOG_RPC` and names each endpoint
   (scheme and host only) and why it failed. A failed search is retried after a minute.

`status.holderSet.source` says which source the path came from (`api` or `logs`).

`holders_lookup {query}` (read-only, no wallet or vault: a 0x address, an Agent ID name or name.ai) shows any entry
of the holder set the same way: owner and handle, origin, batch, position, accepted, `usableFrom` and the verified path,
with `verified` saying what was checked on chain. The holder set's own toolkit is
https://github.com/murkfun/holder-roots (its `murkfun-holders tree` rebuilds the whole tree and checks every root).

The free endpoints in `networks/bsc.json`, probed with 1-block `eth_getLogs` calls 1k, 100k, 1M and 5M blocks back
(last checked 2026-11-06):

| Endpoint | `eth_getLogs` |
|---|---|
| `https://public-bsc.nownodes.io` (default `rpc`) | full history, 5,000-block windows |
| `https://rpc-bsc.48.club` | recent blocks only ("header not found" ~1.5M blocks back) |
| `https://bsc-dataseed.bnbchain.org` | refused ("limit exceeded") |
| `https://bsc-rpc.publicnode.com` | `[]` for older ranges, no error |
| `https://bsc.drpc.org`, `https://1rpc.io/bnb`, `https://bsc.blockrazor.xyz` | rate-limited, or windows of 50 / 25 blocks |

**Privacy:** the lookup sends your wallet address to the holder-set API (MurkFun's), from your IP.
MurkFun's relayer also sees your IP when your orders arrive, so whoever runs both can link the two by IP. The proof is
the same for every order against one root, so the server asks once per accepted root (at most hourly) per process,
not with every order. If that matters to you, set
`MURKFUN_HOLDERS_API=` (empty) and use an RPC that serves `eth_getLogs`, or reach both through a proxy.

## CLI

```
murkfun-mcp                                   run the stdio MCP server
murkfun-mcp init                              create ~/.murkfun and the passphrase file (kept if present), fetch +
                                           verify the 0xbow circuits and bb, print the client config
murkfun-mcp config [claude-code|json] [--absolute]  print a ready-to-paste MCP client config
murkfun-mcp fetch-circuits                    download + verify the 0xbow circuit artifacts
murkfun-mcp network                           show the bundled network values and placeholders
murkfun-mcp tools                             every tool with its input JSON Schema
murkfun-mcp <tool> [--arg value ...] [--json '{...}']   run one tool from the shell (below)
murkfun-mcp --version
```

Every MCP tool is also a shell command, for agents whose client has no MCP support (OpenClaw, scripts, any client
without MCP support): `murkfun-mcp buy --token 0x… --bnbAmount 0.1`, `murkfun-mcp sell --json '{"token":"0x…","percent":50}'`. It
runs the same function with the same environment variables and vault as the MCP server and prints the same JSON on
stdout; a failed tool prints the MCP's error text on stderr and exits with 1 (2: a bad command line, nothing ran).
Argument names are the schema's (`--bnbAmount` or `--bnb-amount`; `token-info` = `token_info`); numbers, booleans and
arrays are JSON; a flag alone is `true`; unknown arguments are refused. `murkfun-mcp <tool> --help` shows one tool's
schema. Calls on one `MURKFUN_HOME` run one at a time (a lock file, also against a running MCP server, which re-reads
the vault before each call). Secrets are passed as file paths, never as values; `export_recovery` needs `--confirm`.

The relayer API these tools talk to is described at https://murk.fun/docs/api; this package is its reference client.

## Develop

This repository is the whole source of the package. Each release's `.tgz` holds the built `dist/` plus `networks/`,
`circuits/`, `docs/`, `skills/`, the README, CHANGELOG and LICENSE (the `files` list in `package.json`). Issues and pull
requests are welcome: https://github.com/murkfun/murkfun-mcp/issues.

```bash
npm ci
npm start           # stdio server from source (tsx)
npm run typecheck
npm run build       # dist/
npm test            # config, network file, init, indexer client + chain fallback, seed signature, signed orders
                    # (hashes, typed data, holder paths and the holder-set API's proofs, witness and a real local
                    # proof with bb, which it downloads once), CLI arguments, the vault lock, curve port, order retries
                    # (fake relayer), uploads (fake upload API), revert and receipt decoding; no chain needed
./install.sh        # build, pack and install this checkout into ~/.murkfun/npm, then run murkfun-mcp init
```

Tests that need the rest of MurkFun (the relayer and indexer on a BSC fork with real proofs, every tool, the
[recovery drills](docs/RECOVERY_DRILL.md)) run in MurkFun's own test setup before each release; they are not part of
this repository.

Documents ([docs/](docs)):

- [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md): the full guide for agents (tools, waits, failure handling)
- [docs/SIGNED_ORDERS.md](docs/SIGNED_ORDERS.md): signed orders, the holder set, the order proof, privacy
- [docs/RELAYER_API.md](docs/RELAYER_API.md): the relayer API (every order, field and error)
- [docs/API.md](docs/API.md): the read API (launches, tokens, trades, holders, candles, the holder set, uploads)
- [docs/TOKEN_METADATA.md](docs/TOKEN_METADATA.md) and its [JSON schema](docs/token-metadata.schema.json): token metadata
- [docs/RECOVERY_DRILL.md](docs/RECOVERY_DRILL.md): backup, wipe, restore, step by step

The holder set's own code (tree, audit, fraud proofs, the contract and batch circuit sources, a CLI) is
https://github.com/murkfun/holder-roots (the `murkfun-holders` command).

| File | |
|---|---|
| `src/index.ts` | MCP wiring (serialized calls) and the CLI commands |
| `src/tools.ts` | Every tool (name, description, input schema), the vault lock, the shared error text |
| `src/cli.ts` | `murkfun-mcp <tool>`: command-line arguments → the tool's input |
| `src/agent.ts` | Tool implementations |
| `src/config.ts` | Environment + bundled network values |
| `src/indexer.ts` | Indexer API client (market data only, chain fallback) |
| `src/vault.ts` | Encrypted store (wallet, seed signature), backup/restore |
| `src/orders.ts` | Signed orders: hashes, typed data, holder tree and paths, the order witness, `bb` download (pinned sha256) and the local prover |
| `src/holdersLookup.ts` | `holders_lookup`: one holder-set entry, every fact checked on chain |
| `src/holdersApi.ts`, `src/logRpc.ts` | The holder path: the holder-set API's proof (checked locally and on chain), the log endpoint probe |
| `src/pp.ts` | 0xbow Privacy Pools client: deterministic notes, trees, deposit/transact proofs, ASP status |
| `src/zk.ts` | Poseidon (0xbow trees) and LeanIMT |
| `src/murkfun.ts` | MurkFunOrders.Order encoding (the relayer wire format, the 0xbow `params.data`), the launch digest |
| `src/curve.ts` | `MurkFunCurve.buy` in bigint (the creator buy's exact outcome), completing-buy detection |
| `src/receipt.ts` | A buy's receipt: `Bought`, `CurveCompleted`, `Graduated` / `GraduationFailed` |
| `src/circuits.ts` | 0xbow circuit download with pinned sha256 |
| `src/init.ts` | `murkfun-mcp init`: home directory, passphrase file, circuits, `bb` |
| `src/errors.ts` | Revert decoding and agent-facing hints |
| `src/relayerClient.ts` | Relayer HTTP client: quotes (completing-buy gas class), orders with bounded resubmission |
| `src/upload.ts` | `upload_token_metadata`: image checks, metadata stripping, the upload API |
| `src/abi.ts` | The MurkFun contracts' ABIs (generated from the deployed contracts' sources) |
| `circuits/order.json`, `circuits/order.vk` | The compiled order circuit and its verification key (the deployed order verifier's) |
| `networks/bsc.json` | Mainnet values |
| `scripts/set-network.mjs` | Writes / checks `networks/*.json` (maintainers) |
| `test/` | The tests (`npm test`); `test/fake-baw.mjs` stands in for the Binance Agentic Wallet CLI |
| `docs/` | The reference documents (above) |
| `skills/murkfun/SKILL.md` | The skill file for agents (served at https://murk.fun/skill.md) |
| `install.sh` | Contributor install from a checkout |

## License

MIT, see [LICENSE](LICENSE).
