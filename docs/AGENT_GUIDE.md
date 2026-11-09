# MurkFun agent guide

You are an AI agent operating MurkFun for your user through the local **MurkFun MCP server** (the `murkfun-mcp` package from https://github.com/murkfun/murkfun-mcp, stdio). This guide tells you exactly which tools to call, in which order, what to back up, how long things take, and what to do when something fails.

> Anonymity is a feature, not a guarantee: the Railgun and 0xbow anonymity sets on BSC are small, and timing/amount patterns can link actions.

## How your agent talks to MurkFun

Three ways, in this order:

1. **MCP tools (preferred).** The local MCP server `murkfun-mcp` (stdio) gives your agent the tools below. It keeps the
   secrets in an encrypted vault on the user's machine, has the wallet sign each order, makes every proof locally and
   sends only signed, proved orders.
2. **The same tools as shell commands, when your client has no MCP support** (OpenClaw, scripts, any client without MCP support):
   `murkfun-mcp <tool> --arg value …` or `murkfun-mcp <tool> --json '{…}'`. It runs the same code with the same
   environment variables and the same vault, and prints the same JSON on stdout. A failed tool prints the MCP's
   error text on stderr and exits with 1 (2: a bad command line, nothing ran). `murkfun-mcp tools` lists every tool
   with its JSON Schema; `murkfun-mcp <tool> --help` shows one. Argument names are the schema's (`--bnbAmount` or
   `--bnb-amount`); numbers, booleans and arrays are JSON; a flag alone is `true` (`--confirm`). Calls on one vault run
   one at a time, also next to a running MCP server. The safety rules are the same: no tool prints a secret, secrets
   are passed as file paths (`walletKeyFile`, `recoveryFile`), never as values on the command line (shell history,
   process list), and `export_recovery` still needs `--confirm`.
3. **The HTTP APIs underneath** ([Endpoints](#endpoints)). The read API ([API.md](API.md): launches, prices, trades,
   holders, candles) needs no keys: read market data from it directly. The relayer API ([RELAYER_API.md](RELAYER_API.md)) accepts only
   wallet-signed, proved orders, and the proofs need the user's seed signature and 0xbow note secrets: use it only
   through a client that makes the proofs locally. `murkfun-mcp` is the reference client. Never send a seed, a key, a seed-message
   signature, the passphrase or a recovery file to any server.

The CLI needs the same environment as the MCP server (`murkfun-mcp config json` prints it; at least
`MURKFUN_PASSPHRASE_FILE`). The install below puts `murkfun-mcp` on the PATH.

```bash
export MURKFUN_PASSPHRASE_FILE=~/.murkfun/passphrase
murkfun-mcp status
murkfun-mcp buy --token 0x… --bnbAmount 0.1
murkfun-mcp order_status --id 6f1c2a3e-…
```

| Action | MCP tool | CLI | Becomes |
|---|---|---|---|
| Set up / restore the vault | `setup` | `murkfun-mcp setup` | local vault; the wallet signs the seed message once (nothing is sent) |
| Notes, positions, orders | `status` | `murkfun-mcp status` | reads of the chain and the vault |
| Look up any holder-set entry (no wallet needed) | `holders_lookup` | `murkfun-mcp holders_lookup --query <name>.ai` | reads of the chain (the holder-set API only as a hint) |
| Deposit into 0xbow (only for `source=note`) | `deposit` | `murkfun-mcp deposit --amountBnb 1` | wallet transactions to 0xbow Privacy Pools (its keystore once, then the deposit) |
| Launch a token (create + your first buy) | `upload_token_metadata`, `create_token` | `murkfun-mcp create_token --name … --symbol … --metadataURI … --devFeeRecipient 0x… --bnbAmount 0.5` (exact out: `--buyTokens cap`; from 0xbow: `--source note`) | one signed Launch order: relayer order `railgunLaunch` (paid by a Railgun unshield to MurkFun's Railgun adapter, sent with `submit_railgun`; `source=note`: relayer order `privacyPoolLaunch`, paid from a 0xbow note) |
| Launch without a buy | `create_token` (no `bnbAmount` / `buyTokens`) | `murkfun-mcp create_token --name … --symbol … --metadataURI … --devFeeRecipient 0x…` | a signed Launch order: relayer order `launch` (sponsored) |
| Buy from Railgun (default) | `buy` | `murkfun-mcp buy --token 0x… --bnbAmount 0.1` (exact out: `--tokens 1000000` or `--tokens cap`; quote: `--dryRun`) | a signed BuyDirect (exact out: BuyDirectExactOut) order, the Railgun transaction to build for it (an unshield to MurkFun's Railgun adapter, bound to the order) and `relay`; then relayer order `railgunBuy` via `submit_railgun` |
| Buy from a 0xbow note | `buy` (`source=note`) | `murkfun-mcp buy --token 0x… --bnbAmount 0.1 --source note` | a signed BuyDirect order: relayer order `privacyPoolBuy` (through MurkFun's 0xbow adapter) |
| Send a Railgun-paid order | `submit_railgun` | `murkfun-mcp submit_railgun --transactionsFile railgun-txs.json` | relayer order `railgunBuy` / `railgunFund` / `railgunLaunch`: `relay.body` with the proved Railgun transactions (`POST /v1/orders`); the sender on chain is the relayer |
| Buy from the internal balance | `buy` (`source=balance`) | `murkfun-mcp buy --token 0x… --bnbAmount 0.1 --source balance` | relayer order `buy` (exact out: `buyExactOut`) |
| Sell | `sell` | `murkfun-mcp sell --token 0x… --percent 50` | relayer order `sell` |
| Withdraw BNB | `withdraw_bnb` | `murkfun-mcp withdraw_bnb --token 0x… --to 0x…` | relayer order `withdrawBnb` |
| Withdraw tokens | `withdraw_token` | `murkfun-mcp withdraw_token --token 0x… --to 0x…` | relayer order `withdrawTokens` |
| Fund a pseudonym | `fund_pseudonym` | `murkfun-mcp fund_pseudonym --token 0x… --amountBnb 0.5` | a signed Fund order: relayer order `railgunFund` (a Railgun unshield to MurkFun's Railgun adapter, sent with `submit_railgun`); after graduation also calls for any wallet |
| Claim fees | `claim_lp_fees` | `murkfun-mcp claim_lp_fees --token 0x…` | relayer orders `collectLpFees` + `claimDevFees` (sponsored, no signature: anyone may trigger them) |
| Change the dev fee recipient | `set_fee_recipient` | `murkfun-mcp set_fee_recipient --token 0x… --recipient 0x…` | relayer order `setDevRecipient` |
| Retry a graduation | `graduate` | `murkfun-mcp graduate --token 0x…` | relayer order `graduate` (sponsored) |
| Market data | `list_launches`, `token_info` | `murkfun-mcp list_launches --limit 20` | read API (or the chain); your balances always from the chain |
| Order status | `order_status` | `murkfun-mcp order_status --id …` | `GET /v1/orders/:id` |
| Back up | `backup`, `export_recovery` | `murkfun-mcp backup --path …`; `murkfun-mcp export_recovery --path … --confirm` | local files |
| Restore | `restore`, `recover_from_wallet`, `recover` | `murkfun-mcp restore --path …`; `murkfun-mcp recover_from_wallet` | local vault + chain reads |

## Endpoints

The values the MCP uses are in its bundled `networks/bsc.json`; `murkfun-mcp network` prints them (`indexerUrl`, `relayerUrl`). Full schemas: [API.md](API.md) (market data, uploads) and [RELAYER_API.md](RELAYER_API.md) (relayer).

**Market data API**, read-only, no keys, JSON, `GET` only: `https://api.murk.fun/v1`.

```bash
curl -s 'https://api.murk.fun/v1/launches?sort=new&limit=20'      # tokens; sort new|progress|volume|mcap|active, status all|curve|graduated|sold_out, q=<search>, offset
curl -s https://api.murk.fun/v1/tokens/0x…                        # one token: price, curve progress, terms, dev, fees, venue
curl -s 'https://api.murk.fun/v1/tokens/0x…/trades?limit=50'      # trades, newest first; next page: before=<next>
curl -s 'https://api.murk.fun/v1/tokens/0x…/holders?limit=10'     # holders (pseudonyms) and supply buckets
curl -s 'https://api.murk.fun/v1/tokens/0x…/candles?interval=5m'  # OHLCV; interval 1m|5m|15m|1h|4h|1d
curl -s https://api.murk.fun/v1/tokens/0x…/graduation             # graduation venue, pool, liquidity
curl -s https://api.murk.fun/v1/stats                             # platform totals
curl -s https://api.murk.fun/v1/params                            # the terms a token launched now gets: supply, caps, fees, venues
```

Never query it with the user's own pseudonym (`trades?pseudonym=`): that tells the API which pseudonym is theirs. Their balances come from the chain (`token_info`).

**Uploads** (on the same host, used by `upload_token_metadata`): `POST /v1/ipfs/image` (the raw image bytes) and `POST /v1/ipfs/metadata` (the metadata JSON); `GET /v1/ipfs/<cid>` serves what MurkFun pinned.

**Relayer** (`relayerUrl`): `GET /v1/info`, `GET /v1/quote`, `POST /v1/orders`, `GET /v1/orders/<id>`. Every order is signed by the user's wallet and carries a zero-knowledge proof made locally from the user's vault (the seed signature, the 0xbow note secrets), so orders go through the MCP tools (or their shell commands), never as hand-written HTTP requests. `order_status` reads `GET /v1/orders/<id>`.

## 0. Concepts

- **Who can trade: SPACE ID Agent ID holders.** MurkFun accepts orders only from wallets holding a SPACE ID Agent ID (ERC-721 "SPACE ID Agent ID" on BSC, `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`; soulbound, one per wallet, tokenId = keccak256(name without `.ai`)). It is claimed in the Binance Agentic Wallet (Binance App → Wallet → AI agent / Agent ID); MurkFun cannot mint it.
- **Holder set.** MurkFunHolderRoots keeps a Merkle tree of the Agent ID holders that claimed through SPACE ID's user path. Its operator adds new holders in batches (no transaction from the holder); one batch per hour, each usable once its challenge period (currently 1 h, adjustable, never below 10 min) has passed, and anyone can check it, challenge a wrong entry or force a missing holder in ([SIGNED_ORDERS.md](SIGNED_ORDERS.md#4-holder-set)). `status.holderSet` says whether the wallet is in an accepted root.
- **Wallet.** The BSC wallet that holds the Agent ID. Usually the user's **Binance Agentic Wallet**, driven through its CLI `baw` (`setup {signer:"baw"}` or `MURKFUN_SIGNER=baw`; it has no exportable key). Other options: a wallet the MCP creates (its key is in the vault) or the user's own wallet (`setup {walletKeyFile}`); each can trade only if it holds an Agent ID. It is **public**: it holds the Agent ID and makes the 0xbow deposits (and registers 0xbow's keystore before the first). It never sends a MurkFun transaction.
- **Signed orders.** Every action (buy, sell, withdrawal, launch, fee recipient) is an order the wallet signs: EIP-712 `OrderAuth {orderHash}` in the domain `{name: "MurkFun Order", version: "1", chainId: 56}`, where `orderHash` hashes the order with a random salt, so the signature request shows only an opaque hash. The wallet's operator is the exception: for the Binance Agentic Wallet, Binance holds the key and can compute the seed signature, hence every pseudonym of the wallet (a permanent property: [SIGNED_ORDERS.md §7](SIGNED_ORDERS.md#7-privacy)). The MCP then proves locally (Barretenberg `bb`, a few seconds) that the signer is in an accepted holder root and that the order's pseudonym and nullifier come from its seed signature, without revealing the wallet, and sends the order a random 30 s to 3 min later (`MURKFUN_ORDER_DELAY_MS`) which makes it harder for chain observers to match its timing to the signature's. Details: [SIGNED_ORDERS.md](SIGNED_ORDERS.md).
- **Seed signature.** At `setup` the wallet signs one fixed message, `MurkFunSeed {purpose: "MurkFun seed: only sign this on MurkFun"}` in the same domain (twice: the two signatures must be identical, a deterministic signer). The secret behind every pseudonym is a Poseidon2 hash of that signature, and the 0xbow keys are a separate HKDF output of it. The same wallet always gives the same signature, so **the wallet is the backup.** The signature is treated like a private key: kept only in the encrypted vault, never logged or returned by a tool. Never sign that message anywhere except for your own MurkFun agent. On its own it can not trade: every order needs the wallet's signature of that order.
- **Pseudonym.** For each token the seed yields exactly one pseudonym, H(secret, token). Holdings for that token live under it inside the MurkFun contract. Pseudonyms for different tokens are not linkable from the proofs alone; the wallet operator, your RPC, MurkFun's servers (by IP address) and timing or amounts can still link them.
- **Funding.** Two privacy pools, and every buy is **any amount**, exact in (`bnbAmount`) or exact out (`tokens`: exactly that many tokens; `"cap"` = up to the holding cap). **Railgun (default; `source` left out or `"railgun"`):** the user shields BNB into a Railgun wallet on BNB Chain (public, from any address; a new shield is spendable only after Railgun's Proof of Innocence standby, about 1 h). `buy {token, bnbAmount}` then returns a signed BuyDirect order and the Railgun transaction to build for it: it unshields exactly that amount (plus Railgun's 0.25% unshield fee; Railgun also charges 0.25% to shield) as WBNB to MurkFun's Railgun adapter (`MurkFunRailgunAdapter`, the transaction's adapt contract, bound to the order), which unwraps it and buys in the same transaction; the rest stays shielded. Once the Railgun wallet has proved that transaction (with the adapt ID `{contract: adapter, parameters: adaptParams}`), `submit_railgun {transactions}` has the MurkFun relayer send it, paid by the relayer fee in the order: the sender on chain is the shared relayer, so no wallet of the user pays gas or appears on chain, and the wallet needs no BNB (buys of one token still share its pseudonym, and amounts, timing and IP address can be correlated) (sending `railgun.submit` from any other account also works; that account is then public). **0xbow Privacy Pools (`source: "note"`):** the wallet deposits BNB into 0xbow (public). After the 0xbow ASP approves the deposit, `buy {token, bnbAmount, source: "note"}` withdraws that amount from one private note with one proof, through MurkFun's 0xbow adapter (`MurkFunPrivacyPoolAdapter`, the 0xbow processor), and pays it into the token's market for the pseudonym, which buys with it in the same transaction; the change stays in 0xbow for the next buy. The ASP approval can take hours or much longer, and the ASP may not approve a deposit at all: say so before the user deposits. **A plain wallet:** `fund_pseudonym` returns calls that credit BNB to the pseudonym's internal balance; then `buy source=balance`. BNB a funded buy does not spend (an exact-out buy's slippage margin, the rest of a buy that completes the curve) stays in the pseudonym's internal balance. Sells, withdrawals, caps and MurkFun's fees are the same either way.
- **Curve-phase privacy-pool rule: off on production** (`setPrivacyFundingRequired(false)` proposed 2026-11-09, applies after the 24 h timelock; `status.privacyFunding.requiredOnCurve` is the live value). While it is off, any wallet may fund a pseudonym on the curve: `fund_pseudonym` returns plain-wallet `calls` (that wallet's address is public; the pseudonym stays unlinked from the user's other pseudonyms). Say so to the user: Railgun and 0xbow stay the private paths.
- **During the curve, while the factory's privacy-funding rule is on, MurkFun only accepts BNB from privacy pools, through its own adapters (0xbow through MurkFun's 0xbow adapter, Railgun through MurkFun's Railgun adapter; Railgun's public RelayAdapt is not accepted)**. The owner can change the rule through the 24 h timelock. MurkFun's contract rejects BNB paid into a BuyDirect / Fund / creator-buy order by a plain wallet (`PrivacyPoolRequired`) while the token is on its curve and the factory's rule is on; `status.privacyFunding` shows `{requiredOnCurve, allowlist}`. After graduation the token also trades publicly on PancakeSwap and a plain wallet may fund again.
- **Privacy, in plain words.** Shield or deposit round amounts (0.5 / 1 / 5 BNB) so it looks like many others. Wait a while after it before buying. Don't buy exactly the amount you shielded or deposited. All buys of one token sit under one public pseudonym, so its total is visible anyway: splitting a buy into fixed small pieces hides nothing. The BSC RPC (`MURKFUN_RPC`) sees every read the MCP makes, the wallet's and each pseudonym's balances included, so its operator can link them: use your own node or an RPC you trust. Orders for two tokens sent back to back can land as consecutive relayer transactions, and a first trade right after a holder batch points to a new member: space them out when the link matters. MurkFun's relayer sees the IP address of every order, and by default the MCP asks MurkFun's holder-set API for the wallet's path from the same IP: set `MURKFUN_HOLDERS_API=` (empty) and use Tor or a VPN if MurkFun must not link the wallet to its pseudonyms. Never sign MurkFun typed data anywhere but in the MCP: a site asking for the seed message is phishing (the seed signature spends the 0xbow notes).
- **Custody.** Tokens and BNB stay inside MurkFun under the pseudonym. BNB can be withdrawn to any address at any time while the market is not paused; tokens only after graduation.
- **Relayer.** Signed orders that the MurkFun relayer submits to the token's market's order gate and pays gas for: trades go to private endpoints only (never a public mempool); other actions may fall back to a public RPC (`usedPublicFallback`). The relayer fee is part of the signed order (the relayer cannot change it or anything else) and is paid in BNB from the pseudonym's internal balance (for note buys: out of the amount; one order per buy, whatever the amount). If the relayer could not broadcast an order (`broadcast_failed`: nothing was sent), is overloaded or unreachable, or dropped the order (not executed), the MCP resubmits the identical order with backoff, up to `MURKFUN_ORDER_RETRIES` times: an order can never execute twice (its nullifier is burnt, and it binds the pseudonym's nonce; a 0xbow nullifier is single-use), and a stale order fails cleanly with `simulation_failed`.
- **Routing.** Each token trades in the market it was listed in, for good (`factory.marketOf(token)`); new tokens are listed in `factory.market()`. The MCP reads both on chain, so it follows a re-pointed market with no configuration, and keeps serving every token of an older market.

## 1. Install and configure (once)

The MCP server runs on the user's machine (Node ≥ 20), installed from its GitHub release (no sudo with a user-level
npm prefix such as nvm or `npm config set prefix ~/.local`):

```bash
npm install -g https://github.com/murkfun/murkfun-mcp/releases/latest/download/murkfun-mcp.tgz
murkfun-mcp init
```

The same command updates it to the latest release. From source instead: `git clone https://github.com/murkfun/murkfun-mcp && cd murkfun-mcp && npm ci && npm run build && npm link`.

`init` creates `~/.murkfun` (mode 0700) and a random
passphrase file `~/.murkfun/passphrase` (mode 0600) if none exists (an existing one is never touched), downloads the
0xbow circuit artifacts and Barretenberg's `bb` 6.0.0 (the order prover; skipped when `MURKFUN_BB` names one or a
`bb` 6.0.0 is on the PATH) and checks their pinned sha256, and prints the client config. It is idempotent. The user must
keep a copy of that passphrase offline, because encrypted backups are useless without it. The skill file for agents is
https://murk.fun/skill.md. Contributors build and install from a checkout of https://github.com/murkfun/murkfun-mcp with `./install.sh` (it
ends with `murkfun-mcp init`).

Print the config again at any time:

```bash
murkfun-mcp config claude-code   # a `claude mcp add ...` command for Claude Code
murkfun-mcp config json          # mcpServers JSON for Claude Desktop, Cursor and other clients
```

The JSON looks like this (it starts the installed `murkfun-mcp` command; `murkfun-mcp config --absolute` prints node and the script by absolute path instead, for a client started without the shell's PATH, common with nvm; it is also the default when `murkfun-mcp` on the PATH is not this installation; here `~` stands for the user's home directory, the printed paths are absolute). `MURKFUN_RELAYER_URL` and `MURKFUN_DEPLOYMENT` appear only when the package's network file (`networks/bsc.json`) has a `<...>` value for them or they are set in the environment:

```json
{
  "mcpServers": {
    "murkfun": {
      "command": "murkfun-mcp",
      "args": [],
      "env": {
        "MURKFUN_PASSPHRASE_FILE": "~/.murkfun/passphrase",
        "MURKFUN_RELAYER_URL": "<MurkFun relayer URL>",
        "MURKFUN_DEPLOYMENT": "<path to the MurkFun deployment.json>"
      }
    }
  }
}
```

For Claude Desktop, merge it into `claude_desktop_config.json`. For Claude Code, run the printed `claude mcp add` command. Developers can run from source with `git clone https://github.com/murkfun/murkfun-mcp && cd murkfun-mcp && npm ci && npm start`.

Environment variables:
- `MURKFUN_PASSPHRASE_FILE` (or `MURKFUN_PASSPHRASE`): the vault passphrase, at least 12 characters.
- `MURKFUN_RELAYER_URL`: the MurkFun relayer.
- `MURKFUN_DEPLOYMENT`: a path to (or inline JSON of) `{market, factory, orders, holderRoots, locker, privacyPoolAdapter, railgunAdapter?, deployBlock, holderRootsDeployBlock?}`. Values other than the bundled ones are reported (stderr, the MCP instructions, `setup` / `status`: `deployment: "custom"`, `configWarnings`; so are a non-bundled `MURKFUN_RPC` other than a local node, a non-bundled `MURKFUN_HOLDERS_API` and `MURKFUN_WITHDRAW_ALLOWLIST="*"`: tell the user before any deposit or order); the order verifier check stays on.

The last two override the bundled network file (`MURKFUN_NETWORK`, default `bsc` → `networks/bsc.json` in the package), which ships MurkFun's contract addresses and relayer URL. They are required only when that file holds a `<...>` template placeholder for them (a build from a network template rather than a release). `murkfun-mcp network` shows the bundled values and any placeholders. Without them the server stops with `networks/bsc.json has no value for ...: set MURKFUN_DEPLOYMENT` (or `MURKFUN_RELAYER_URL`).

The relayer, indexer and upload URLs must be `https://` (`http://` only for `localhost`).

Optional: `MURKFUN_RPC` (a BSC RPC for reads and the wallet's own public transactions; default from the network file, `https://public-bsc.nownodes.io`, which serves `eth_getLogs`; `bsc-dataseed.bnbchain.org` does not), `MURKFUN_HOLDERS_API` (default `https://murk.fun`: the holder-set API the wallet's holder Merkle path comes from; its proof is checked locally and against the on-chain accepted root, never trusted; empty = read the path from the chain's logs only, see [README.md](../README.md#holder-path-and-rpcs)), `MURKFUN_LOG_RPCS` (comma-separated RPCs tried after `MURKFUN_RPC` for `eth_getLogs` scans, each probed once per process; default the network file's `logRpcs`), `MURKFUN_INDEXER_URL` (the MurkFun indexer API, `…/v1`, for `list_launches`, the `market` block of `token_info` and `upload_token_metadata` (needs it, or `MURKFUN_UPLOAD_URL` when uploads live on another host); if it is down, lagging or serves another deployment, the tools read the chain instead and say so in `source` / `marketSource`; the user's own balances are always read on chain), `MURKFUN_HOME` (default `~/.murkfun`), `MURKFUN_CIRCUITS_DIR` (default `$MURKFUN_HOME/circuits`), `MURKFUN_PP_SNAPSHOT_URL` and `MURKFUN_ASP_LEAVES_URL` (default: 0xbow's public API), `MURKFUN_CHAIN_ID` (56), `MURKFUN_ORDER_WAIT_MS` (120000), `MURKFUN_ORDER_RETRIES` (3: resubmissions of the identical order after `broadcast_failed` / `overloaded` / `relayer_unreachable` or status `dropped`), `MURKFUN_ORDER_RETRY_BACKOFF_MS` (2000: the first wait, doubled each time, at most 30 s), `MURKFUN_MAX_RELAYER_FEE_BNB` (0.05: a relayer quote above it is refused before anything is proved), `MURKFUN_MAX_RELAYER_FEE_BPS` (1000: at most 10% of an order's BNB), `MURKFUN_MAX_FEE_MULTIPLE` (2: at most 2 × the quote's own gas × gas price; MurkFun's relayer quotes 1.1 ×), `MURKFUN_MAX_ORDER_VALIDITY_S` (600: the furthest deadline a quote may set; MurkFun's relayer quotes 5 minutes), `MURKFUN_MAX_GAS_PRICE_GWEI` (3: per action, a relayer fee is at most that action's most gas × this gas price × `MURKFUN_MAX_FEE_MULTIPLE`, whatever any RPC reports), `MURKFUN_RELAYER_ADDRESS` (pin the relayer's address), `MURKFUN_WITHDRAW_ALLOWLIST` (comma-separated: withdrawals and dev fee recipients only to these; unset = only the user's own wallet; `*` = any address; every destination is also checked against MurkFun's own recipient rule on chain), `MURKFUN_RPC_CHECK` (a second BSC RPC: the chain id and the holder root must match on both), `MURKFUN_LOG_CHUNK` (5000-block `eth_getLogs` window), `MURKFUN_ORDER_DELAY_MS` ("30000-180000": the random wait between an order's signature and its submission), `MURKFUN_BB` (a `bb` 6.0.0 binary), `MURKFUN_BB_DOWNLOAD` (0: never download `bb`), `MURKFUN_PP_SCAN_FROM` (tests only).

All tools return JSON. Amounts are decimal strings in BNB or whole tokens (18 decimals), e.g. `"0.37"`, `"1000000"`. A skill file for agents is in `skills/murkfun/SKILL.md`, published at https://murk.fun/skill.md.

## 2. First run: exact steps

1. `setup` → creates the encrypted vault. Returns `wallet`, `agentNft` (holds a SPACE ID Agent ID?), `holderSet` and next steps. With an Agent ID the wallet signs the seed message once (twice through `baw`: refused if the two differ); nothing is sent and nothing is registered. Binance Agentic Wallet: `npm install -g @binance/agentic-wallet`, `baw auth signin`, Developer Mode on in the Binance App (Agentic Wallet management page → Settings → Developer Mode), then `setup {signer:"baw"}` (or `MURKFUN_SIGNER=baw`); the wallet is the BSC address of `baw wallet address`. Other variant: `setup {walletKeyFile}` (the user's existing wallet; the key is read from the file). No Agent ID yet (`agentNft: false`): the user claims one, then `setup` again.
2. **Back up immediately** (see §6). The wallet is the backup; if the MCP created it, save its key with `export_recovery {path, confirm:true}` (a plaintext file; the tool returns only the path) and ask the user to move it offline and delete it from this machine. Never read it into the conversation. `backup {path}` keeps an encrypted copy of the vault.
3. `status` until `holderSet.inAcceptedRoot` is true: the holder-set operator adds new Agent ID holders in batches, one batch per hour, each usable once its challenge period (currently 1 h) has passed. Orders before that are refused with `NOT_A_HOLDER_YET` / `NOT_ACCEPTED_YET` and nothing is signed. Funding (next) does not need to wait.
4. **Railgun (default).** The user shields BNB into a Railgun wallet on BNB Chain (a Railgun wallet app or the Railgun SDK; any address may send the shield, which is public). A new shield is spendable only after Railgun's Proof of Innocence standby, **about 1 h**: tell the user, and buy once their Railgun wallet shows it spendable. `wallet` needs no BNB for this path (it only signs; the MurkFun relayer sends). Then `buy {token, bnbAmount}` → the user's Railgun wallet builds and proves the unshield it returns → `submit_railgun {transactions}` (§3).
5. **0xbow instead (`source: "note"`).** **Notice (Nov 8, 2026):** 0xbow's ASP on BNB Chain is currently not approving new deposits. Use Railgun. BNB already deposited into 0xbow is safe and can be taken back to your wallet any time with 0xbow's ragequit. Tell the user first that 0xbow's ASP must approve each deposit and that this can take hours or much longer (the ASP may not approve it at all). Then:
   1. Ask the user to send BNB to `wallet`: the deposit amount + about **0.003 BNB** for gas (0xbow's keystore registration once, then the deposit).
   2. `deposit {amountBnb}` (≥ 0.02; round amounts such as 0.5 / 1 / 5 BNB blend in). The first deposit registers 0xbow's keystore from the wallet. Nothing else to back up: deposits are found on-chain from the wallet. Binance Agentic Wallet: each transaction goes through `baw contract-call preview` (simulation + risk check) → `execute`; MurkFun stops instead of executing when the Binance App would have to confirm (`BAW_CONFIRMATION_REQUIRED`).
   3. Wait for **ASP approval**. Call `status` every 5–10 minutes; the note shows `aspApproved: true` when ready. A note buy before approval fails with `WAITING_FOR_ASP` and spends nothing. One deposit was measured approved after 524 s (~9 min), but on BSC it has taken far longer. Do not spam. If still pending after 24 h, tell the user (0xbow may have declined it; they can exit with 0xbow's own app via ragequit, or pay from Railgun instead).

## 3. Discover and trade

| Tool | Use |
|---|---|
| `list_launches {limit?, offset?}` | Newest tokens: curve progress %, raised BNB, price, graduated or not. With an indexer also market cap, 24h change and volume, trades, holders. `source`: `indexer` or `chain` (fallback, with `indexerError`). |
| `token_info {token}` | Token details (after graduation: `venue`, the DEX pool chosen by the contract) and **your** pseudonym's balances, cap, dev flag, all read on chain. With an indexer also `market` (price, market cap, volume, trades, holders); `marketSource` says which. |
| `buy {token, bnbAmount \| tokens, source?:"railgun", validMinutes?, selfSubmit?}` | The default source (Railgun). Sends nothing: the order names the MurkFun relayer and its fee (quoted like a 0xbow buy: relayer action `railgunBuy`; exact in: the buy gets `bnbAmount` minus the fee, exact out: the fee is added; `selfSubmit: true`: no relayer, no fee). Returns `relay` (`url`, `endpoint`, `id` and `body`: the exact JSON to `POST /v1/orders` once `body.transactions` holds the proved Railgun transactions; `submit_railgun` does that) and `railgun` (`adapter`: MurkFun's Railgun adapter; `unshield` {`token` WBNB, `amountWei` = the order's amount + Railgun's unshield fee read now, `to` = the adapter, `arrivesWei`}; `adaptContract` and `adaptParams` = keccak256(abi.encode(order)) for the Railgun transaction's bound parameters; `submit`: the adapter's `execute(transactions, order, orderProof)` with `order` / `orderEncoded` and `orderProof`) for a Railgun wallet or the Railgun SDK (Railgun engine: `TransactionBatch.setAdaptID({contract, parameters})`), and `call` (the bare buy, for any other sender, after graduation or with the rule off). The adapter pays the order exactly what the unshield delivered and nothing else; Railgun accepts the transaction only from the adapter, and the adapter only for this order. All of the value is paid in; BNB the buy does not need stays in the pseudonym's internal balance (`expectedUnspentBnb`). If the price or the cap would stop the buy, the whole transaction reverts and nothing is unshielded. Simulated as the adapter before returning. Binds the pseudonym's current nonce and the order's deadline (`validMinutes`, default 30; do not trade that token before it lands). |
| `buy {token, bnbAmount, source:"note"}` | 0xbow. One proof spends `bnbAmount` (relayer fee included; no minimum beyond the relayer fee) from the smallest ASP-approved note that holds it; the change stays in 0xbow. The order is a signed BuyDirect order, relayed as `privacyPoolBuy` (MurkFun's 0xbow adapter). Output: `paidBnb`, `relayerFeeBnb`, `changeNoteBnb`, `boughtTokens` / `spentBnb` from the receipt, and `privacy` warnings (a deposit less than an hour old, or a buy of exactly a deposit's amount). No single note big enough → `NOTE_TOO_SMALL` with the note sizes: buy less, split into several buys (one per note), or deposit more. Merging notes is a 0xbow transaction (a transact with 2+ inputs) that this MCP does not make; 0xbow's own app can. |
| `buy {token, tokens, source?}` | Exact out: exactly `tokens` tokens (`"cap"` = up to your curve-phase holding cap; for the dev, the dev limit). railgun (default): a BuyDirectExactOut order (cost × (1 + slippage) + relayer fee unshielded); note: the 0xbow withdrawal is cost × (1 + slippage) + relayer fee (a BuyDirectExactOut order through `privacyPoolBuy`); balance: a BuyExactOut order with `maxBnb` = cost × (1 + slippage), at most the balance. On the curve the cost is `quoteBuyExactOut`; after graduation there is no curve quote, so the MCP bounds the cost from simulated routed buys (`costBoundBnb`; the average price rises with size, so the bound is above the real cost) and `maxBnb` caps it. What the buy does not spend stays in your internal balance (`unspentBnb`). |
| `buy {…, dryRun: true}` | Quote only, nothing proved or sent: expected tokens, `minTokens` / `maxBnb`, the relayer fee and its gas class, `completesCurve`, and the note that would pay. |
| `submit_railgun {transactions \| transactionsFile, id?}` | Sends a Railgun-paid order (`relay` of `buy` / `fund_pseudonym` / `create_token` paid from Railgun, the default; `id` = `relay.id`, default the newest one not sent) through the MurkFun relayer once its Railgun transactions are proved: `transactions` as the Railgun engine / SDK builds them (Transaction objects, JSON, or the calldata of Railgun's `transact` or of the adapter's `execute` / `launch`). Checks them against the order first (`RAILGUN_TX_INVALID`: adapt contract, adapt params, WBNB, the adapter as recipient, the amount), then posts and waits like every order (resubmits after `broadcast_failed` / `dropped`). The relayer refuses (`bad_target`, `bad_unshield`, `wrong_relayer`, `fee_too_low`, `simulation_failed`) before sending anything; the Railgun notes stay unspent then. |
| `buy {token, source:"balance", bnbAmount \| tokens}` | Spend from your internal BNB balance for that token (e.g. after selling, or after `fund_pseudonym`): a Buy / BuyExactOut order. |
| `fund_pseudonym {token, amountBnb, source?:"railgun", buyBnb? \| buyTokens?, validMinutes?, selfSubmit?}` | Fund the internal balance from Railgun (the only private source here: `source: "note"` is refused with `NO_NOTE_FUNDING`, a 0xbow note pays `buy source=note` directly; for Railgun buys prefer `buy`, which buys directly). Sends nothing itself: returns `railgun` and `relay` for a signed Fund order (the same shape as `buy source=railgun`: an unshield to MurkFun's Railgun adapter, then `submit_railgun`; the relayer fee is paid from the credited BNB, `creditedBnb`), plus `calls` for a plain wallet (send in order; `calls[0]` carries the BNB) only after graduation or with MurkFun's rule off; on the curve `calls` is omitted and `privacyRule` says why. `buyBnb` (exact in) or `buyTokens` (exact out, `"cap"` allowed; curve phase) chains a buy right after the credit in the plain-wallet `calls` only (one Railgun unshield pays one order; with Railgun on the curve it is refused with `RAILGUN_BUYS_DIRECTLY`). The orders bind the pseudonym's current nonce and expire after `validMinutes` (default 30): do not trade that token until they land, otherwise call it again. Simulated before returning. |
| `sell {token, amount? \| percent?}` | Sell to the curve (pre-graduation) or the market's DEX venue (post). Proceeds go to your internal BNB balance. |
| `withdraw_bnb {token, to, amount?, confirmContract?}` | Pay BNB out to an address the user controls that `MURKFUN_WITHDRAW_ALLOWLIST` allows (unset: only the user's own wallet). Default: everything minus the relayer fee. Sending to the user's own wallet links the pseudonym to it in public (the result says so in `destination.privacy`); for privacy the user adds a fresh address to the allowlist. Destinations where funds are lost are refused, a contract needs `confirmContract` (see [Destinations](#destinations)). |
| `withdraw_token {token, to, amount?, confirmContract?}` | Post-graduation only. Real ERC20 to `to`. If your BNB balance cannot pay the relayer fee, a few tokens are sold to pay it. Same destination checks. |
| `graduate {token}` | Retry only: graduation is automatic, the buy that completes the curve graduates the token in the same transaction. Use it when that automatic graduation failed (the completing buy's `graduation.graduated: false`, or `curveProgressPct` 100 but not graduated). Permissionless, relayer-sponsored. |
| `status` | Notes (with ASP state), positions, recent orders, and the emergency pause: `marketPaused`, `pauseGuardian`, `pendingGuardian` and `pendingGuardianEta` (a new guardian the owner proposed through the 24 h timelock), `pausePowerActive`, `pauseRenounced`. |
| `holders_lookup` | `{query}`: a 0x address, an Agent ID name or name.ai. Read-only (no wallet, no vault). The Agent ID's owner and handle, its origin (`register` = in the set; `admin` = adminRegister, never in it), membership (`batch`, `position`, `accepted`, `usableFrom`) and, once accepted, the Merkle path to the on-chain `acceptedRoot`. `verified` says what was checked on chain. Anyone can check the whole set: `murkfun-holders tree` (https://github.com/murkfun/holder-roots). |
| `order_status {id}` | `submitted` → `mined` / `reverted` / `dropped` (not executed; the trading tools resubmit it themselves) / `failed`. |

All trading tools take `slippageBps` (default 300 = 3%). They quote first, set `minOut`, have the wallet sign the order, prove locally (the order proof a few seconds; a 0xbow transact proof 6–25 s), wait the random submission delay, send to the relayer and wait up to `MURKFUN_ORDER_WAIT_MS` for the receipt.

Rules the contracts enforce:
Quotes: before graduation, the curve views `quoteBuy` / `quoteBuyExactOut` / `quoteSell` of the token's market. After graduation, the MCP simulates (with `eth_call`, from the order gate's address) `MurkFunMarket.execute` of an unsigned Buy / Sell / BuyDirect order with `minOut = 0`, then signs the real order with `minOut = quote × (1 − slippage)`; a 0xbow buy is quoted with a simulated BuyDirect of the same net amount (no signature, no proof). This works on any venue the market graduates to (Pancake Infinity, v3 or V2); the MCP never talks to a DEX directly.

- **Holding cap during the curve phase:** 1% of supply per pseudonym (the dev pseudonym up to the platform's dev limit, 30%). The tool refuses a buy that would cross it with `OVER_CAP`, and the message says how many more tokens are allowed. **No cap after graduation.**
- **The completing buy.** A buy for more than what is left on the curve (on every path: note, Railgun, balance, exact in or exact out) fills exactly the rest. BNB it does not need stays in the pseudonym's internal balance (`unspentBnb`, from the receipt's `Bought.bnbIn`). The MCP detects it before proving (`quoteBuy` spends less than offered, `quoteBuyExactOut` fills fewer than asked, or exactly the rest) and says so (`completesCurve`).
- **Graduated in the same transaction**: the completing buy graduates the token (`CurveCompleted`, then `Graduated` in its receipt; the result's `curveCompleted` and `graduation`). It pays the graduation gas (~1.3M on Infinity, up to ~7M on the v3 / V2 fallback), so the relayer quotes it in the `completing-buy` gas class (the MCP asks `/v1/quote` with the token and the amount, and `graduates=1` when it detected it itself); the result's `relayerFee` shows that fee next to a standard buy's (`standardBuyFeeBnb`). Only if that graduation fails (`GraduationFailed`; `graduation.graduated: false`) do buys wait for `graduate` (anyone may call it); sells and withdrawals keep working while the market is not paused (a sell reopens the curve, and the next buy that sells it out graduates the token).
- **One action at a time per token.** Each order binds the pseudonym's nonce; the MCP runs tool calls sequentially.

### Destinations

`withdraw_bnb`, `withdraw_token`, `set_fee_recipient` and `create_token`'s `devFeeRecipient` send BNB, tokens or fees to
an address. **The contracts stop only part of the destinations where they would be lost**: they refuse
(`BadRecipient`) what `MurkFunFactory.isBlockedRecipient` names: the zero address, WBNB, the factory, any MurkFun
token, an allowlisted privacy funder (MurkFun's 0xbow and Railgun adapters) and every MurkFun contract the factory has
registered (markets, order gates, Dexes, lockers, the hook, the holder set, the verifiers). A
withdrawal or a fee recipient set to a burn address or Railgun's RelayAdapt is accepted on chain
and the funds are gone. The tools check every destination before the wallet signs, after `MURKFUN_WITHDRAW_ALLOWLIST`
(`destination_not_allowed`):

- **Refused** (`bad_recipient`, no override): whatever `isBlockedRecipient` names (read on chain; the check fails if
  the RPC does not answer), the token itself (also the address a launch is about to create), any MurkFun token
  (`factory.marketOf(address) != 0`), WBNB, the factory, every MurkFun market (the token's, the current one, the
  deployment's) with its order gate, Dex, LP locker, Infinity hook and holder set, MurkFun's 0xbow and Railgun adapters
  and every privacy funder the factory allowlists, Railgun's RelayAdapt, the zero address, `0x…dEaD` and precompile /
  system addresses (up to `0xffff`).
- **Confirmed** (`recipient_is_contract`): any other address with contract code. Funds sent to a contract are usable
  only if it can move them (a Safe or another smart wallet can; a token, a pool or a router cannot). Ask the user; only
  after they confirm the contract is theirs, call again with `confirmContract: true`. A withdrawal of BNB to a contract
  that rejects plain BNB arrives as WBNB. An EIP-7702 delegated wallet counts as a plain wallet.
- **Plain wallet** addresses (no code) pass. The result's `destination` says which case applied.

MurkFun's relayer refuses the same MurkFun destinations again before it sends an order (`bad_recipient`), so an order
built by another client cannot strand funds there through MurkFun's relayer either.

## 4. Launching a token (dev)

1. `upload_token_metadata {name, symbol, description?, imagePath? | imageUrl?, links?}` (optional): uploads the image (PNG/JPEG/WebP/GIF ≤ 1 MB, square, 256–1024 px; the server strips EXIF / GPS and other metadata) and the metadata JSON to IPFS through MurkFun's API (pinned by MurkFun), and returns `metadataURI` plus a preview. No pinning account needed; the upload shows your IP to MurkFun's server. Own pinning is still allowed ([TOKEN_METADATA.md](TOKEN_METADATA.md)). Never invent a CID.
2. `create_token {name, symbol, metadataURI, devFeeRecipient, bnbAmount?, buyTokens?, vanitySuffix?}` (`metadataURI` from step 1, your own `ipfs://` pin, or `""`). Your pseudonym for the new token becomes its **dev pseudonym**. Its holding cap on the curve is the platform's dev limit, `devCap` in the token's terms (`Params.devCapBps`, 3000 = 30% of supply; snapshotted at listing like every other term). The dev does not set it, and it is never below the 1% holder cap. Optional `vanitySuffix` (1–5 hex characters, any dev): the address will end with it (the address commits to every other argument and to the platform terms of the moment, so it is searched last; 4 characters take seconds). The token keeps the platform's terms current at launch (fees, caps, curve) for good. `devFeeRecipient` gets 0.3% of curve volume and 50% of LP fees. Anyone can see this address: use one not linked to the user if that matters. Without a buy the launch is relayer-sponsored (no fee).
   **Creating a token is your first buy**: `bnbAmount` (BNB to spend, exact in) or `buyTokens` (exact out; `"cap"` = up to the dev limit) makes the dev's first buy in the same transaction as the creation (one signed Launch order, `MurkFunOrders.launch`), so nobody can buy before the dev; absent, the token is created without a buy. While the factory's privacy-funding rule is on, it is paid from a privacy pool like every curve buy; it is bounded by the dev limit (the MCP checks it against `devCap` of `factory.currentTerms()` before proving). `source:"railgun"` (default): returns the signed Launch order and the Railgun transaction to build for it (an unshield to MurkFun's Railgun adapter, then its `launch(spec, transactions, order, proof)`) and sends nothing; `submit_railgun` sends it (relayer order `railgunLaunch`; `bnbAmount` includes the relayer fee). `source:"note"`: ONE relayer order `privacyPoolLaunch` through MurkFun's 0xbow adapter, the Launch order and the 0xbow proof committing to the predicted token address, with one relayer fee for the creation and the buy (`bnbAmount` includes it). The first buy is the first trade on a fresh curve and atomic with the creation, so the MCP computes its exact outcome from `factory.currentTerms()` (a bigint port of `MurkFunCurve.buy`) and sets `minTokensOut` to it: no slippage. It can never complete the curve (the dev limit is below the curve supply). `dryRun:true` shows `creatorBuy` (tokens, cost, curve fee, paid, relayer fee) first.
3. `claim_lp_fees {token}`: after graduation, pays out the post-graduation fees (50% dev / 50% platform): on PancakeSwap Infinity the hook's BNB fee on every trade (the LP is burnt), on the v3 / V2 fallback the locked LP's fees in BNB + token; and pays out accrued curve fees to the dev recipient. Sponsored once a claim's BNB payout covers its gas (until then the result says `nothingToCollect: true`; token-side LP fees alone wait for BNB-side ones).
4. `set_fee_recipient {token, recipient, confirmContract?}`: dev only. Needs the relayer fee in your internal BNB balance for that token (sell a few tokens first if it is 0). The new recipient (like `create_token`'s `devFeeRecipient`) gets the same destination checks as a withdrawal ([Destinations](#destinations)).

## 5. Fees and timings

- Curve trades: the token's curve fee, 1% by default (0.7% platform, 0.3% dev); each token keeps the fee it was listed with (`token_info` shows it). After graduation: the fee of the venue the token graduated to, plus the MurkFun router fee (default 0). Normally this is PancakeSwap Infinity: 1% in BNB on every trade, charged by MurkFun's hook (the token's `infinityFeeBps`; the pool's LP fee is 0, so PancakeSwap's protocol fee on it is 0; PancakeSwap can set up to 0.4%). Fallbacks: v3 1% (LPs get 0.68%), v3 0.25%, V2 0.25%.
- Relayer fee: quoted per action by the relayer (`gas × gas price × margin`) and bound into the proof. At 0.1 gwei it is a few ten-thousandths of a BNB (a 0xbow buy is one order, ~2.1M gas with the order proof's ~0.75M verification, whatever the amount). The relayer rejects orders whose fee does not cover gas. A 0xbow buy has no minimum beyond that fee. The buy that completes the curve is quoted in the `completing-buy` gas class (~7M extra gas for the graduation it triggers), so its fee is several times a standard buy's; the tool reports both. A create with a creator buy pays one fee for both.
- Graduation goes to PancakeSwap Infinity (1%; MurkFun's hook is designed to resist pool griefing). Only if that fails: v3 1%, then v3 0.25%, then V2 (the last resort; if every venue refuses, the graduation reverts with `GraduationBlocked()` and can be retried). On Infinity and v3 the LP is two ranged positions, so the pool trades like the curve: the raised BNB sits between the curve's start price and the graduation price (selling back pays out at the curve's prices, down to the start price, below which there is no liquidity), the 200M LP tokens above the graduation price; V2 is full range. The contract stores the chosen venue as `market.venueOf(token)` → `(venue, fee, pool)`: venue 1 = Infinity (pool = CLPoolManager; pool id = `MurkFunDex.infinityPoolId(token)`), 2 = v3, 3 = V2. `token_info` and `graduate` show it as `venue: {name, venue, fee, pool}`. The MCP never trades on the venue directly; it calls the market's routed functions. Note: DexScreener does not list Infinity pools; GMGN and GeckoTerminal do.
- Proving time on a laptop-class CPU: the order proof a few seconds; a 0xbow transact proof 6–25 s. Each order is sent 30 s to 3 min after the wallet signs it (`MURKFUN_ORDER_DELAY_MS`).

## 6. Backup: what and when

The vault (`$MURKFUN_HOME/vault.json`) is encrypted with `MURKFUN_PASSPHRASE` (scrypt + AES-256-GCM). Everything secret derives from the wallet's **seed signature**: every pseudonym, the 0xbow keys and every note secret.

**Your wallet is your backup — guard it.** The seed signature is made again by the same wallet, and deposits, change notes and positions are found on-chain, so nothing else needs a backup. Whoever holds the wallet key can sign orders: it controls the MurkFun funds.

| What | Tool | When |
|---|---|---|
| The wallet key (only if the MCP created the wallet) | `export_recovery {path, confirm:true}` | Once, after `setup`. Writes a `murkfun-recovery` file (wallet key, deposit list, tokens; no seed) to a new file (mode 0600, never overwrites) inside `MURKFUN_HOME` or `MURKFUN_EXPORT_DIR` (a directory the user sets, e.g. a USB stick) and returns only the path. The file holds the plaintext key: store it encrypted or offline, never in synced folders, email or chat. The user stores it offline and deletes it from the computer. A user-supplied wallet or the Binance Agentic Wallet needs nothing here: it is already the backup. |
| Encrypted vault copy | `backup {path}` | Optional convenience (order history). Writes a new file (an existing one only with `confirm: true`, after the user confirmed the path). Restore with `restore {path}`. Useless without the passphrase. |
| Passphrase | (user) | Keep it; it opens the vault and encrypted backups. |

Recovery on a new machine: install, configure the passphrase, then `recover_from_wallet {walletKeyFile}` (or `{signer:"baw"}`), or `setup {recoveryFile}` + `recover`. The wallet signs the same seed message again, which gives the same secret; `recover` then finds the deposits (the pool's `Deposited` events since the MurkFun deployment, matched against this seed's commitments), the current change note of each (the `PrivacyPoolFunded` amounts of this seed's pseudonyms, emitted by MurkFun's 0xbow adapter for buys and creator buys, each candidate checked on-chain) and the tokens with a position. The wallet stays in the holder set (it is soulbound and append-only). Step by step in [RECOVERY_DRILL.md](RECOVERY_DRILL.md) (wipe `~/.murkfun` entirely → `recover_from_wallet` → same positions and notes). `recover` scans from the current deployment's block: a deposit made before it needs `recover {deposits: [{index, valueBnb}]}`.

Never paste the seed, wallet key, a signature of the MurkFun seed message, the passphrase or the recovery file into chats, issues or logs. Never read the recovery file or a signature file into the conversation: everything an agent sees goes to its model provider. No tool output contains secrets; outputs hold only addresses, pseudonyms, amounts and tx hashes (the signature is never returned or echoed).

## 7. Failure handling

A failed tool returns `error: <message>`, usually followed by a hint in parentheses. Most errors are not MurkFun's servers failing: find where one comes from in the five tables below. Whatever the source, a refused order spent nothing: notes and balances are read from the chain, so call `status` before retrying anything that failed partway.

**1. Your own setup, checked by the local MCP server** (nothing was sent anywhere):

| Message starts with / contains | Meaning | Do |
|---|---|---|
| `set MURKFUN_DEPLOYMENT` / `set MURKFUN_RELAYER_URL` | The MCP's bundled network file has a `<...>` value there and the MCP config sets none. | Ask the user for the value; never invent it. |
| `MURKFUN_PASSPHRASE is not set` / `cannot decrypt the vault` | The passphrase file in the MCP config is missing, or it is not the one the vault was made with. | Fix `MURKFUN_PASSPHRASE_FILE`. Never create a new vault over the old one. |
| `MURKFUN_PASSPHRASE is too short` | Under 12 characters. | Use the file `murkfun-mcp init` creates. |
| `no vault yet` | First run. | `setup`. |
| `VAULT_BUSY` | Another `murkfun-mcp` process is using the vault. | Wait for it to finish, then retry. |
| `has no BNB for gas` | The wallet cannot pay for its own 0xbow transactions (keystore, deposit). | Ask the user to send about 0.003 BNB to `wallet`. |
| `NO_AGENT_NFT` | The wallet holds no SPACE ID Agent ID (read on chain). | The user claims one in the Binance Agentic Wallet (Binance App → Wallet → AI agent / Agent ID); with the agent wallet use `signer: "baw"`. MurkFun cannot mint it. |
| `NOT_A_HOLDER_YET` / `NOT_ACCEPTED_YET` / `NO_ACCEPTED_ROOT` | The wallet is not in an accepted root of MurkFun's holder set yet: the operator's next batch adds it, usable once its challenge period (currently 1 h) has passed. Nothing was signed or sent. | Tell the user; check `status` (`holderSet`) again within the hour, then retry. |
| `PROVER_MISSING` / `CIRCUIT_MISSING` / `PROVER_FAILED` / `WITNESS_FAILED` | The local prover (`bb` 6.0.0) could not prove the order. Nothing was sent. | Read the message; `murkfun-mcp init` installs `bb`, or set `MURKFUN_BB`; reinstall `murkfun-mcp` for a missing circuit. |
| `WRONG_SIGNER` / `BAD_SIGNATURE` | The signature is not this wallet's, or a high-s signature. | Check that the signer is the vault's wallet (`MURKFUN_BAW_ACCOUNT`). |
| `BELOW_MINIMUM` | A deposit under 0.02 BNB, a 0xbow buy not above the relayer fee, or proceeds / a balance below the relayer fee. | Raise the amount. |
| `COMPLETION_BOUNDARY` | A 0xbow buy (exact in) whose amount ends right at the end of the curve: after the standard relayer fee it would complete the curve, after the higher completing-buy fee it would not. | Use one of the two amounts the message gives: at least the first to complete the curve (and graduate the token), or less than the second. |
| `RPC_NO_STATE_OVERRIDE` | A quote or sell of a graduated token needs an `eth_call` state override (its quote proof is valid only under one, so it can never execute on chain), and `MURKFUN_RPC` drops or refuses it. Nothing was sent. | Set `MURKFUN_RPC` to an RPC that supports state overrides (the third `eth_call` parameter). |
| `NOTE_TOO_SMALL` / `no unspent 0xbow note` | No single 0xbow note holds that much (the message lists the notes). | Buy at most the largest note, split into several buys, or `deposit` more (ask first). |
| `OVER_CAP` | The buy would cross the holding cap (1% of supply per pseudonym on the curve; for the dev, the platform's dev limit of 30%). | Buy less (the message says how much more is allowed; `tokens: "cap"` buys exactly up to it), or wait for graduation. |
| `MARKET_PAUSED` | MurkFun's emergency pause is on (read on chain): every MurkFun action waits (launches, buys, sells, funding, graduation, `withdraw_bnb`, `withdraw_token`, fee claims). Balances and holdings stay where they are. | Tell the user; retry after the guardian unpauses (`status` shows `marketPaused`). Do not retry in a loop. LP fee collection on a graduated pool is not paused. |
| `PRIVACY_POOL_REQUIRED` | During the curve the BNB must come from a privacy pool on MurkFun's allowlist, and the one asked for is not on it (MurkFun's Railgun adapter, when the message names it). | `buy` from a 0xbow note (`source: "note"`); a plain wallet can fund after graduation or once the rule is off again. `status` shows `privacyFunding`. |
| `NO_NOTE_FUNDING` | `fund_pseudonym` with `source: "note"`: funding is paid from Railgun only. Nothing was signed or sent. | To spend a 0xbow note, `buy {token, bnbAmount, source: "note"}`. |
| `does not match the chain` / `root != on-chain root` | The local copy of a Merkle tree is behind the chain (a lagging RPC). | Retry in a minute. |

**2. The Binance Agentic Wallet** (the `baw` CLI, the user's wallet; nothing was executed):

| Message | Meaning | Do |
|---|---|---|
| `BAW_NOT_FOUND` | The CLI is not installed or not on the server's PATH. | `npm install -g @binance/agentic-wallet`, or set `MURKFUN_BAW_PATH`. |
| `BAW_CONFIRMATION_REQUIRED` / `BAW_NOT_BROADCAST` / `BAW_NOT_SIGNED` | The Binance App would have to approve it (a limit or security setting). | Tell the user; call again after they change the setting. |
| a `BAW_…` error with code `(351802)` or "Developer Mode" | Developer Mode is off or expired. | The user turns it on in the Binance App (Agentic Wallet → Settings → Developer Mode). |
| `BAW_SIMULATION_FAILED` / `BAW_RISK` / `BAW_PREVIEW_FAILED` | Binance's simulation failed, flagged a risk, or returned no request. | Tell the user. |
| `BAW_NONDETERMINISTIC` | The wallet signed the same seed message differently twice. MurkFun needs a deterministic signer (one seed signature per wallet). Nothing was stored. | Tell the user; MurkFun can not use this wallet. |
| `BAW_ACCOUNT_MISMATCH` / `BAW_SEVERAL_ADDRESSES` | Another Binance account, or several BSC addresses. | Sign in to the right account, or set `MURKFUN_BAW_ACCOUNT`. |

**3. MurkFun's servers: the relayer and the upload API** (a refused order was not executed):

| Message | Meaning | Do |
|---|---|---|
| `fee_too_low` | The order's relayer fee no longer covers its gas: the gas price rose since the quote, or the buy now completes the curve (another buy landed first) and so pays the graduation gas, which is quoted in the completing-buy gas class, several times a standard buy's fee. | Call the tool again: it re-quotes. If `dryRun` now shows `completesCurve: true`, tell the user the higher fee first. |
| `deadline_too_soon` | The quote's deadline was too close when the order arrived. | Call the tool again. |
| `busy`, or status `submitted` | An earlier order of this pseudonym or note is still pending. | `order_status {id}`, then retry after it is mined. |
| `broadcast_failed` / `overloaded` / `simulation_unavailable` / `relayer_unreachable` | Nothing was sent: no private endpoint took the transaction, the relayer is at capacity or could not read the chain, or the MCP could not reach the relayer. The MCP already resubmitted the identical order `MURKFUN_ORDER_RETRIES` times with backoff (the message says how many). | Retry later. If `relayer_unreachable` persists, check the network and `MURKFUN_RELAYER_URL`. |
| `relayer_fee_too_high` | The relayer quoted a fee above `MURKFUN_MAX_RELAYER_FEE_BNB` (default 0.05 BNB), above 2 × its own gas estimate (`MURKFUN_MAX_FEE_MULTIPLE`) or above 10% of the order's BNB (`MURKFUN_MAX_RELAYER_FEE_BPS`). Nothing was proved or sent. | Tell the user; retry later, or raise the limit only if the user accepts that fee. |
| `relayer_deadline_out_of_range` / `relayer_mismatch` | The relayer quoted a deadline outside 60 s – 10 min from now (`MURKFUN_MAX_ORDER_VALIDITY_S`), or named another relayer address than the pinned one (`MURKFUN_RELAYER_ADDRESS`, else the first it answered with). Nothing was signed or sent. | Tell the user; the relayer is faulty or hostile: do not retry against it. |
| `destination_not_allowed` | The withdrawal or fee recipient is not in `MURKFUN_WITHDRAW_ALLOWLIST` (unset: only the user's own wallet). Nothing was signed or sent. | Ask the user; only the user changes the allowlist (in the MCP server's environment, then a restart). |
| `validity_too_long` | `validMinutes` is above `MURKFUN_MAX_ORDER_VALIDITY_S` (at least 30 min). Nothing was signed or sent. | Use the default (30 min for Railgun) or a shorter validity. |
| `bad_recipient` | The withdrawal destination or fee recipient is an address where the funds would be lost or stuck: a MurkFun contract, any MurkFun token (the token itself included), WBNB, MurkFun's 0xbow / Railgun adapter, Railgun's RelayAdapt, a burn or system address, or anything the contracts' own rule names (`MurkFunFactory.isBlockedRecipient`, read on chain; the order would revert with `BadRecipient`) ([Destinations](#destinations)). The MCP refuses it before signing; the relayer refuses such an order too. Nothing was signed or sent. | Ask the user for an address they control. `confirmContract` does not override it. |
| `recipient_is_contract` | The destination is a contract, not a plain wallet address. Nothing was signed or sent. | Ask the user whether that contract is theirs and can move BNB / tokens (a Safe can; a token, a pool or a router cannot). Only after they confirm, call again with `confirmContract: true`. Never set it on your own. |
| `WRONG_CHAIN` / `ROOT_MISMATCH` | The RPC is not BSC, or `MURKFUN_RPC` and `MURKFUN_RPC_CHECK` disagree on the holder root. Nothing was signed or sent. | Check the RPC settings; retry later. |
| `NO_LOG_RPC` | The holder-set API gave no usable proof (down, or its proof failed the checks), and no configured RPC serves `eth_getLogs` over the holder set's history. The message names each RPC and why it failed. Nothing was signed or sent. | Retry later (the API is usually back), or set `MURKFUN_RPC` / `MURKFUN_LOG_RPCS` to a BSC endpoint that serves `eth_getLogs` over old blocks. |
| status `dropped` | The relayer cancelled its transaction (not mined in time); it was not executed. The MCP resubmits the identical order by itself; a result still `dropped` used every retry. | Retry later. |
| `relayer_underfunded` / `unavailable` / `misconfigured` / `internal` | A problem on the relayer's side. | Retry later (`internal`: check `order_status` if an id was returned); tell the user if it persists. |
| `rate_limited` | Too many requests or orders from this IP address. | Wait a minute. |
| `unknown_token` | Not a MurkFun token. | Check the address. |
| `simulation_failed: <Error>()` | The contract would revert, so the relayer sent nothing. | Look `<Error>` up in table 4. |
| `order_expired: Expired()` | The order's deadline is already behind the chain's time. The MCP sets every deadline (orders, quotes, Railgun calls, launches) from the latest block's time, never from the local clock, so this means the RPC serves a stale chain head or the order waited too long. Nothing was spent. | Retry; if it repeats, set `MURKFUN_RPC` to another RPC. |
| `not_square` / `bad_size` | `upload_token_metadata`: the image is not square, 256–1024 px. | Ask the user for a square version, or crop it with a local tool. |
| `upload rate limit reached` / `content_blocked` / `uploads API unreachable` | The upload API's per-IP limit, refused content, or no answer. | Wait a minute; for refused content, ask the user for other content. They can also pin the files themselves ([TOKEN_METADATA.md](TOKEN_METADATA.md)). |

**4. The chain: MurkFun contract reverts** (as `simulation_failed: <Error>()`, an order status `reverted`, or the MCP's own simulation; nothing was spent):

| Error | Meaning | Do |
|---|---|---|
| `Slippage()` | The price moved beyond `slippageBps`. | Re-run once (it re-quotes). If it fails again, ask the user before raising slippage. |
| `CapExceeded()` | Over the holding cap (1% per pseudonym on the curve; for the dev, the platform's dev limit of 30%). | Buy less, `tokens: "cap"` / `buyTokens: "cap"`, or wait for graduation. |
| `InsufficientBalance()` | Not enough internal BNB or tokens for this pseudonym (relayer fee included). | Check `token_info`; reduce the amount. |
| `WrongNonce()` / `NullifierUsed()` / `UnknownRoot()` / `Expired()` | The pseudonym's nonce moved (another action landed first), this signed order was already used, the holder root is no longer accepted, or the deadline passed. | Call the tool again (a new order is signed and proved). |
| `InvalidProof()` | The order proof was rejected (a changed order, or a stale bundled circuit). | Call the tool again; if it repeats, reinstall `murkfun-mcp`. |
| `MarketPaused()` / `market_paused` | The emergency pause is on (the relayer answers `market_paused`). | As `MARKET_PAUSED` above. |
| `PrivacyPoolRequired()` | During the curve, BNB came from an address not on MurkFun's privacy-pool allowlist. | `buy` from Railgun (the default) or from a 0xbow note (`source: "note"`); a plain wallet can fund after graduation or once the rule is off again. |
| `BadRecipient()` | The withdrawal or fee recipient is a MurkFun contract or token, a privacy-pool adapter or WBNB, where the funds would be lost (`MurkFunFactory.isBlockedRecipient`; the MCP checks it before signing: `bad_recipient`). | Ask the user for another address (an ordinary wallet). |
| `NotBoundToOrder(i)` / `NotAWbnbUnshield(i)` / `WrongUnshieldAmount(expected, received)` / `NoUnshield()` | MurkFun's Railgun adapter: a Railgun transaction does not name the adapter and this order's `adaptParams`, is not a plain (NORMAL) unshield of WBNB to the adapter, or the unshields do not add up to exactly the order's amount after Railgun's fee (Railgun's fee changed since the quote). The Railgun notes are unspent. | Call the tool again (fresh amounts and order); build the Railgun transaction with exactly the returned `railgun` values. |
| `bad_unshield` / `bad_target` / `RAILGUN_TX_INVALID` | `submit_railgun`: a Railgun transaction is not a NORMAL WBNB unshield to MurkFun's Railgun adapter bound to this order (`railgun.adaptContract`, `railgun.adaptParams`), or the unshields do not deliver exactly the order's amount after Railgun's current fee; `bad_target`: the adapter is not on MurkFun's privacy-funder allowlist. Nothing was sent; the Railgun notes are unspent. | Build the Railgun transaction again with exactly the returned `railgun` values; if Railgun's fee changed, call the tool again for a new order. |
| `RAILGUN_ORDER_EXPIRED` / `RAILGUN_RELAY_SENT` / `RAILGUN_RELAY_NONE` | `submit_railgun`: the order's deadline passed (nothing spent); it was already accepted (`order_status`); no Railgun order is waiting. | Call `buy` / `fund_pseudonym` / `create_token` with `source=railgun` again for a new order. |
| `WrongToken()` / `WrongRecipient()` / `NotLaunchKey()` | A launch: the created token is not the address the Launch order commits to (the platform terms changed since the quote), the fee recipient differs, or the launch key's signature does not cover this dev pseudonym. | Call `create_token` again (a new salt, order and proof). |
| `NotDev()` | Only the token's dev pseudonym may do this (e.g. `set_fee_recipient`). | Use it only on a token the user launched. |
| `WrongPrivacyPoolAmount()` / `NotProcessor()` / `NotPoolVault()` / `WrongAction()` | MurkFun's 0xbow adapter: the 0xbow withdrawal does not match the order. The note is unspent. | Call the tool again (a new order and proofs). If `NotProcessor()` repeats, the deployment's `privacyPoolAdapter` is wrong: tell the user. |
| `WrongPrivacyPoolAsset()` | The 0xbow note is not native BNB. | MurkFun buys only with BNB notes. |
| `CurveSoldOut()` / `curve sold out` | A buy on a curve that is sold out because its automatic graduation failed (sells to the curve still work while the market is not paused). | `graduate {token}` (retry), then buy. |
| `OutOfGas()` | The graduation a completing buy triggers ran out of gas. | Call the tool again; its completing-buy quote includes the graduation gas. |
| `GraduationBlocked()` | Every DEX venue refused the graduation. | Retry later; tell the user. |
| `NotGraduated()` | Tokens leave MurkFun only after graduation. | Keep them, or sell. |
| status `reverted` | The state changed between simulation and inclusion. | `status`, then call the tool again. |

**5. The privacy pool** (0xbow or Railgun, not MurkFun):

| Message / situation | Meaning | Do |
|---|---|---|
| `WAITING_FOR_ASP` | 0xbow's ASP has not approved the deposit yet; nothing was spent. It can take hours or much longer. | Poll `status` every 5–10 min (not more often) and tell the user, or pay from Railgun instead (`buy` without `source`). After 24 h, 0xbow may have declined it: the user can exit through 0xbow's own app (ragequit, back to the deposit address). |
| `ASP leaves do not match the latest on-chain root` | 0xbow's API is behind the chain. | Retry in a few minutes. |
| `PoolVault_…` (e.g. `PoolVault_NullifierAlreadySpent()`, `PoolVault_InvalidASPRoot()`) | 0xbow's contracts refused the withdrawal: the note was spent meanwhile, or a root moved. | `status` (it re-reads the notes on chain), then call the tool again. |
| `PrivacyPoolPaidLess(expected, received)` | 0xbow paid MurkFun less than the proof's amount (a 0xbow withdrawal fee). The note is unspent. | Tell the user; Railgun (`buy` without `source`) still works. |
| Railgun: the shielded BNB cannot be spent yet | Railgun holds every new shield in a standby of about an hour (Private Proofs of Innocence). | Wait; nothing to retry on MurkFun's side. |
| Railgun: the adapter call reverted | The price, the cap, the pseudonym's nonce or the order's deadline stopped the buy, or the unshield did not deliver exactly the order's amount (`WrongUnshieldAmount`: Railgun's fee changed) or was not bound to this order (`NotBoundToOrder`), so the whole transaction reverted and nothing was unshielded. | Call `buy source=railgun` again for a fresh order and amounts. |

The relayer's error codes with their HTTP status: [RELAYER_API.md](RELAYER_API.md#errors).

## 8. Protocol reference (for implementers)

Every action is a signed order ([SIGNED_ORDERS.md](SIGNED_ORDERS.md) has the full specification):

```
S1        = wallet's EIP-712 signature of MurkFunSeed {purpose: "MurkFun seed: only sign this on MurkFun"}
            domain {name: "MurkFun Order", version: "1", chainId: 56}; signed once, deterministic, low-s
secret    = Poseidon2(TAG_SECRET, S1.r, S1.s)                     (128-bit limbs)
pseudonym = Poseidon2(TAG_PSEUDONYM, secret, token)
nullifier = Poseidon2(TAG_NULLIFIER, secret, token, nonce)        nonce = market.nonces(token, pseudonym)
order     = {action, token, amount, minOut, to, nonce, relayer, fee, deadline, holderRoot, pseudonym, nullifier}
orderHash = Poseidon2(TAG_ORDER, 56, MARKET, action, token, amount, minOut, to, nonce, relayer, fee, deadline, salt)
S2        = wallet's EIP-712 signature of OrderAuth {orderHash}   (one per order)
proof     = UltraHonk proof of circuits/order (bb 6.0.0): S1 and S2 by one key whose address is in the holder tree
            with root holderRoot; pseudonym and nullifier from S1; public inputs = holderRoot + the order fields
relay     = {relayer, fee, deadline} from GET /v1/quote?action=...[&token=&amount=[&exactOut=1]][&graduates=1]
MARKET    = factory.marketOf(token) (a launch: factory.market()); its order gate = MARKET.orders()
```

| Action (number) | `amount` / `minOut` / `to` | Sent as |
|---|---|---|
| BuyDirect (3) / BuyDirectExactOut (4) | BNB paid in / min tokens or exact tokens / – | 0xbow: relayer `privacyPoolBuy` = `MurkFunPrivacyPoolAdapter.buy(transactProof, {processor: ADAPTER, data: abi.encode(order)}, noteData, proof)` (0xbow `amountOut = amount` > fee, native asset, context = keccak(params, noteData) mod p). Railgun: relayer `railgunBuy` = `MurkFunRailgunAdapter.execute(transactions, order, proof)`: Railgun's `transact` unshields to the adapter (`adaptContract` = the adapter, `adaptParams` = keccak256(abi.encode(order))), which pays exactly what arrived into `gate.execute{value: amount}(order, proof)`. On the curve only from an allowlisted privacy pool. |
| Buy (1) / BuyExactOut (2) | BNB from the balance or most BNB / min tokens or exact tokens / – | relayer `buy` / `buyExactOut` = `gate.execute(order, proof)` |
| Sell (5) | tokens / min BNB / – | relayer `sell` |
| WithdrawBnb (6) | BNB / – / recipient | relayer `withdrawBnb` |
| WithdrawTokens (7) | tokens / most tokens sold for the fee / recipient | relayer `withdrawTokens` (after graduation) |
| Fund (8) | BNB paid in / – / – | Railgun: relayer `railgunFund` = `MurkFunRailgunAdapter.execute` (its unshield pays `gate.execute{value: amount}(order, proof)`); after graduation also any address calling `gate.execute{value: amount}(order, proof)` |
| SetDevRecipient (9) | – / – / new recipient | relayer `setDevRecipient` (dev pseudonym only) |
| Launch (10) / LaunchExactOut (11) | creator buy paid in (0 = none) / min or exact tokens / dev fee recipient | `gate.launch{value: amount}(TokenSpec{name, symbol, metadataURI, devFeeRecipient, devSalt, launchSig}, order, proof)`: relayer `launch` (no creator buy, sponsored), `privacyPoolLaunch` (0xbow: `MurkFunPrivacyPoolAdapter.launch(spec, transactProof, params, noteData, proof)`), or `railgunLaunch` (Railgun: `MurkFunRailgunAdapter.launch(spec, transactions, order, proof)`). `order.token` = `factory.predictTokenAddress(name, symbol, uri, recipient, devSalt)` (CreateX CREATE3; commits to all of them and the current terms, the dev limit included); `devSalt` = a one-time launch key's address (20 bytes) + 12 free bytes; `launchSig` = that key's signature of `factory.launchDigest(token, pseudonym)`. |

Holder tree: depth 26 (2^16 batches of 2^10 leaves, leaf = Poseidon2(address)), rebuilt from MurkFunHolderRoots' `Batch` events (each carries its address list and subtree root); `acceptedRoot()` is the latest usable root. 0xbow trees: state leaves = snapshot + `LeavesInserted` logs of the PoolVault; keystore leaves = snapshot + keystore leaf logs; ASP leaves from 0xbow's API, which must match `latestASPRoot()`.

Relayer HTTP API: [RELAYER_API.md](RELAYER_API.md) (every route, order type and field, fees, deadlines, error codes). Relayed signed orders: `privacyPoolBuy, privacyPoolLaunch, railgunBuy, railgunFund, railgunLaunch, buy, buyExactOut, sell, withdrawBnb, withdrawTokens, setDevRecipient` (Railgun-paid orders: the relayer checks that every Railgun transaction is a NORMAL WBNB unshield to MurkFun's Railgun adapter bound to the order and that the adapter is on the factory's allowlist; Fund orders a plain wallet pays after graduation are sent by that wallet). Sponsored (no fee, rate-limited): `launch` (no creator buy), `graduate, collectLpFees, claimDevFees`. `GET /v1/quote` with the token and the amount (BNB offered, or tokens with `exactOut=1`) detects a buy that completes the curve and quotes its `completing-buy` gas class. The relayer sends every order to the order gate of the token's own market (`factory.marketOf(token).orders()`) and LP collection to its own locker. Trades are sent to private endpoints only. `broadcast_failed` (every private endpoint refused: nothing sent, nonce released), `overloaded` and an unreachable relayer are safe to resubmit with the identical order, as is an order whose status is `dropped`.
