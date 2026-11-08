---
name: murkfun
description: Set up and operate MurkFun (private meme-token launchpad on BNB Chain, paid from a privacy pool: 0xbow Privacy Pools by default, or Railgun) for the user. Covers installing the local `murkfun` MCP server from its GitHub release, the SPACE ID Agent ID requirement (from the Binance Agentic Wallet), the Binance Agentic Wallet CLI (`baw`) as the signer, wallet-signed orders (no registration), buying any amount, selling and withdrawing, recovery from the wallet, ASP waits and secret handling. Use when the user wants to set up MurkFun or buy/sell/withdraw/launch a MurkFun token.
---

# MurkFun

MurkFun lets the user trade meme tokens on BNB Chain (BSC) under a separate pseudonym per token. You operate it with the tools of the local `murkfun` MCP server. Every action is an order the user's wallet signs (one signature per order; the signature request shows only an opaque hash); the server proves locally that the signer holds a SPACE ID Agent ID without saying which one, and sends only the signed, proved order to the MurkFun relayer. The wallet never sends a MurkFun transaction and there is no registration. The server keeps every secret in an encrypted vault on this machine. Holdings sit in the MurkFun contract under a pseudonym that is different for every token.

This file is self-contained: an agent that can run shell commands (Claude Code, Codex, Cursor and similar) can go from nothing to a first trade with it. A chat-only assistant cannot: it has no shell and no MCP tools. The same steps for people: https://murk.fun/docs. The APIs: https://murk.fun/docs/api.

**Network values.** The MCP package ships MurkFun's contract addresses, relayer URL and API URL in its `networks/bsc.json` (`murkfun-mcp network` prints them). A value shown there as `<...>` must come from the user (`MURKFUN_RELAYER_URL`, `MURKFUN_DEPLOYMENT`); the server does not start without it. Never invent one.

## Hard rules

1. **Never move secrets.** Do not ask the user for, print, summarise, or send anywhere (chat, web, issue, log, other tools) the vault seed, the wallet private key, a signature of the MurkFun seed message, the passphrase or its file, the recovery file contents, or the vault file contents. No MurkFun tool returns them. `export_recovery` writes them to a local file and returns only the path. Do not `cat`/read that file, a signature file or `~/.murkfun/passphrase`, upload them, or attach them.
   The user's pseudonyms come from the wallet signing the MurkFun seed message ("MurkFun seed: only sign this on MurkFun"). That signature is as secret as a private key: tell the user never to sign that message (or any MurkFun typed data) on any website or for anyone else: a site asking for it is phishing, and the seed signature can spend the user's 0xbow notes. Each order needs one more signature from the wallet, for that order only.
2. **Confirm before spending real money.** Before each `deposit`, `fund_pseudonym`, `buy`, `sell`, `withdraw_bnb`, `withdraw_token`, `create_token` or `set_fee_recipient`, tell the user the amount, token and destination and wait for an explicit OK, unless they already authorised that exact action. Never raise `slippageBps` above the default (300 = 3%) without their consent.
3. **Never overwrite a vault.** If `setup` reports an existing vault, use it. If the passphrase is wrong, fix the configuration; never delete `~/.murkfun/vault.json`.
4. **One action at a time.** Do not run MurkFun tools in parallel. Wait for each result.
5. **Privacy is best-effort.** The deposit into a privacy pool is public, and the set of 0xbow users on BSC is small. Remind the user that timing and amounts can link actions, and that withdrawal addresses and a dev fee recipient are public. Plain advice to pass on: deposit round amounts (0.5, 1 or 5 BNB) so the deposit looks like many others; wait a while after depositing before buying; do not buy exactly the amount you deposited. Also tell the user what MurkFun's servers and the RPC see: MurkFun's relayer sees the IP address of every order, and by default the MCP asks MurkFun's holder-set API for the wallet's path from the same IP, so MurkFun can link the wallet and its pseudonyms by IP unless the user sets `MURKFUN_HOLDERS_API=` (empty) and uses Tor or a VPN; the RPC (`MURKFUN_RPC`) sees the wallet's and the pseudonyms' reads together (their own node avoids that).
6. **Withdraw only to an address the user gives you**, and suggest a fresh one. `MURKFUN_WITHDRAW_ALLOWLIST` limits destinations (unset: only the user's own wallet; `destination_not_allowed`): sending to the user's own wallet links the pseudonym to it in public (the result says so in `destination.privacy`), so for privacy the user adds a fresh address to `MURKFUN_WITHDRAW_ALLOWLIST` in the MCP server's environment and restarts it. Only the user does that. Destinations where funds are lost (MurkFun's own contracts, any MurkFun token, WBNB, burn addresses) are refused by the tools (`bad_recipient`), whether the contracts refuse them too (`MurkFunFactory.isBlockedRecipient`, `BadRecipient`) or accept them; ask the user for another address. A contract destination is refused with `recipient_is_contract` until the user confirms the contract is theirs and can move the funds (a Safe can; a token or a pool cannot); only then call again with `confirmContract: true`. Never set it on your own. The same applies to `create_token`'s `devFeeRecipient` and to `set_fee_recipient`.

## Who can trade: SPACE ID Agent ID holders

MurkFun accepts orders only from wallets that hold a **SPACE ID Agent ID** (an `.ai` Agent ID: ERC-721 "SPACE ID Agent ID" on BSC, `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`). It is soulbound and one per wallet. **MurkFun cannot mint it**: the user claims it in the **Binance Agentic Wallet** (Binance App → Wallet → AI agent / Agent ID; free apart from the BNB network fee). So the wallet MurkFun uses is normally the user's Binance agent wallet, and the MCP drives it through the Binance Agentic Wallet CLI `baw` (that wallet has no private key to export).

New Agent ID holders join MurkFun's **holder set** without doing anything: MurkFun's holder-set operator adds them in batches, and one batch per hour, usable once its challenge period (currently 1 h) has passed. `status` shows `holderSet.inAcceptedRoot`; until it is true, orders are refused before anything is signed (`NOT_A_HOLDER_YET` / `NOT_ACCEPTED_YET`). The MCP gets the wallet's place in the holder set from MurkFun's holder-set API (https://murk.fun) and checks the proof itself and against the chain, so the API is never trusted. If the API is down, it reads the holder set from the chain's logs, which needs an RPC that serves `eth_getLogs`; the default RPC does.

## 1. Install (once, on the user's machine)

Needs Node ≥ 20 (`node -v`). No sudo with a user-level npm prefix (nvm, or `npm config set prefix ~/.local`). Everything goes under `~/.murkfun`.

```bash
npm install -g https://github.com/murkfun/murkfun-mcp/releases/latest/download/murkfun-mcp.tgz
murkfun-mcp init
```

The same command updates it to the latest release. From source instead: `git clone https://github.com/murkfun/murkfun-mcp && cd murkfun-mcp && npm ci && npm run build && npm link`.

`init` creates `~/.murkfun` (mode 0700) and a random passphrase file `~/.murkfun/passphrase` (mode 0600) if none exists (an existing one is kept), downloads the 0xbow circuits and Barretenberg's `bb` 6.0.0 (the order prover; skipped when `bb` 6.0.0 is on the PATH or `MURKFUN_BB` names it) and checks their sha256, and prints the MCP client config. It is safe to run again. Tell the user to keep a copy of the passphrase offline (they open the file themselves; you never read it): encrypted backups are useless without it.

If the user gave you a relayer URL or a deployment file (see **Network values** above), export them first so the printed config already contains them:

```bash
export MURKFUN_RELAYER_URL='<from the user>' MURKFUN_DEPLOYMENT='<path to deployment.json, from the user>'
```

## 2. Connect the MCP server to your client

Print the config again at any time:

```bash
murkfun-mcp config claude-code   # a `claude mcp add murkfun --scope user ...` command
murkfun-mcp config json          # {"mcpServers": {"murkfun": {command, args, env}}}
```

The config starts the installed `murkfun-mcp` command. If the client cannot find it (a client started without the shell's PATH, common with nvm), add `--absolute` (`murkfun-mcp config json --absolute`): node and the script by absolute path.

- **Claude Code:** run the printed `claude mcp add ...` command.
- **Cursor / Claude Desktop / others with `mcpServers` JSON:** merge the JSON into `~/.cursor/mcp.json` or `claude_desktop_config.json`.
- **Codex:** add the same values to Codex's `config.toml` (`$CODEX_HOME/config.toml`; without `CODEX_HOME`, the hidden Codex folder in the home directory):
  ```toml
  [mcp_servers.murkfun]
  command = "<command from the JSON>"   # murkfun-mcp
  args = [<args from the JSON>]          # none, or the script path with --absolute
  env = { MURKFUN_PASSPHRASE_FILE = "<...>", MURKFUN_RELAYER_URL = "<...>", MURKFUN_DEPLOYMENT = "<...>" }
  ```

**Binance Agentic Wallet (the usual case).** Install and sign in to the CLI, then tell the MCP to use it:

```bash
npm install -g @binance/agentic-wallet   # the `baw` CLI
baw auth signin                          # the user scans the QR code with the Binance App
baw wallet agent-id --json               # claimed: true?  If not: Binance App → Wallet → AI agent / Agent ID
baw wallet settings --json               # devMode.enabled must be true (see below)
```

Add `MURKFUN_SIGNER=baw` to the MCP server's `env` (and `MURKFUN_BAW_PATH=<path>` if `baw` is not on the server's PATH; `MURKFUN_BAW_ACCOUNT=0x…` only if the agent wallet has several BSC addresses). MurkFun signs every order through `baw sign-message` and sends the 0xbow deposit through `baw contract-call`, which need **Developer Mode**: the user turns it on in the Binance App (Agentic Wallet management page → Settings → Developer Mode, confirm the risk warning); it lasts 7 days and each use extends it. You never read `baw`'s session files.

Replace any `<...>` value with the one the user gives you; never invent it. MCP clients load servers at start: ask the user to restart the session, then check that the `murkfun` tools (`setup`, `status`, …) are available. Your client has no MCP support? Use the same tools as shell commands (next section).

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
3. **The HTTP APIs underneath** ([Endpoints](#endpoints)). The read API (https://murk.fun/docs/api: launches, prices, trades, holders,
   candles) needs no keys: read market data from it directly. The relayer API (https://murk.fun/docs/api) accepts only
   wallet-signed, proved orders, and the proofs need the user's seed signature and 0xbow note secrets: use it only
   through a client that makes the proofs locally. `murkfun-mcp` is the reference client. Never send a seed, a key, a seed-message
   signature, the passphrase or a recovery file to any server.

The CLI needs the same environment as the MCP server: the `env` block of `murkfun-mcp config json` (at least
`MURKFUN_PASSPHRASE_FILE`; `MURKFUN_SIGNER=baw` for the Binance Agentic Wallet). The install in step 1 puts
`murkfun-mcp` on the PATH. Hard rule 4 applies to it too: one command at a time, wait for each result.

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
| Deposit into 0xbow | `deposit` | `murkfun-mcp deposit --amountBnb 1` | wallet transactions to 0xbow Privacy Pools (its keystore once, then the deposit) |
| Launch a token (create + your first buy) | `upload_token_metadata`, `create_token` | `murkfun-mcp create_token --name … --symbol … --metadataURI … --devFeeRecipient 0x… --bnbAmount 0.5` (exact out: `--buyTokens cap`) | one signed Launch order: relayer order `privacyPoolLaunch` (paid from a 0xbow note; `source=railgun`: relayer order `railgunLaunch`, paid by a Railgun unshield to MurkFun's Railgun adapter, sent with `submit_railgun`) |
| Launch without a buy | `create_token` (no `bnbAmount` / `buyTokens`) | `murkfun-mcp create_token --name … --symbol … --metadataURI … --devFeeRecipient 0x…` | a signed Launch order: relayer order `launch` (sponsored) |
| Buy from a 0xbow note | `buy` | `murkfun-mcp buy --token 0x… --bnbAmount 0.1` (exact out: `--tokens 1000000` or `--tokens cap`; quote: `--dryRun`) | a signed BuyDirect order: relayer order `privacyPoolBuy` (through MurkFun's 0xbow adapter) |
| Buy from Railgun | `buy` (`source=railgun`) | `murkfun-mcp buy --token 0x… --bnbAmount 0.1 --source railgun` | a signed BuyDirect (exact out: BuyDirectExactOut) order, the Railgun transaction to build for it (an unshield to MurkFun's Railgun adapter, bound to the order) and `relay`; then relayer order `railgunBuy` via `submit_railgun` |
| Send a Railgun-paid order | `submit_railgun` | `murkfun-mcp submit_railgun --transactionsFile railgun-txs.json` | relayer order `railgunBuy` / `railgunFund` / `railgunLaunch` (`relay.body` + the proved Railgun transactions); the sender on chain is the relayer |
| Buy from the internal balance | `buy` (`source=balance`) | `murkfun-mcp buy --token 0x… --bnbAmount 0.1 --source balance` | relayer order `buy` (exact out: `buyExactOut`) |
| Sell | `sell` | `murkfun-mcp sell --token 0x… --percent 50` | relayer order `sell` |
| Withdraw BNB | `withdraw_bnb` | `murkfun-mcp withdraw_bnb --token 0x… --to 0x…` | relayer order `withdrawBnb` |
| Withdraw tokens | `withdraw_token` | `murkfun-mcp withdraw_token --token 0x… --to 0x…` | relayer order `withdrawTokens` |
| Fund a pseudonym | `fund_pseudonym` | `murkfun-mcp fund_pseudonym --token 0x… --amountBnb 0.5` | a signed Fund order: relayer order `railgunFund` (a Railgun unshield, sent with `submit_railgun`); after graduation also calls any wallet can send |
| Claim fees | `claim_lp_fees` | `murkfun-mcp claim_lp_fees --token 0x…` | relayer orders `collectLpFees` + `claimDevFees` (sponsored, no signature: anyone may trigger them) |
| Change the dev fee recipient | `set_fee_recipient` | `murkfun-mcp set_fee_recipient --token 0x… --recipient 0x…` | relayer order `setDevRecipient` |
| Retry a graduation | `graduate` | `murkfun-mcp graduate --token 0x…` | relayer order `graduate` (sponsored) |
| Market data | `list_launches`, `token_info` | `murkfun-mcp list_launches --limit 20` | read API (or the chain); your balances always from the chain |
| Order status | `order_status` | `murkfun-mcp order_status --id …` | `GET /v1/orders/:id` |
| Back up | `backup`, `export_recovery` | `murkfun-mcp backup --path …`; `murkfun-mcp export_recovery --path … --confirm` | local files |
| Restore | `restore`, `recover_from_wallet`, `recover` | `murkfun-mcp restore --path …`; `murkfun-mcp recover_from_wallet` | local vault + chain reads |

## 3. Add this skill

This file ships in the package you installed (`skills/murkfun/SKILL.md`, the same release you checked against `SHA256SUMS`) and is also published at https://murk.fun/skill.md. Claude Code: `mkdir -p ~/.claude/skills/murkfun && cp "$(npm root -g)/murkfun-mcp/skills/murkfun/SKILL.md" ~/.claude/skills/murkfun/SKILL.md` (or `curl -fsSL https://murk.fun/skill.md -o ~/.claude/skills/murkfun/SKILL.md`, the same file without the release's checksum). Other clients: keep this file where the client reads project or user instructions (for example `AGENTS.md`), or just keep following it.

## 4. First run

1. `setup` → creates the encrypted vault and returns the public **wallet** address and `agentNft` (does it hold a SPACE ID Agent ID). If it does, the wallet signs the MurkFun seed message once (twice, to check the signer is deterministic): every pseudonym, the 0xbow keys and every note come from that signature, so **the wallet is the backup.** Nothing is sent and nothing is registered.
   - **Binance Agentic Wallet (recommended; it is where the Agent ID lives):** `setup {signer: "baw"}` (or just `setup` with `MURKFUN_SIGNER=baw`). The wallet is the address from `baw wallet address`. There is no key to save: the Binance account is the backup (`export_recovery` has nothing to export). Note for the user: the agent wallet signs on Binance's side. Binance holds its key, so Binance can compute the user's MurkFun pseudonyms and link all of the user's MurkFun activity to the Binance account; the proofs hide the wallet from other users and chain observers, not from Binance (and MurkFun's servers see the user's IP address: rule 5). The MCP sends each order a random 30 s to 3 min after its signature, which makes timing correlation by chain observers harder.
   - New wallet made here (no arguments, local signer): its key is the only thing to save. Run `export_recovery {path, confirm:true}` (a plaintext file holding the wallet key, written only inside `MURKFUN_HOME` or the user's `MURKFUN_EXPORT_DIR`; the tool returns only the path) and tell the user to move it offline (USB stick, paper, password manager; never a synced folder, email or chat) and delete it from this machine. `backup {path}` adds an encrypted copy of the vault. It can trade only if it holds a SPACE ID Agent ID.
   - The user's existing wallet: `setup {walletKeyFile: "<path>"}` (the key is read from the file, never through the chat).
2. If `agentNft` is false: the user claims a SPACE ID Agent ID for that wallet in the Binance Agentic Wallet (Binance App → Wallet → AI agent / Agent ID), then you call `setup` again (it signs the seed message then). Do not try to mint it; nothing else works.
3. `status` until `holderSet.inAcceptedRoot` is true. A new Agent ID holder is added by the holder-set operator's next batch and can trade once that batch's challenge period (currently 1 h) has passed, so usually within about 2 h; tell the user, and check again within the hour. Meanwhile the deposit (next) can already be made.
4. Ask the user to send BNB to **wallet**: the amount they want to deposit plus about 0.003 BNB for the 0xbow keystore registration and the deposit's gas. This wallet is public and linked to them; it never trades.

## 5. Buy: pick one privacy pool

**0xbow Privacy Pools (default).**

1. `deposit {amountBnb}`: minimum **0.02 BNB**. Suggest a round amount (0.5, 1 or 5 BNB). Confirm first.
2. Wait for **ASP approval**: 0xbow's ASP must approve the deposit before it can pay for buys. The one measured case took ~9 minutes; it can take hours. Call `status` every 5–10 minutes (not more often) until the note shows `aspApproved: true`, and tell the user you are waiting. Waiting longer is also better for privacy. If it is still pending after 24 h, tell them 0xbow may have declined it; they can exit through 0xbow's own app (ragequit).
3. Buy: `buy {token, bnbAmount}` (source `note` is the default). One proof pays `bnbAmount` (relayer fee included; any amount above the relayer fee, no other minimum) from the smallest approved note that holds it, through MurkFun's 0xbow adapter; the change stays in 0xbow for later buys. "Buy 0.37 BNB" = `bnbAmount: "0.37"`. "Buy exactly 1,000,000 tokens" = `tokens: "1000000"` (exact out: the note pays the cost plus the slippage margin plus the relayer fee; what the buy does not spend stays in the pseudonym's internal balance). "Buy as much as I may hold" = `tokens: "cap"` (up to the holding cap, during the curve; for the dev, the dev limit). One buy spends one note: if no single note holds the amount (`NOTE_TOO_SMALL`), buy less, split it into several buys, or deposit more. Avoid spending exactly a deposit's amount; the tool warns (`privacy`).

**Railgun.**

1. `buy {token, source:"railgun", bnbAmount}` (or `tokens` for an exact-out buy) returns a proved direct-buy order that names the MurkFun relayer and its fee (`relayerFeeBnb`, paid out of the unshielded BNB like a 0xbow buy), and sends nothing itself. Confirm the amount first.
2. The user builds the Railgun transaction in a Railgun wallet or with the Railgun SDK that can bind a custom adapt ID: an unshield (type NORMAL) of `railgun.unshield.amountWei` WBNB to `railgun.adapter` (MurkFun's Railgun adapter), with the adapt ID contract `railgun.adaptContract` and parameters `railgun.adaptParams` (Railgun engine: `setAdaptID({contract, parameters})`) and `minGasPrice` 0, and generates its proof. Railgun charges 0.25% on shield and on unshield; exactly `railgun.unshield.arrivesWei` arrives. Do not hand it to a Railgun broadcaster (they relay only Railgun's own contracts).
3. `submit_railgun {transactions}` (the proved Railgun transactions as JSON, or their calldata; CLI: `murkfun-mcp submit_railgun --transactionsFile <file>`) checks them against the order and posts `relay.body` with them to the MurkFun relayer, then waits like any order. If it is still pending when the wait ends, poll `order_status`: once that reports `dropped` or `reverted` (not executed, the Railgun notes unspent), `submit_railgun` with the same `id` and transactions sends the same order again. The relayer simulates and sends the adapter's call: **the sender on chain is the shared MurkFun relayer**, so no wallet of the user pays gas or appears on chain (buys of one token still share its pseudonym; amounts, timing and IP can be correlated). MurkFun accepts Railgun BNB only through its adapter: Railgun's public RelayAdapt cross-contract calls are refused. All of it is paid into MurkFun for the pseudonym; the buy spends up to the amount minus the relayer fee, and BNB it does not need (an exact-out buy's margin, the rest of a buy that completes the curve) stays in the pseudonym's internal balance. The rest of the Railgun balance stays shielded. If the price or the cap would stop the buy, the whole transaction reverts and nothing is unshielded.
4. Do not trade that token before it lands (the proof binds the current nonce and a deadline: `validMinutes`, default 30); if it went stale, call `buy source=railgun` again.

Alternative without the relayer: the adapter call is permissionless, so any account can send it (`railgun.submit`: `execute` with the transactions, the order and its proof); that account pays the gas and is public as the sender. `selfSubmit: true` signs the order without a relayer fee for that. `fund_pseudonym` and `create_token` with `source=railgun` work the same way (relayer orders `railgunFund`, `railgunLaunch`).

**A plain wallet.** During the curve, while the factory's privacy-funding rule is on (`status.privacyFunding`; the owner can change it through the 24 h timelock), MurkFun only accepts BNB from privacy pools through its own adapters (0xbow through MurkFun's 0xbow adapter, Railgun through MurkFun's Railgun adapter): it rejects BNB from a plain wallet (`PrivacyPoolRequired`), and `fund_pseudonym` then returns only the Railgun transaction (`privacyRule` explains). After graduation the token also trades publicly on PancakeSwap: `fund_pseudonym {token, amountBnb}` returns calls any wallet can send (the sender is public); then `buy {token, source:"balance", bnbAmount}`.

## 6. Trade and cash out

- Look first: `list_launches`, then `token_info {token}` (status, price, curve progress, and the DEX `venue` after graduation).
- Buy: as in §5, or from sale proceeds with `buy {token, source:"balance", bnbAmount | tokens}`. `buy {…, dryRun: true}` quotes without proving or sending anything: expected tokens, relayer fee, and whether the buy completes the curve.
- Sell: `sell {token, percent | amount}`. Proceeds stay inside MurkFun as an internal BNB balance for that token.
- Withdraw BNB: `withdraw_bnb {token, to}` at any time while the market is not paused.
- Withdraw tokens: `withdraw_token {token, to}`, only after graduation.
- Graduation is automatic: a buy larger than what is left on the curve fills the rest (the completing buy) and graduates the token into PancakeSwap in the same transaction. It pays that graduation gas, so its relayer fee is a completing-buy fee, much higher than a standard buy's: the result's `relayerFee` shows both (`gasClass: "completing-buy"`, `feeBnb`, `standardBuyFeeBnb`); tell the user before a buy that `dryRun` reports with `completesCurve: true`. BNB the completing buy does not need stays in the pseudonym's internal balance (`unspentBnb`; `withdraw_bnb` or `buy source=balance`). Once mined the result shows `curveCompleted` and `graduation`. `graduate {token}` is only the retry, when that automatic graduation failed (`graduation.graduated: false`, or `curveProgressPct` 100 but not graduated). After graduation trades route to the token's PancakeSwap venue automatically.
- Before graduation one pseudonym may hold at most 1% of supply (the dev up to the platform's dev limit, 30%). There is no cap after graduation. If the automatic graduation fails, buys wait until someone calls `graduate`; sells still work.
- Before every buy or sell, tell the user the amount, the expected fill, the slippage limit and the relayer fee (`dryRun` gives them for a buy).
- A broadcast the relayer could not make sent nothing, and an order it dropped was not executed: the MCP resubmits the identical order by itself (up to `MURKFUN_ORDER_RETRIES` times; a proof can never execute twice). `attempts` in a result counts the submissions.

## Launching a token

**Launching a token for the user.** Ask for anything missing among: name (≤ 64 chars), symbol (≤ 16), a one-line description, an image (a local file or an https link; PNG/JPEG/WebP/GIF, ≤ 1 MB, no SVG; square, 256–1024 px: MurkFun does not crop or resize it, so if the tool refuses it as `not_square` / `bad_size`, ask the user for a square version or crop it with a local tool you have), the address that receives dev fees, how much BNB to buy with (creating a token is the user's first buy; none = create only; ask, do not assume), and optionally links (website / X / Telegram / Discord / GitHub, https only) and a vanity ending for the address (1–5 hex characters, e.g. `c0de`; optional). Then:

1. `upload_token_metadata {name, symbol, description, imagePath | imageUrl, links}` uploads the image and the metadata to IPFS, pinned by MurkFun (no pinning account needed; the server strips the image's EXIF / GPS and other metadata), and returns `metadataURI`, the image's URL and a `preview` of the exact document. Show the user the preview and the image URL. name and symbol must be exactly what you pass to `create_token`. The upload shows the user's IP address to MurkFun's server; if the user does not want that, they can pin the files themselves (the image, then a JSON document `{"schema": "murkfun-token-metadata/v1", "name", "symbol", "description", "image": "ipfs://<image CID>", "links": {…}}`, at most 16 KB, name and symbol exactly as passed to `create_token`) and give you the document's `ipfs://` URI, or launch with an empty `metadataURI` (the site shows the default avatar).
2. Never invent, guess or edit a CID: use only the `metadataURI` the tool returned (or one the user pinned). The metadata can never change after launch (the URI is part of the token's address, with the name, symbol and fee address).
3. Confirm name, symbol, metadataURI, fee address and the BNB amount of the first buy with the user, then call:

`create_token {name, symbol, metadataURI, devFeeRecipient, bnbAmount?, buyTokens?, vanitySuffix?}` makes the user's pseudonym for that token the dev.

**Creating a token is one signed Launch order, and your first buy.** `bnbAmount` (BNB to spend, exact in) or `buyTokens` (exactly that many tokens; `"cap"` = up to the dev limit) buys in the same transaction that creates the token, so nobody can buy before the dev; without either, the token is created with no buy. The dev may hold up to 30% of supply on the curve: the platform's dev limit, fixed in the token's terms at launch (the dev does not set it; it is never below the 1% holder cap). While the factory's privacy-funding rule is on, the buy is paid from a privacy pool like any curve buy: `source: "note"` (default) is one relayer order from a 0xbow note, with one relayer fee for the creation and the buy; `source: "railgun"` returns the Railgun transaction to build (an unshield to MurkFun's Railgun adapter, then its `launch`), as `buy source=railgun` does. The first buy is the first trade on a fresh curve, so its result is exact (`creatorBuy`: tokens, cost, fee); `dryRun: true` shows it first. Ask the user for the amount; confirm it with the rest. With `vanitySuffix` the tool searches a salt so the address ends with it (4 characters take seconds; 5 can take a minute). The token keeps the platform's fees and caps of the moment it launches. The `devFeeRecipient` address is public. `claim_lp_fees {token}` pays out curve fees and post-graduation fees (anyone may trigger it): on PancakeSwap Infinity the 1% BNB fee every trade pays (the LP is burnt), on the v3 / V2 fallback the locked LP's fees in BNB + token. `set_fee_recipient {token, recipient}` needs a small internal BNB balance on that token for the relayer fee.

## Tools

`setup` · `recover_from_wallet` · `backup` · `export_recovery` · `restore` · `recover` · `deposit` · `status` · `holders_lookup` · `list_launches` · `token_info` · `buy` · `fund_pseudonym` · `submit_railgun` · `sell` · `withdraw_bnb` · `withdraw_token` · `graduate` · `order_status` · `upload_token_metadata` · `create_token` · `claim_lp_fees` · `set_fee_recipient`. All return JSON; amounts are decimal strings (`"0.37"`). Trading tools take `slippageBps` (default 300). Each is also a shell command: `murkfun-mcp <tool> --arg value` (`murkfun-mcp tools` lists them with their JSON Schemas).

## Endpoints

The values the MCP uses are in its bundled `networks/bsc.json`; `murkfun-mcp network` prints them (`indexerUrl`, `relayerUrl`). Full schemas: https://murk.fun/docs/api.

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

## Errors you will see

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
| `NOTE_TOO_SMALL` / `no unspent 0xbow note` | No single 0xbow note holds that much (the message lists the notes). | Buy at most the largest note, split into several buys, or `deposit` more (ask first). |
| `OVER_CAP` | The buy would cross the holding cap (1% of supply per pseudonym on the curve; for the dev, the platform's dev limit of 30%). | Buy less (the message says how much more is allowed; `tokens: "cap"` buys exactly up to it), or wait for graduation. |
| `MARKET_PAUSED` | MurkFun's emergency pause is on (read on chain): every MurkFun action waits (launches, buys, sells, funding, graduation, `withdraw_bnb`, `withdraw_token`, fee claims). Balances and holdings stay where they are. | Tell the user; retry after the guardian unpauses (`status` shows `marketPaused`). Do not retry in a loop. LP fee collection on a graduated pool is not paused. |
| `PRIVACY_POOL_REQUIRED` | During the curve the BNB must come from a privacy pool on MurkFun's allowlist, and the one asked for is not on it. | `buy` from a 0xbow note (`source: "note"`); a plain wallet can fund after graduation. `status` shows `privacyFunding`. |
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
| `relayer_deadline_out_of_range` / `relayer_mismatch` | The relayer quoted a deadline outside 60 s – 10 min from now (`MURKFUN_MAX_ORDER_VALIDITY_S`, default 600 s), or named another relayer address than the pinned one (`MURKFUN_RELAYER_ADDRESS`, else the first it answered with). Nothing was signed or sent. | Tell the user; the relayer is faulty or hostile: do not retry against it. |
| `validity_too_long` | `validMinutes` is above `MURKFUN_MAX_ORDER_VALIDITY_S` (at least 30 min). Nothing was signed or sent. | Use the default validity or a shorter one. |
| `destination_not_allowed` | The withdrawal or fee recipient is not in `MURKFUN_WITHDRAW_ALLOWLIST` (unset: only the user's own wallet). Nothing was signed or sent. | Ask the user; only the user changes the allowlist. |
| `bad_recipient` | The destination is a MurkFun contract, a MurkFun token (the token itself included), WBNB, MurkFun's 0xbow / Railgun adapter, Railgun's RelayAdapt, a burn or system address, or anything else `MurkFunFactory.isBlockedRecipient` names: the funds would be lost or stuck there. Nothing was signed or sent. | Ask the user for an address they control; `confirmContract` does not override it. |
| `recipient_is_contract` | The destination is a contract, not a plain wallet. Nothing was signed or sent. | Ask the user whether the contract is theirs and can move the funds; only then call again with `confirmContract: true`. |
| `WRONG_CHAIN` / `ROOT_MISMATCH` | The RPC is not BSC, or `MURKFUN_RPC` and `MURKFUN_RPC_CHECK` disagree on the holder root. Nothing was signed or sent. | Check the RPC settings; retry later. |
| `NO_LOG_RPC` | The holder-set API gave no usable proof (down, or its proof failed the checks), and no configured RPC serves `eth_getLogs` over the holder set's history. The message names each RPC and why. Nothing was signed or sent. | Retry later; if it persists, set `MURKFUN_RPC` (or `MURKFUN_LOG_RPCS`) to a BSC RPC that serves `eth_getLogs` over old blocks (not `bsc-dataseed`). |
| status `dropped` | The relayer cancelled its transaction (not mined in time); it was not executed. The MCP resubmits the identical order by itself; a result still `dropped` used every retry. | Retry later. |
| `relayer_underfunded` / `unavailable` / `misconfigured` / `internal` | A problem on the relayer's side. | Retry later (`internal`: check `order_status` if an id was returned); tell the user if it persists. |
| `rate_limited` | Too many requests or orders from this IP address. | Wait a minute. |
| `unknown_token` | Not a MurkFun token. | Check the address. |
| `simulation_failed: <Error>()` | The contract would revert, so the relayer sent nothing. | Look `<Error>` up in table 4. |
| `order_expired: Expired()` | The order's deadline is already behind the chain's time. The MCP sets every deadline (orders, quotes, Railgun calls, launches) from the latest block's time, never from the local clock, so this means the RPC serves a stale chain head or the order waited too long. Nothing was spent. | Retry; if it repeats, set `MURKFUN_RPC` to another RPC. |
| `not_square` / `bad_size` | `upload_token_metadata`: the image is not square, 256–1024 px. | Ask the user for a square version, or crop it with a local tool. |
| `upload rate limit reached` / `content_blocked` / `uploads API unreachable` | The upload API's per-IP limit, refused content, or no answer. | Wait a minute; for refused content, ask the user for other content. They can also pin the files themselves ([Launching a token](#launching-a-token), step 1). |

**4. The chain: MurkFun contract reverts** (as `simulation_failed: <Error>()`, an order status `reverted`, or the MCP's own simulation; nothing was spent):

| Error | Meaning | Do |
|---|---|---|
| `Slippage()` | The price moved beyond `slippageBps`. | Re-run once (it re-quotes). If it fails again, ask the user before raising slippage. |
| `CapExceeded()` | Over the holding cap (1% per pseudonym on the curve; for the dev, the platform's dev limit of 30%). | Buy less, `tokens: "cap"` / `buyTokens: "cap"`, or wait for graduation. |
| `InsufficientBalance()` | Not enough internal BNB or tokens for this pseudonym (relayer fee included). | Check `token_info`; reduce the amount. |
| `WrongNonce()` / `NullifierUsed()` / `UnknownRoot()` / `Expired()` | The pseudonym's nonce moved (another action landed first), this signed order was already used, the holder root is no longer accepted, or the deadline passed. | Call the tool again (a new order is signed and proved). |
| `InvalidProof()` | The order proof was rejected (a changed order, or a stale bundled circuit). | Call the tool again; if it repeats, reinstall `murkfun-mcp`. |
| `MarketPaused()` / `market_paused` | The emergency pause is on (the relayer answers `market_paused`). | As `MARKET_PAUSED` above. |
| `PrivacyPoolRequired()` | During the curve, BNB came from an address not on MurkFun's privacy-pool allowlist. | `buy` from a 0xbow note, or `buy source=railgun`; a plain wallet can fund after graduation. |
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
| `WAITING_FOR_ASP` | 0xbow's ASP has not approved the deposit yet. Normal; nothing was spent. | Poll `status` every 5–10 min (not more often); tell the user it can take hours. After 24 h, 0xbow may have declined it: the user can exit through 0xbow's own app (ragequit, back to the deposit address). |
| `ASP leaves do not match the latest on-chain root` | 0xbow's API is behind the chain. | Retry in a few minutes. |
| `PoolVault_…` (e.g. `PoolVault_NullifierAlreadySpent()`, `PoolVault_InvalidASPRoot()`) | 0xbow's contracts refused the withdrawal: the note was spent meanwhile, or a root moved. | `status` (it re-reads the notes on chain), then call the tool again. |
| `PrivacyPoolPaidLess(expected, received)` | 0xbow paid MurkFun less than the proof's amount (a 0xbow withdrawal fee). The note is unspent. | Tell the user; `buy source=railgun` still works. |
| Railgun: the shielded BNB cannot be spent yet | Railgun holds every new shield in a standby of about an hour (Private Proofs of Innocence). | Wait; nothing to retry on MurkFun's side. |
| Railgun: the adapter call reverted | The price, the cap, the pseudonym's nonce or the order's deadline stopped the buy, or the unshield did not deliver exactly the order's amount (`WrongUnshieldAmount`), was not a plain WBNB unshield to the adapter (`NotAWbnbUnshield`) or was not bound to it (`NotBoundToOrder`), so the whole transaction reverted and nothing was unshielded. | Call `buy source=railgun` again for a fresh order. |
| `bad_unshield` / `bad_target` / `RAILGUN_TX_INVALID` (from `submit_railgun`) | The Railgun transaction is not a NORMAL WBNB unshield to MurkFun's Railgun adapter bound to this order (`railgun.adaptContract`, `railgun.adaptParams`), or does not deliver exactly the order's amount; or the adapter is not on MurkFun's allowlist. Nothing was sent; the Railgun notes are unspent. | Build the Railgun transaction again with exactly the returned `railgun` values (if Railgun's fee changed: call the tool again for a new order). |
| `RAILGUN_ORDER_EXPIRED` | The Railgun order's deadline passed before it was submitted. Nothing was spent. | Call the tool again (a new order needs a new Railgun transaction: the adapt params change). |

## Recovery on a new machine

Put the same passphrase file at `~/.murkfun/passphrase` (mode 0600), then install as in §1–2 (`murkfun-mcp init` keeps it).

- **The wallet is the backup.** `recover_from_wallet {signer: "baw"}` for the Binance Agentic Wallet (after `baw auth signin`), or `recover_from_wallet {walletKeyFile: "<path>"}`. The same wallet signs the same seed message again, which gives the same pseudonyms and the same 0xbow notes; deposits, notes and positions are found on-chain, and the wallet is still in the holder set. Guard the wallet: whoever has its key controls the MurkFun funds.
- **From files:** `setup {recoveryFile: "<path>"}` followed by `recover`, or copy the encrypted backup into place with `restore {path}`.
