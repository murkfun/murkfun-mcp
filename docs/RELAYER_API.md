# MurkFun relayer API

The relayer takes **signed orders** from users' agents and submits them to BSC, paying the gas. It is reimbursed by the
fee written into each order. It holds no user funds and cannot change an order: every field is signed by the user's
wallet and bound by the order proof (and, for 0xbow buys, by the 0xbow proof), so an altered submission reverts on
chain. The order format and the proof are specified in [SIGNED_ORDERS.md](SIGNED_ORDERS.md).

Read this if you write your own client. **The reference client is the `murkfun-mcp` package** (this repository's root): it keeps the
secrets in an encrypted local vault, has the wallet sign each order, makes the proofs locally and builds every order
below (`src/agent.ts`). An
agent does not need to speak this API itself: it calls the MCP tools, or the same tools as shell commands
(`murkfun-mcp <tool> --arg value`, [AGENT_GUIDE.md](AGENT_GUIDE.md#how-your-agent-talks-to-murkfun)). An order is
useless without the wallet's signature and the proof, and the proof needs the user's seed signature and 0xbow note
secrets, which never leave the user's machine. Never send a wallet key, a seed-message signature or a note secret to
any server; the relayer only ever receives signed orders and proofs.

Market data (launches, prices, trades, holders) is a different, read-only API: [API.md](API.md).

- Base URL: the network's `relayerUrl` (`murkfun-mcp network`; `MURKFUN_RELAYER_URL` overrides it).
- JSON in and out. Integers (wei, token wei, proof values) are **decimal strings**; requests also accept a JSON number
  up to 2^53 or a `0x` hex string. Addresses are `0x` + 40 hex characters, bytes are `0x` hex.
- Amounts are in wei (BNB) and token wei (18 decimals).
- Errors: `{ "error": "<code>", "reason": "<text>" }` with an HTTP status ([Errors](#errors)).
- Routing: the relayer is configured with the factory and MurkFun's 0xbow adapter only and reads everything else from
  the chain. Every signed order goes to the order gate of the market the token was listed in
  (`factory.marketOf(token).orders()`; a token keeps its market for good, so it can be an older market than
  `factory.market()`), a launch to the current market's gate (`factory.market().orders()`), a 0xbow-paid order to the
  adapter, a Railgun-paid order to the Railgun adapter it names (only while the factory's privacy-funder allowlist,
  `factory.privacyFunders()`, holds it: read for every order), `graduate` / `claimDevFees` to the token's market, LP fee collection to the locker of the Dex that graduated
  the token (`market.dexOf(token)` → `dex.lockerOf(token)`).

## Which user action becomes what

Only signed orders and the sponsored actions go through the relayer. The wallet's own transactions (0xbow's keystore
registration and deposits) are sent by the wallet. A Railgun-paid order (`railgunBuy`, `railgunFund`, `railgunLaunch`)
is relayed too, once the user's Railgun wallet has built and proved the unshield for it: the relayer sends
`MurkFunRailgunAdapter.execute` / `launch`, so the sender on chain is the shared relayer, not a wallet of the user.
There is no MurkFun registration.

| User action | MCP tool | CLI | Sent as |
|---|---|---|---|
| Launch a token with your first buy (create + buy up to 30% of supply, the platform's dev limit; you do not set it) | `create_token` with `bnbAmount` / `buyTokens` (after `upload_token_metadata`) | `murkfun-mcp create_token --name … --symbol … --metadataURI … --devFeeRecipient 0x… --bnbAmount 0.5` (exact out: `--buyTokens 1000000`, or `--buyTokens cap` = up to the platform's dev cap; quote: `--dryRun`) | one signed Launch order: relayer order `privacyPoolLaunch` (one order, one relayer fee, paid from a 0xbow note); `--source railgun`: relayer order `railgunLaunch` (the tool returns the signed Launch order, the Railgun unshield to build for it and `relay`; then `submit_railgun`) |
| Launch a token without a buy | `create_token` without `bnbAmount` / `buyTokens` | `murkfun-mcp create_token --name … --symbol … --metadataURI … --devFeeRecipient 0x…` | a signed Launch order: relayer order `launch` (sponsored) |
| Buy from a 0xbow note | `buy` | `murkfun-mcp buy --token 0x… --bnbAmount 0.1` (exact out: `--tokens 1000000` or `--tokens cap`) | a signed BuyDirect order: relayer order `privacyPoolBuy` (through MurkFun's 0xbow adapter) |
| Buy from the internal balance | `buy` with `source=balance` | `murkfun-mcp buy --token 0x… --bnbAmount 0.1 --source balance` (exact out: `--tokens …`) | relayer order `buy` (exact out: `buyExactOut`) |
| Buy from Railgun | `buy` with `source=railgun` | `murkfun-mcp buy --token 0x… --bnbAmount 0.1 --source railgun` | relayer order `railgunBuy`: the tool returns a signed BuyDirect (exact out: BuyDirectExactOut) order, the Railgun unshield to build for it (to `MurkFunRailgunAdapter`, bound to the order) and `relay`; `submit_railgun --transactions …` posts it ([Railgun-paid orders](#railgun-paid-orders)) |
| Quote a buy | `buy` / `create_token` with `dryRun` | `murkfun-mcp buy --token 0x… --bnbAmount 0.1 --dryRun` | `GET /v1/quote` and chain reads only: expected tokens, relayer fee, gas class; no order is sent |
| Sell | `sell` | `murkfun-mcp sell --token 0x… --percent 100` | relayer order `sell` |
| Withdraw BNB | `withdraw_bnb` | `murkfun-mcp withdraw_bnb --token 0x… --to 0x…` | relayer order `withdrawBnb` |
| Withdraw tokens (after graduation) | `withdraw_token` | `murkfun-mcp withdraw_token --token 0x… --to 0x…` | relayer order `withdrawTokens` |
| Fund a pseudonym | `fund_pseudonym` | `murkfun-mcp fund_pseudonym --token 0x… --amountBnb 0.5` | relayer order `railgunFund` (a Railgun unshield to `MurkFunRailgunAdapter`, then `submit_railgun`); after graduation also `MurkFunOrders.execute` calls any wallet sends |
| Change the dev fee recipient | `set_fee_recipient` | `murkfun-mcp set_fee_recipient --token 0x… --recipient 0x…` | relayer order `setDevRecipient` |
| Claim fees | `claim_lp_fees` | `murkfun-mcp claim_lp_fees --token 0x…` | relayer orders `collectLpFees` (after graduation) and `claimDevFees` (sponsored) |
| Retry a graduation | `graduate` | `murkfun-mcp graduate --token 0x…` | relayer order `graduate` (sponsored; graduation is automatic, this is only for a failed one) |
| Set up | `setup` | `murkfun-mcp setup` | the wallet signs the seed message once; nothing is sent |
| Deposit into 0xbow | `deposit` | `murkfun-mcp deposit --amountBnb 1` | wallet transactions to 0xbow Privacy Pools (its keystore once, then the deposit) |
| Relay a Railgun-paid order | `submit_railgun` | `murkfun-mcp submit_railgun --transactionsFile railgun-txs.json` | `POST /v1/orders` with the `relay.body` of `buy` / `fund_pseudonym` / `create_token` (`source=railgun`) and the Railgun transactions, then `GET /v1/orders/:id` until mined |
| Order status | `order_status` | `murkfun-mcp order_status --id …` | `GET /v1/orders/:id` |
| Back up, restore, recover | `backup`, `restore`, `export_recovery`, `recover`, `recover_from_wallet` | `murkfun-mcp backup --path …` etc. | local only (`recover*` read the chain) |

**Exact in and exact out.** A buy spends an exact amount in with a minimum of tokens out (Buy / BuyDirect orders:
`amount` / `minOut`), or buys an exact number of tokens for at most a BNB amount (BuyExactOut: `minOut` tokens for at
most `amount`; BuyDirectExactOut: `minOut` tokens for at most `amount - fee`).
On the curve, quote them with `quoteBuy(token, bnbIn)` → `(tokensOut, bnbUsed, fee)` and `quoteBuyExactOut(token,
tokensOut)` → `(filled, bnbIn, fee)` on the token's market; after graduation the swap runs on the token's DEX venue.
BNB a buy does not spend stays in the pseudonym's internal balance for that token (spend it with a Buy order, take it
out with WithdrawBnb).

**The completing buy.** The buy that sells out the curve fills what is left (`quoteBuy`: `bnbUsed < bnbIn`;
`quoteBuyExactOut`: `filled < tokensOut`; `quoteBuyExactOut(token, 2^256 - 1)` = the rest of the curve and its cost)
and graduates the token in the same transaction: `CurveCompleted`, then `Graduated` (or `GraduationFailed`, after which
anyone may retry with `graduate`). That buyer pays the graduation gas: quote it in the
`completing-buy` gas class (`GET /v1/quote` below). A buy with too little gas for the graduation reverts
(`OutOfGas()`) instead of skipping it.

## Routes

### `GET /v1/info`

The relayer's address and the contracts orders are built against.

```json
{
  "relayer": "0x5b1f…c0de",
  "chainId": 56,
  "factory": "0x…",
  "market": "0x…",
  "privacyPoolAdapter": "0x…",
  "gasPriceWei": "100000000",
  "minDeadlineSecs": 60,
  "feeMarginBps": 1000,
  "sponsored": ["launch", "graduate", "collectLpFees", "claimDevFees"],
  "actions": ["privacyPoolBuy", "privacyPoolLaunch", "railgunBuy", "railgunFund", "railgunLaunch", "buy", "buyExactOut", "sell", "withdrawBnb", "withdrawTokens", "setDevRecipient", "launch", "graduate", "collectLpFees", "claimDevFees"]
}
```

- `relayer`: put it in the order's `relayer` field (an order naming another address is refused with `wrong_relayer`).
- `factory`: `MurkFunFactory` (`predictTokenAddress`, `marketOf`).
- `market`: the factory's current market (`factory.market()`), where new tokens are listed: the `market` a Launch
  order is proved for (its gate is `market.orders()`). Every other order uses the token's own market,
  `factory.marketOf(token)`.
- `privacyPoolAdapter`: `MurkFunPrivacyPoolAdapter`, the target of `privacyPoolBuy` and `privacyPoolLaunch` and the
  `params.processor` of every 0xbow withdrawal.
- `gasPriceWei`: the current gas price.
- `minDeadlineSecs`: the order's `deadline` must be at least this far in the future when the order arrives.
- `feeMarginBps`: the admission margin on top of the gas cost ([Fees](#fees-quotes-and-deadlines)).
- `sponsored`: the fee-less actions this relayer pays for; `actions`: every action it accepts.

### `GET /v1/quote?action=<action>[&token=<token>[&amount=<wei>[&exactOut=1]]][&graduates=1]`

The fee to bind into an order's `relay`, valid while the gas price stays at or below `validUpToGasPriceWei`.

For a buy (`buy`, `buyExactOut`, `privacyPoolBuy`), pass the token and the amount so the relayer can tell whether the
buy completes the curve: `amount` is the BNB the buy offers (wei), or the tokens to buy (token wei) for `buyExactOut`
and with `exactOut=1` for an exact-out `privacyPoolBuy`. The relayer reads the token's curve
(`quoteBuyExactOut(token, 2^256 - 1)`, `quoteBuy`) and, if the buy would sell it out, quotes the `completing-buy` gas
class: the action's typical gas + the graduation gas (7,000,000, the worst venue measured). `graduates=1` (or `true`)
asks for that class without the check. A trade (`buy`, `buyExactOut`, `privacyPoolBuy`, `sell`, `withdrawTokens`) on
a graduated `token` swaps through the token's pool instead of the curve: the `post-graduation` class, the action's
typical gas + 200,000, so pass `token` for every trade (`amount` is not needed for it). Other actions, and a trade
without `token`, are quoted in the `standard` class (the curve's gas: such an order on a graduated token is refused
with `fee_too_low`). A token that is not a MurkFun token: `400 unknown_token`; a malformed `token` / `amount`:
`400 bad_field`.

```json
{
  "action": "buy",
  "relayer": "0x5b1f…c0de",
  "fee": "66550000000000",
  "gasUnits": "1100000",
  "graduates": false,
  "gasClass": "standard",
  "gasPriceWei": "50000000",
  "quoteGasPriceWei": "55000000",
  "validUpToGasPriceWei": "55000000",
  "deadline": "1793790000",
  "sponsored": false
}
```

- `fee`: the `fee` to write into the order (wei). `"0"` with `sponsored: true` for sponsored actions.
- `gasUnits`: the gas the quote assumes: the action's typical gas, + the graduation gas in the `completing-buy` class.
- `graduates`, `gasClass`: `true` / `"completing-buy"` for a buy that sells out the curve and graduates the token;
  `false` / `"standard"` otherwise.
- `gasPriceWei`: the current gas price; `quoteGasPriceWei`: the price the quote uses.
- `validUpToGasPriceWei`: above this gas price, an order with this fee and the quoted gas is refused (`fee_too_low`).
- `deadline`: a suggested order `deadline`: the chain time + 5 minutes (an order is valid only briefly; the MCP accepts at most `MURKFUN_MAX_ORDER_VALIDITY_S`, 10 minutes by default).

Admission always checks the transaction's real gas estimate, which includes the graduation: a completing buy proved
with a `standard` fee is refused with `fee_too_low` (nothing is sent; quote again in the right class, prove again).

Unknown action: `400 {"error": "bad_action"}`.

### `POST /v1/orders`

Body: one order, `{"action": "<action>", ...fields}` ([Orders](#orders)). `Content-Type: application/json`.
Before sending, the relayer checks the fields, the relayer address, the deadline and the fee, reads the order's target
on chain (see Routing above), then simulates the exact transaction from its own address (`eth_call` +
`eth_estimateGas`): an order that would revert is refused with the decoded reason and nothing is sent.

```json
202 { "id": "6f1c2a3e-8a8b-4c5d-9e0f-112233445566", "status": "submitted", "txHash": "0x…" }
```

`id` is the order id for `GET /v1/orders/:id`. A refused order: `4xx` / `503` `{error, reason}`; nothing was executed.

**Trades are never sent to a public mempool.** `privacyPoolBuy`, `privacyPoolLaunch`, `railgunBuy`, `railgunLaunch`,
`buy`, `buyExactOut`, `sell` and `withdrawTokens` (it may sell tokens for its fee) have a price that could be sandwiched, so they go to private
endpoints only (private builders / private RPCs, all at once, first acceptance wins), also when they are rebroadcast. If
every private endpoint refuses one, the order is refused with `broadcast_failed`: nothing was sent, the relayer's nonce
is released, the order's nullifier, the pseudonym's nonce and the 0xbow note are untouched, so the identical order can be
resubmitted as it is (the MCP does). The other actions (BNB withdrawals, fee claims, `graduate`, `launch`, `setDevRecipient`,
`railgunFund`) fall
back to a public RPC when no private endpoint takes them or they stay unmined (`usedPublicFallback`).

### `GET /v1/orders/:id`

```json
{
  "id": "6f1c2a3e-8a8b-4c5d-9e0f-112233445566",
  "action": "buy",
  "token": "0x…",
  "status": "mined",
  "createdAt": 1793789100000,
  "updatedAt": 1793789104000,
  "to": "0x…",
  "relayFee": "103500000000000",
  "gasEstimate": "455000",
  "gasPrice": "100000000",
  "txHash": "0x…",
  "nonce": 812,
  "broadcast": [{ "endpoint": "48club-puissant", "ok": true }],
  "usedPublicFallback": false,
  "blockNumber": "130500000",
  "gasUsed": "441000",
  "events": []
}
```

`status`:

| `status` | Meaning |
|---|---|
| `submitted` | sent, not mined yet (it is rebroadcast while pending) |
| `mined` | executed |
| `reverted` | mined but reverted (state changed after the simulation, e.g. someone else executed the same proof first); `error` has the reason. Only the gas was lost, paid by the relayer |
| `dropped` | not executed: replaced by the relayer's cancellation or never mined; `error` says why. Nothing changed: resubmit the identical order while its `deadline` allows, or build a new one |
| `failed` | the relayer could not track it; `error` has the reason. Check the chain (`status` / `token_info`) before retrying |

Other fields: `token`, `to` (the contract it was sent to), `relayFee`, `gasEstimate`, `gasPrice` (wei), `txHash`,
`nonce` (the relayer's), `broadcast` (per submission endpoint: `{endpoint, ok, error}`), `usedPublicFallback` (always
`false` for a trade), `blockNumber`, `gasUsed`, `error`, `events` (`broadcast_unconfirmed`, `rebroadcast`,
`public_fallback`, `cancel_sent`, `cancel_would_revert`, `stuck`, `recovered`, `reorged`: a reorg dropped the mined tx before it was final, so it is tracked again;
`finality_lag`: its block has not been finalized for a minute, the order stays `submitted` until it is).
Times are unix milliseconds. Unknown id:
`404 {"error": "not_found"}`. Finished orders are kept for 30 days.

### `GET /health`, `GET /ready`, `GET /metrics`

Operations. `/health`: `200 {"ok": true}` while the process runs. `/ready`: `200 {ok: true, reasons: [], relayer, pending}`
or `503 {ok: false, reasons: [...], …}` (read RPC unreachable or stale, balance too low, a stuck nonce). `/metrics`:
Prometheus text (`murkfun_relayer_*`: aggregate gauges and counters such as readiness, pending and stuck transactions,
the gas balance and request counts; nothing per order or per client), for the operator: it needs the operator's
bearer token where one is configured (`401` without it).

## Fees, quotes and deadlines

Signed orders pay the relayer in BNB from the pseudonym's internal balance for the order's token (a 0xbow or Railgun
buy pays it out of the withdrawn / unshielded amount, a creator buy out of the buy's payment, a Railgun Fund out of the
credited BNB). The fee is part of the signed order, so it is
fixed before the order is sent:

1. `GET /v1/quote?action=<action>` (for a buy `&token=…&amount=…[&exactOut=1]`, so a completing buy is quoted in its
   gas class).
2. Write `relayer`, `fee` and `deadline` from the quote into the order, have the wallet sign it and prove it.
3. `POST /v1/orders` soon after. The relayer admits the order while
   `estimatedGas × gasPrice × (1 + feeMarginBps / 10000) ≤ fee` and `deadline ≥ now + minDeadlineSecs`.
4. Poll `GET /v1/orders/:id` until it leaves `submitted`.

Quotes price the action's typical gas (its measured gas) at the higher of the current price and the last 10 minutes'
peak, plus a buffer (10%) and a quote margin (10%): about 1.2-1.3x the real gas cost, so a quoted fee normally passes
step 3. A gas-price spike raises every later quote (the 10-minute peak). If it does not (`fee_too_low`, `deadline_too_soon`), nothing was executed and the
pseudonym's nonce did not move: quote again, sign and prove a new order with the new terms, resubmit. After `broadcast_failed`,
`overloaded` or a `dropped` order, the same order is still valid: resubmit it unchanged.

The order's `deadline` is checked on chain too: after it, the transaction reverts with `Expired()`, so a delayed order
can never execute late.

Sponsored actions pay nothing: a `launch` without a creator buy (its order has `amount` 0 and `fee` 0) and the
permissionless `graduate`, `collectLpFees`, `claimDevFees` (no signature at all); the relayer pays their gas and limits
them per client address (an IPv6 client counts as its /64) and by a daily gas budget.

Relayer fees accrue in `relayerFees(relayer)` of each token's market (the relayer claims them with
`claimRelayerFees(to)`).

## Railgun-paid orders

A Railgun buy, Fund or creator buy needs no gas wallet: the shared relayer submits it like any other order, and is paid
by the fee the order names. The on-chain sender is the shared relayer and the BNB comes out of Railgun; buys of one
token share its pseudonym, and amounts, timing and the IP address the orders come from can still be correlated.

1. `GET /v1/quote?action=railgunBuy` (`railgunFund`, `railgunLaunch`; a buy with `&token=…&amount=…`, as for 0xbow) and
   write `relayer` and `fee` into the order (the MCP's `buy` / `fund_pseudonym` / `create_token` with `source=railgun`
   do this; Railgun proofs take a while, so they sign a later `deadline`, 30 min by default, and a `fee` 25% above the
   quote, so that a gas price rise meanwhile does not get the order refused with `fee_too_low` after the Railgun proof
   is made). The order's `amount` is what reaches the adapter after Railgun's unshield fee; `fee` is paid from it.
2. In the Railgun wallet (Railgun engine / SDK), build and prove the transaction(s) that unshield WBNB to MurkFun's
   Railgun adapter: unshield type NORMAL, recipient (`npk`) = the adapter, gross value = `amount` grossed up for
   Railgun's unshield fee, with the adapt ID `{ contract: adapter, parameters: adapter.adaptParams(order) }` (=
   keccak256(abi.encode(order))) and `minGasPrice` 0 (or at most the relayer's `gasPriceWei`). Railgun's proof commits
   to the adapt ID, so the unshield can only pay this order, and only through the adapter.
3. `POST /v1/orders` with `{"action": "railgunBuy", "adapter", "transactions", "order", "proof"}` (`railgunLaunch`:
   also `spec`). The MCP returns this body as `relay.body` with `transactions` left to fill in; its `submit_railgun`
   tool posts it and waits like any other order.

The relayer refuses before simulating: an adapter that is not on the factory's allowlist now (`bad_target`), an order
that does not name it (`wrong_relayer`) or pays less than the gas (`fee_too_low`), a deadline too soon
(`deadline_too_soon`), and any Railgun transaction that is not a NORMAL WBNB unshield to the adapter bound to this order,
or unshields that do not deliver exactly `amount` (`bad_unshield`). Then it simulates the exact call from its own
address (the order proof, Railgun's proof and every contract check run as on chain) and sends it with the same nonce,
gas, rebroadcast and status handling as every other order. While it is pending, another order spending one of its
Railgun nullifiers, or of the same pseudonym, is `busy`.

Sending it yourself still works: the adapter call is permissionless (`railgun.submit` of the MCP's answer), but then a
public account pays the gas and appears as the sender; the fee still goes to the relayer the order names (sign with
`selfSubmit: true` for an order without a relayer fee).

## Authorisation

An order is authorised by the user's wallet and a proof made on the user's machine ([SIGNED_ORDERS.md](SIGNED_ORDERS.md)
is the full specification). The relayer, and anyone who sees the order, can only submit it unchanged; a copy
submitted by someone else does exactly the same thing, once.

```
order     = {action, token, amount, minOut, to, nonce, relayer, fee, deadline, holderRoot, pseudonym, nullifier}
MARKET    = factory.marketOf(token)            // factory.market() for a launch; the gate is MARKET.orders()
nonce     = MARKET.nonces(token, pseudonym)    // +1 per executed order of this pseudonym
S2        = the wallet's EIP-712 OrderAuth {orderHash} signature, orderHash = Poseidon2 over the order fields + a salt
proof     = UltraHonk proof (circuits/order): S2 and the wallet's seed signature by one key in the holder tree with root
            holderRoot; pseudonym and nullifier derived from the seed signature; public inputs = holderRoot, chainId,
            MARKET and the order fields, pseudonym, nullifier (MurkFunOrders.publicInputs(order) builds them)
```

`action` is the `MurkFunOrders.Action` number (Buy 1, BuyExactOut 2, BuyDirect 3, BuyDirectExactOut 4, Sell 5,
WithdrawBnb 6, WithdrawTokens 7, Fund 8, SetDevRecipient 9, Launch 10, LaunchExactOut 11); the order tables below give
each relayer action's order actions and field meanings. The gate burns the nullifier and the market checks the nonce,
so an order runs once and only at its nonce; once any order of the pseudonym executes, older ones revert
(`WrongNonce()`). The relayer therefore accepts one pending order per pseudonym and per nullifier (`busy` otherwise).
The relayer simulates every order with the gas price and gas limit it signs the transaction with. An order whose
transaction still reverted on chain is remembered persistently: that exact order is refused from then on, and further
orders of its pseudonym (and of its 0xbow note) are refused for a backoff that starts at 1 minute and grows ×4 with
every further revert (at most 24 h; forgotten 7 days after the last revert); `reverted_before` names the time.

**Holder root.** `holderRoot` must be accepted by MurkFunHolderRoots (`isKnownRoot`; the latest is `acceptedRoot()`). A
root stays valid until 64 newer batches are accepted, so an order proved against a recent root keeps working while new
holders are added.

**0xbow proof** (`privacyPoolBuy`, `privacyPoolLaunch`). A 0xbow Privacy Pools `transact_1x1` Groth16 proof that spends
one of the user's ASP-approved notes, made from the note secrets in the vault: `amountOut` = the order's `amount`
(native BNB, more than its fee), `params.processor` = MurkFun's 0xbow adapter (`privacyPoolAdapter` from
`GET /v1/info`), `params.data = abi.encode(order)`, `context = keccak256(abi.encode(params, noteData)) mod p` (p = the
BN254 scalar field), so the 0xbow proof binds the whole order and the change note. The ASP root must be the 0xbow
ASP's current root, and the state and keystore roots known to the 0xbow vault. The adapter accepts BNB only from the
0xbow vault inside that call and pays exactly `amount` into the order at the gate; if the order reverts, the whole
transaction reverts and the note stays unspent. The relayer also refuses a second pending order sharing any input
nullifier or output commitment of its 0xbow proof.

**Launch.** A Launch order names the predicted token (`MurkFunFactory.predictTokenAddress(name, symbol, metadataURI,
devFeeRecipient, devSalt)`; it commits to the factory's current terms, incl. the platform's dev cap) as `token`, the
dev fee recipient as `to`, nonce 0, and the creator buy as `amount` (0 = none). `spec.launchSig` is the one-time launch
key's signature of `factory.launchDigest(token, pseudonym)` (the key's address is the top 20 bytes of `devSalt`), so a
launch seen in the mempool can not be taken with another pseudonym (`NotLaunchKey()`); a changed recipient or terms
moves the address (`WrongToken()` / `WrongRecipient()`).

Where the reference client does this: `src/orders.ts` (hashes, typed data, holder paths, witness, local prover),
`src/murkfun.ts` (the wire format), `src/pp.ts` (0xbow trees, notes and proofs), `src/agent.ts` (quotes,
orders, submission).

## Orders

Every order is `{"action": "<action>", ...fields}`. All fields are required. The relayer accepts exactly these
actions and fields; anything else is refused (`bad_action`, `bad_field`).

<!-- begin generated order tables -->

#### `privacyPoolBuy`

Buy with BNB withdrawn from a 0xbow Privacy Pools note in the same transaction. The order (in `params.data`) is a BuyDirect (`action` 3: at least `minOut` tokens) or BuyDirectExactOut (`action` 4: exactly `minOut` tokens) order for `amount` = the BNB the 0xbow proof withdraws. MurkFun's 0xbow adapter is the 0xbow processor: it withdraws exactly `amount` and pays it into the order (`MurkFunOrders.execute`). The whole amount is credited to the pseudonym, the buy spends up to `amount - fee`, `fee` goes to the relayer, and BNB the buy does not need stays in the pseudonym's balance for this token; the change note stays in 0xbow. The holding cap, the slippage limit or a stale order reverts it and the note stays unspent. The buy that sells out the curve fills what is left and graduates the token in the same transaction (quote it as a completing buy).

Becomes `MurkFunPrivacyPoolAdapter.buy(ppProof, params, noteData, proof)`. Signed and proved: pays the order's `fee`. Built by the MCP tool `buy` (`source=note`, the default).

| Field | Type | Meaning |
|---|---|---|
| `action` | string | `"privacyPoolBuy"` |
| `ppProof.pA` | uint[2] | 0xbow `transact_1x1` Groth16 proof: A |
| `ppProof.pB` | uint[2][2] | 0xbow proof: B |
| `ppProof.pC` | uint[2] | 0xbow proof: C |
| `ppProof.pubSignals` | uint[][] | 0xbow proof: public signals; `[0][0]` the spent note's nullifier, `[5][0]` amountOut (= the order's `amount`), `[6][0]` the native asset |
| `params.processor` | address | MurkFun's 0xbow adapter (`privacyPoolAdapter` from `GET /v1/info`) |
| `params.data` | bytes | `abi.encode(order)`: the signed MurkFunOrders.Order (`action`, `token`, `amount`, `minOut`, `to`, `nonce`, `relayer`, `fee`, `deadline`, `holderRoot`, `pseudonym`, `nullifier`); bound by the 0xbow proof context |
| `noteData[].hint` | bytes32 | 0xbow note data of the change note: hint |
| `noteData[].data` | bytes | 0xbow note data of the change note: encrypted data |
| `proof` | bytes | the order proof (UltraHonk, circuits/order, ~9.5 KB): this wallet, a holder in `holderRoot`, signed exactly this order with a fresh signature; made locally by the MCP |

#### `privacyPoolLaunch`

Launch a token with the dev's first buy in the same transaction, paid from a 0xbow note, so nobody can buy before the dev. The order (in `params.data`) is a Launch (`action` 10: at least `minOut` tokens) or LaunchExactOut (`action` 11: exactly `minOut` tokens) order for the predicted token address with `to` = the dev fee recipient and `amount` = the BNB the 0xbow proof withdraws; its pseudonym becomes the dev. The buy is bounded by the platform's dev cap (30% of supply, the token's `Terms.devCap`; you do not set it) and is the token's first trade; one `fee` pays for launch + buy, and BNB the buy does not need stays in the dev pseudonym's balance.

Becomes `MurkFunPrivacyPoolAdapter.launch(spec, ppProof, params, noteData, proof)`. Signed and proved: pays the order's `fee`. Built by the MCP tool `create_token` with `bnbAmount` / `buyTokens` (`source=note`, the default).

| Field | Type | Meaning |
|---|---|---|
| `action` | string | `"privacyPoolLaunch"` |
| `spec.name` | string | token name, at most 64 characters |
| `spec.symbol` | string | token symbol, at most 16 characters |
| `spec.metadataURI` | string | `ipfs://<cid>` of the metadata JSON (TOKEN_METADATA.md) or `""`; permanent |
| `spec.devFeeRecipient` | address | public address that receives dev fees (= `order.to`); a MurkFun contract or token (the one being launched included), WBNB or a burn address is refused (`bad_recipient`) |
| `spec.devSalt` | bytes32 | the dev salt: the launch key's address in the top 20 bytes, then 12 free bytes (random, or ground for a vanity address) |
| `spec.launchSig` | bytes | the launch key's 65-byte signature (r, s, v) of `factory.launchDigest(token, order.pseudonym)`: only the holder of the key the salt names can launch at that address |
| `ppProof.pA` | uint[2] | 0xbow `transact_1x1` Groth16 proof: A |
| `ppProof.pB` | uint[2][2] | 0xbow proof: B |
| `ppProof.pC` | uint[2] | 0xbow proof: C |
| `ppProof.pubSignals` | uint[][] | 0xbow proof: public signals; `[0][0]` the spent note's nullifier, `[5][0]` amountOut (= the order's `amount`), `[6][0]` the native asset |
| `params.processor` | address | MurkFun's 0xbow adapter (`privacyPoolAdapter` from `GET /v1/info`) |
| `params.data` | bytes | `abi.encode(order)`: the signed MurkFunOrders.Order (`action`, `token`, `amount`, `minOut`, `to`, `nonce`, `relayer`, `fee`, `deadline`, `holderRoot`, `pseudonym`, `nullifier`); bound by the 0xbow proof context |
| `noteData[].hint` | bytes32 | 0xbow note data of the change note: hint |
| `noteData[].data` | bytes | 0xbow note data of the change note: encrypted data |
| `proof` | bytes | the order proof (UltraHonk, circuits/order, ~9.5 KB): this wallet, a holder in `holderRoot`, signed exactly this order with a fresh signature; made locally by the MCP |

#### `railgunBuy`

Buy with BNB unshielded from Railgun in the same transaction. The order is a BuyDirect (`action` 3: at least `minOut` tokens) or BuyDirectExactOut (`action` 4: exactly `minOut` tokens) order for `amount` = the WBNB the Railgun transactions deliver to MurkFun's Railgun adapter after Railgun's unshield fee; the adapter runs Railgun's `transact`, unwraps exactly what arrived and pays it into the order. The whole amount is credited to the pseudonym, the buy spends up to `amount - fee`, `fee` goes to the relayer, and BNB the buy does not need stays in the pseudonym's balance for this token. The relayer submits the adapter call, so no wallet of the user pays gas or appears on chain (the sender is the shared relayer); anyone else may submit the same call too. Before simulating it the relayer decodes every Railgun transaction and refuses (`bad_unshield`) anything but a NORMAL unshield of WBNB to the adapter bound to exactly this order (`adaptContract` = the adapter, `adaptParams` = keccak256(abi.encode(order))) whose values after Railgun's unshield fee sum to `order.amount`; the adapter must be on the factory's privacy-funder allowlist (`bad_target`). If the order reverts (pause, holding cap, slippage, a stale order) the whole transaction reverts and the Railgun notes stay unspent. The buy that sells out the curve fills what is left and graduates the token in the same transaction (quote it as a completing buy).

Becomes `MurkFunRailgunAdapter.execute(transactions, order, proof)`. Signed and proved: pays the order's `fee`. Built by the MCP tool `buy` with `source=railgun`, then `submit_railgun`.

| Field | Type | Meaning |
|---|---|---|
| `action` | string | `"railgunBuy"` |
| `adapter` | address | MurkFun's Railgun adapter (deployment `railgunAdapter`); refused (`bad_target`) unless the factory's privacy-funder allowlist holds it now |
| `transactions[].proof.a.x` | uint | the Railgun transaction's Groth16 proof: A (1-8 transactions) |
| `transactions[].proof.a.y` | uint | proof: A |
| `transactions[].proof.b.x` | uint[2] | proof: B |
| `transactions[].proof.b.y` | uint[2] | proof: B |
| `transactions[].proof.c.x` | uint | proof: C |
| `transactions[].proof.c.y` | uint | proof: C |
| `transactions[].merkleRoot` | bytes32 | a Railgun merkle root the proof is against |
| `transactions[].nullifiers` | bytes32[] | the spent Railgun notes' nullifiers (1-16; one pending order per nullifier) |
| `transactions[].commitments` | bytes32[] | output commitments, the unshield's last (1-16) |
| `transactions[].boundParams.treeNumber` | uint | Railgun tree of the merkle root (uint16) |
| `transactions[].boundParams.minGasPrice` | uint | Railgun's minimum tx gas price (uint72); the relayer's gas price (`gasPriceWei`, `GET /v1/info`) must reach it: use 0 |
| `transactions[].boundParams.unshield` | uint | 1 (NORMAL); anything else is refused (`bad_unshield`) |
| `transactions[].boundParams.chainID` | uint | 56 (BSC) |
| `transactions[].boundParams.adaptContract` | address | = `adapter` (Railgun then accepts the transaction only from the adapter) |
| `transactions[].boundParams.adaptParams` | bytes32 | keccak256(abi.encode(order)) = `adapter.adaptParams(order)`: binds the unshield to exactly this order |
| `transactions[].boundParams.commitmentCiphertext[].ciphertext` | bytes32[4] | Railgun note ciphertext of each non-unshield output (as the Railgun engine made it) |
| `transactions[].boundParams.commitmentCiphertext[].blindedSenderViewingKey` | bytes32 | as the Railgun engine made it |
| `transactions[].boundParams.commitmentCiphertext[].blindedReceiverViewingKey` | bytes32 | as the Railgun engine made it |
| `transactions[].boundParams.commitmentCiphertext[].annotationData` | bytes | as the Railgun engine made it (at most 1024 bytes) |
| `transactions[].boundParams.commitmentCiphertext[].memo` | bytes | as the Railgun engine made it (at most 2048 bytes) |
| `transactions[].unshieldPreimage.npk` | bytes32 | the unshield's recipient: the adapter's address, left-padded to 32 bytes |
| `transactions[].unshieldPreimage.token.tokenType` | uint | 0 (ERC20) |
| `transactions[].unshieldPreimage.token.tokenAddress` | address | WBNB (the adapter's `WBNB()`); another token is refused (`bad_unshield`) |
| `transactions[].unshieldPreimage.token.tokenSubID` | uint | 0 |
| `transactions[].unshieldPreimage.value` | uint | WBNB unshielded (gross, uint120): the values minus Railgun's unshield fee (`value - value * unshieldFee / 10000`) sum to `order.amount`, else `bad_unshield` |
| `order.action` | uint | 3 (BuyDirect) or 4 (BuyDirectExactOut) |
| `order.token` | address | the MurkFun token (a launch: its predicted address, `factory.predictTokenAddress`) |
| `order.amount` | uint | BNB (wei) the unshields deliver (net of Railgun's fee); `fee` is paid from it |
| `order.minOut` | uint | BuyDirect: slippage limit (token wei); BuyDirectExactOut: tokens to buy |
| `order.to` | address | 0 (unused) |
| `order.nonce` | uint | the pseudonym's next nonce for this token (`market.nonces(token, pseudonym)`) |
| `order.relayer` | address | the relayer's address (`relayer` from `GET /v1/quote`); it receives `fee` |
| `order.fee` | uint | relayer fee in wei (`fee` from `GET /v1/quote`), paid from the pseudonym's internal BNB balance for `token` after the action |
| `order.deadline` | uint | unix time after which the order reverts; at least `minDeadlineSecs` (`GET /v1/info`) in the future when submitted |
| `order.holderRoot` | uint | an accepted root of the holder set (`MurkFunHolderRoots.acceptedRoot()`) the proof shows the wallet is in |
| `order.pseudonym` | uint | the wallet's pseudonym for `token`: H(secret, token), the secret from the wallet's seed signature |
| `order.nullifier` | uint | H(secret, token, nonce): used once |
| `proof` | bytes | the order proof (UltraHonk, circuits/order, ~9.5 KB): this wallet, a holder in `holderRoot`, signed exactly this order with a fresh signature; made locally by the MCP |

#### `railgunFund`

Credit the pseudonym's internal BNB balance for this token with BNB unshielded from Railgun (a Fund order, `action` 8); `fee` is paid from the credited BNB. The relayer submits the adapter call, so no wallet of the user pays gas or appears on chain (the sender is the shared relayer); anyone else may submit the same call too. Before simulating it the relayer decodes every Railgun transaction and refuses (`bad_unshield`) anything but a NORMAL unshield of WBNB to the adapter bound to exactly this order (`adaptContract` = the adapter, `adaptParams` = keccak256(abi.encode(order))) whose values after Railgun's unshield fee sum to `order.amount`; the adapter must be on the factory's privacy-funder allowlist (`bad_target`). If the order reverts (pause, holding cap, slippage, a stale order) the whole transaction reverts and the Railgun notes stay unspent. Spend the balance with `buy` (`source=balance`).

Becomes `MurkFunRailgunAdapter.execute(transactions, order, proof)`. Signed and proved: pays the order's `fee`. Built by the MCP tool `fund_pseudonym`, then `submit_railgun`.

| Field | Type | Meaning |
|---|---|---|
| `action` | string | `"railgunFund"` |
| `adapter` | address | MurkFun's Railgun adapter (deployment `railgunAdapter`); refused (`bad_target`) unless the factory's privacy-funder allowlist holds it now |
| `transactions[].proof.a.x` | uint | the Railgun transaction's Groth16 proof: A (1-8 transactions) |
| `transactions[].proof.a.y` | uint | proof: A |
| `transactions[].proof.b.x` | uint[2] | proof: B |
| `transactions[].proof.b.y` | uint[2] | proof: B |
| `transactions[].proof.c.x` | uint | proof: C |
| `transactions[].proof.c.y` | uint | proof: C |
| `transactions[].merkleRoot` | bytes32 | a Railgun merkle root the proof is against |
| `transactions[].nullifiers` | bytes32[] | the spent Railgun notes' nullifiers (1-16; one pending order per nullifier) |
| `transactions[].commitments` | bytes32[] | output commitments, the unshield's last (1-16) |
| `transactions[].boundParams.treeNumber` | uint | Railgun tree of the merkle root (uint16) |
| `transactions[].boundParams.minGasPrice` | uint | Railgun's minimum tx gas price (uint72); the relayer's gas price (`gasPriceWei`, `GET /v1/info`) must reach it: use 0 |
| `transactions[].boundParams.unshield` | uint | 1 (NORMAL); anything else is refused (`bad_unshield`) |
| `transactions[].boundParams.chainID` | uint | 56 (BSC) |
| `transactions[].boundParams.adaptContract` | address | = `adapter` (Railgun then accepts the transaction only from the adapter) |
| `transactions[].boundParams.adaptParams` | bytes32 | keccak256(abi.encode(order)) = `adapter.adaptParams(order)`: binds the unshield to exactly this order |
| `transactions[].boundParams.commitmentCiphertext[].ciphertext` | bytes32[4] | Railgun note ciphertext of each non-unshield output (as the Railgun engine made it) |
| `transactions[].boundParams.commitmentCiphertext[].blindedSenderViewingKey` | bytes32 | as the Railgun engine made it |
| `transactions[].boundParams.commitmentCiphertext[].blindedReceiverViewingKey` | bytes32 | as the Railgun engine made it |
| `transactions[].boundParams.commitmentCiphertext[].annotationData` | bytes | as the Railgun engine made it (at most 1024 bytes) |
| `transactions[].boundParams.commitmentCiphertext[].memo` | bytes | as the Railgun engine made it (at most 2048 bytes) |
| `transactions[].unshieldPreimage.npk` | bytes32 | the unshield's recipient: the adapter's address, left-padded to 32 bytes |
| `transactions[].unshieldPreimage.token.tokenType` | uint | 0 (ERC20) |
| `transactions[].unshieldPreimage.token.tokenAddress` | address | WBNB (the adapter's `WBNB()`); another token is refused (`bad_unshield`) |
| `transactions[].unshieldPreimage.token.tokenSubID` | uint | 0 |
| `transactions[].unshieldPreimage.value` | uint | WBNB unshielded (gross, uint120): the values minus Railgun's unshield fee (`value - value * unshieldFee / 10000`) sum to `order.amount`, else `bad_unshield` |
| `order.action` | uint | 8 (Fund) |
| `order.token` | address | the MurkFun token (a launch: its predicted address, `factory.predictTokenAddress`) |
| `order.amount` | uint | BNB (wei) the unshields deliver (net of Railgun's fee) and the balance is credited with; `fee` is paid from it |
| `order.minOut` | uint | 0 (unused) |
| `order.to` | address | 0 (unused) |
| `order.nonce` | uint | the pseudonym's next nonce for this token (`market.nonces(token, pseudonym)`) |
| `order.relayer` | address | the relayer's address (`relayer` from `GET /v1/quote`); it receives `fee` |
| `order.fee` | uint | relayer fee in wei (`fee` from `GET /v1/quote`), paid from the pseudonym's internal BNB balance for `token` after the action |
| `order.deadline` | uint | unix time after which the order reverts; at least `minDeadlineSecs` (`GET /v1/info`) in the future when submitted |
| `order.holderRoot` | uint | an accepted root of the holder set (`MurkFunHolderRoots.acceptedRoot()`) the proof shows the wallet is in |
| `order.pseudonym` | uint | the wallet's pseudonym for `token`: H(secret, token), the secret from the wallet's seed signature |
| `order.nullifier` | uint | H(secret, token, nonce): used once |
| `proof` | bytes | the order proof (UltraHonk, circuits/order, ~9.5 KB): this wallet, a holder in `holderRoot`, signed exactly this order with a fresh signature; made locally by the MCP |

#### `railgunLaunch`

Launch a token with the dev's first buy in the same transaction, paid by a Railgun unshield to MurkFun's Railgun adapter, so nobody can buy before the dev. The order is a Launch (`action` 10) or LaunchExactOut (`action` 11) order for the predicted token address with `to` = the dev fee recipient and `amount` = the BNB the unshields deliver; its pseudonym becomes the dev. The buy is bounded by the platform's dev cap; one `fee` pays for launch + buy, and BNB the buy does not need stays in the dev pseudonym's balance. The relayer submits the adapter call, so no wallet of the user pays gas or appears on chain (the sender is the shared relayer); anyone else may submit the same call too. Before simulating it the relayer decodes every Railgun transaction and refuses (`bad_unshield`) anything but a NORMAL unshield of WBNB to the adapter bound to exactly this order (`adaptContract` = the adapter, `adaptParams` = keccak256(abi.encode(order))) whose values after Railgun's unshield fee sum to `order.amount`; the adapter must be on the factory's privacy-funder allowlist (`bad_target`). If the order reverts (pause, holding cap, slippage, a stale order) the whole transaction reverts and the Railgun notes stay unspent.

Becomes `MurkFunRailgunAdapter.launch(spec, transactions, order, proof)`. Signed and proved: pays the order's `fee`. Built by the MCP tool `create_token` with `bnbAmount` / `buyTokens` and `source=railgun`, then `submit_railgun`.

| Field | Type | Meaning |
|---|---|---|
| `action` | string | `"railgunLaunch"` |
| `spec.name` | string | token name, at most 64 characters |
| `spec.symbol` | string | token symbol, at most 16 characters |
| `spec.metadataURI` | string | `ipfs://<cid>` of the metadata JSON (TOKEN_METADATA.md) or `""`; permanent |
| `spec.devFeeRecipient` | address | public address that receives dev fees (= `order.to`); a MurkFun contract or token (the one being launched included), WBNB or a burn address is refused (`bad_recipient`) |
| `spec.devSalt` | bytes32 | the dev salt: the launch key's address in the top 20 bytes, then 12 free bytes (random, or ground for a vanity address) |
| `spec.launchSig` | bytes | the launch key's 65-byte signature (r, s, v) of `factory.launchDigest(token, order.pseudonym)`: only the holder of the key the salt names can launch at that address |
| `adapter` | address | MurkFun's Railgun adapter (deployment `railgunAdapter`); refused (`bad_target`) unless the factory's privacy-funder allowlist holds it now |
| `transactions[].proof.a.x` | uint | the Railgun transaction's Groth16 proof: A (1-8 transactions) |
| `transactions[].proof.a.y` | uint | proof: A |
| `transactions[].proof.b.x` | uint[2] | proof: B |
| `transactions[].proof.b.y` | uint[2] | proof: B |
| `transactions[].proof.c.x` | uint | proof: C |
| `transactions[].proof.c.y` | uint | proof: C |
| `transactions[].merkleRoot` | bytes32 | a Railgun merkle root the proof is against |
| `transactions[].nullifiers` | bytes32[] | the spent Railgun notes' nullifiers (1-16; one pending order per nullifier) |
| `transactions[].commitments` | bytes32[] | output commitments, the unshield's last (1-16) |
| `transactions[].boundParams.treeNumber` | uint | Railgun tree of the merkle root (uint16) |
| `transactions[].boundParams.minGasPrice` | uint | Railgun's minimum tx gas price (uint72); the relayer's gas price (`gasPriceWei`, `GET /v1/info`) must reach it: use 0 |
| `transactions[].boundParams.unshield` | uint | 1 (NORMAL); anything else is refused (`bad_unshield`) |
| `transactions[].boundParams.chainID` | uint | 56 (BSC) |
| `transactions[].boundParams.adaptContract` | address | = `adapter` (Railgun then accepts the transaction only from the adapter) |
| `transactions[].boundParams.adaptParams` | bytes32 | keccak256(abi.encode(order)) = `adapter.adaptParams(order)`: binds the unshield to exactly this order |
| `transactions[].boundParams.commitmentCiphertext[].ciphertext` | bytes32[4] | Railgun note ciphertext of each non-unshield output (as the Railgun engine made it) |
| `transactions[].boundParams.commitmentCiphertext[].blindedSenderViewingKey` | bytes32 | as the Railgun engine made it |
| `transactions[].boundParams.commitmentCiphertext[].blindedReceiverViewingKey` | bytes32 | as the Railgun engine made it |
| `transactions[].boundParams.commitmentCiphertext[].annotationData` | bytes | as the Railgun engine made it (at most 1024 bytes) |
| `transactions[].boundParams.commitmentCiphertext[].memo` | bytes | as the Railgun engine made it (at most 2048 bytes) |
| `transactions[].unshieldPreimage.npk` | bytes32 | the unshield's recipient: the adapter's address, left-padded to 32 bytes |
| `transactions[].unshieldPreimage.token.tokenType` | uint | 0 (ERC20) |
| `transactions[].unshieldPreimage.token.tokenAddress` | address | WBNB (the adapter's `WBNB()`); another token is refused (`bad_unshield`) |
| `transactions[].unshieldPreimage.token.tokenSubID` | uint | 0 |
| `transactions[].unshieldPreimage.value` | uint | WBNB unshielded (gross, uint120): the values minus Railgun's unshield fee (`value - value * unshieldFee / 10000`) sum to `order.amount`, else `bad_unshield` |
| `order.action` | uint | 10 (Launch) or 11 (LaunchExactOut) |
| `order.token` | address | the MurkFun token (a launch: its predicted address, `factory.predictTokenAddress`) |
| `order.amount` | uint | BNB (wei) the unshields deliver (net of Railgun's fee); `fee` is paid from it |
| `order.minOut` | uint | Launch: slippage limit (token wei); LaunchExactOut: tokens to buy |
| `order.to` | address | the dev fee recipient (= `spec.devFeeRecipient`) |
| `order.nonce` | uint | the pseudonym's next nonce for this token (`market.nonces(token, pseudonym)`) |
| `order.relayer` | address | the relayer's address (`relayer` from `GET /v1/quote`); it receives `fee` |
| `order.fee` | uint | relayer fee in wei (`fee` from `GET /v1/quote`), paid from the pseudonym's internal BNB balance for `token` after the action |
| `order.deadline` | uint | unix time after which the order reverts; at least `minDeadlineSecs` (`GET /v1/info`) in the future when submitted |
| `order.holderRoot` | uint | an accepted root of the holder set (`MurkFunHolderRoots.acceptedRoot()`) the proof shows the wallet is in |
| `order.pseudonym` | uint | the wallet's pseudonym for `token`: H(secret, token), the secret from the wallet's seed signature |
| `order.nullifier` | uint | H(secret, token, nonce): used once |
| `proof` | bytes | the order proof (UltraHonk, circuits/order, ~9.5 KB): this wallet, a holder in `holderRoot`, signed exactly this order with a fresh signature; made locally by the MCP |

#### `buy`

Buy with BNB from the pseudonym's internal balance for this token (sell proceeds, BNB a buy did not need, or BNB a Fund order credited). `amount` is the most it spends; `fee` is charged on top. The buy that sells out the curve spends only what the rest costs and graduates the token in the same transaction.

Becomes `MurkFunOrders.execute(order, proof)`. Signed and proved: pays the order's `fee`. Built by the MCP tool `buy` with `source=balance` (`bnbAmount`).

| Field | Type | Meaning |
|---|---|---|
| `action` | string | `"buy"` |
| `order.action` | uint | 1 (Buy) |
| `order.token` | address | the MurkFun token (a launch: its predicted address, `factory.predictTokenAddress`) |
| `order.amount` | uint | BNB (wei) to spend from the internal balance |
| `order.minOut` | uint | slippage limit (token wei); less reverts |
| `order.to` | address | 0 (unused) |
| `order.nonce` | uint | the pseudonym's next nonce for this token (`market.nonces(token, pseudonym)`) |
| `order.relayer` | address | the relayer's address (`relayer` from `GET /v1/quote`); it receives `fee` |
| `order.fee` | uint | relayer fee in wei (`fee` from `GET /v1/quote`), paid from the pseudonym's internal BNB balance for `token` after the action |
| `order.deadline` | uint | unix time after which the order reverts; at least `minDeadlineSecs` (`GET /v1/info`) in the future when submitted |
| `order.holderRoot` | uint | an accepted root of the holder set (`MurkFunHolderRoots.acceptedRoot()`) the proof shows the wallet is in |
| `order.pseudonym` | uint | the wallet's pseudonym for `token`: H(secret, token), the secret from the wallet's seed signature |
| `order.nullifier` | uint | H(secret, token, nonce): used once |
| `proof` | bytes | the order proof (UltraHonk, circuits/order, ~9.5 KB): this wallet, a holder in `holderRoot`, signed exactly this order with a fresh signature; made locally by the MCP |

#### `buyExactOut`

Buy exactly `minOut` tokens with BNB from the pseudonym's internal balance for this token, spending at most `amount` (`fee` on top). On the curve, fewer only if the curve has fewer left: that buy completes the curve and graduates the token in the same transaction; after graduation, from the DEX pool.

Becomes `MurkFunOrders.execute(order, proof)`. Signed and proved: pays the order's `fee`. Built by the MCP tool `buy` with `source=balance` and `tokens`.

| Field | Type | Meaning |
|---|---|---|
| `action` | string | `"buyExactOut"` |
| `order.action` | uint | 2 (BuyExactOut) |
| `order.token` | address | the MurkFun token (a launch: its predicted address, `factory.predictTokenAddress`) |
| `order.amount` | uint | slippage limit: the most BNB (wei) the buy may cost; more reverts |
| `order.minOut` | uint | tokens (wei) to buy |
| `order.to` | address | 0 (unused) |
| `order.nonce` | uint | the pseudonym's next nonce for this token (`market.nonces(token, pseudonym)`) |
| `order.relayer` | address | the relayer's address (`relayer` from `GET /v1/quote`); it receives `fee` |
| `order.fee` | uint | relayer fee in wei (`fee` from `GET /v1/quote`), paid from the pseudonym's internal BNB balance for `token` after the action |
| `order.deadline` | uint | unix time after which the order reverts; at least `minDeadlineSecs` (`GET /v1/info`) in the future when submitted |
| `order.holderRoot` | uint | an accepted root of the holder set (`MurkFunHolderRoots.acceptedRoot()`) the proof shows the wallet is in |
| `order.pseudonym` | uint | the wallet's pseudonym for `token`: H(secret, token), the secret from the wallet's seed signature |
| `order.nullifier` | uint | H(secret, token, nonce): used once |
| `proof` | bytes | the order proof (UltraHonk, circuits/order, ~9.5 KB): this wallet, a holder in `holderRoot`, signed exactly this order with a fresh signature; made locally by the MCP |

#### `sell`

Sell to the curve (before graduation) or the DEX pool (after). Proceeds go to the internal BNB balance.

Becomes `MurkFunOrders.execute(order, proof)`. Signed and proved: pays the order's `fee`. Built by the MCP tool `sell`.

| Field | Type | Meaning |
|---|---|---|
| `action` | string | `"sell"` |
| `order.action` | uint | 5 (Sell) |
| `order.token` | address | the MurkFun token (a launch: its predicted address, `factory.predictTokenAddress`) |
| `order.amount` | uint | tokens (wei) to sell |
| `order.minOut` | uint | slippage limit (BNB wei); less reverts |
| `order.to` | address | 0 (unused) |
| `order.nonce` | uint | the pseudonym's next nonce for this token (`market.nonces(token, pseudonym)`) |
| `order.relayer` | address | the relayer's address (`relayer` from `GET /v1/quote`); it receives `fee` |
| `order.fee` | uint | relayer fee in wei (`fee` from `GET /v1/quote`), paid from the pseudonym's internal BNB balance for `token` after the action |
| `order.deadline` | uint | unix time after which the order reverts; at least `minDeadlineSecs` (`GET /v1/info`) in the future when submitted |
| `order.holderRoot` | uint | an accepted root of the holder set (`MurkFunHolderRoots.acceptedRoot()`) the proof shows the wallet is in |
| `order.pseudonym` | uint | the wallet's pseudonym for `token`: H(secret, token), the secret from the wallet's seed signature |
| `order.nullifier` | uint | H(secret, token, nonce): used once |
| `proof` | bytes | the order proof (UltraHonk, circuits/order, ~9.5 KB): this wallet, a holder in `holderRoot`, signed exactly this order with a fresh signature; made locally by the MCP |

#### `withdrawBnb`

Send BNB from the internal balance to any address; `fee` is charged on top.

Becomes `MurkFunOrders.execute(order, proof)`. Signed and proved: pays the order's `fee`. Built by the MCP tool `withdraw_bnb`.

| Field | Type | Meaning |
|---|---|---|
| `action` | string | `"withdrawBnb"` |
| `order.action` | uint | 6 (WithdrawBnb) |
| `order.token` | address | the MurkFun token (a launch: its predicted address, `factory.predictTokenAddress`) |
| `order.amount` | uint | BNB (wei) to send |
| `order.minOut` | uint | 0 (unused) |
| `order.to` | address | recipient (public: use a fresh address you control; a MurkFun contract or token, WBNB or a burn address is refused (`bad_recipient`)) |
| `order.nonce` | uint | the pseudonym's next nonce for this token (`market.nonces(token, pseudonym)`) |
| `order.relayer` | address | the relayer's address (`relayer` from `GET /v1/quote`); it receives `fee` |
| `order.fee` | uint | relayer fee in wei (`fee` from `GET /v1/quote`), paid from the pseudonym's internal BNB balance for `token` after the action |
| `order.deadline` | uint | unix time after which the order reverts; at least `minDeadlineSecs` (`GET /v1/info`) in the future when submitted |
| `order.holderRoot` | uint | an accepted root of the holder set (`MurkFunHolderRoots.acceptedRoot()`) the proof shows the wallet is in |
| `order.pseudonym` | uint | the wallet's pseudonym for `token`: H(secret, token), the secret from the wallet's seed signature |
| `order.nullifier` | uint | H(secret, token, nonce): used once |
| `proof` | bytes | the order proof (UltraHonk, circuits/order, ~9.5 KB): this wallet, a holder in `holderRoot`, signed exactly this order with a fresh signature; made locally by the MCP |

#### `withdrawTokens`

After graduation only: send real ERC-20 tokens to any address. If the internal BNB balance cannot pay `fee`, at most `minOut` more tokens are sold to pay it.

Becomes `MurkFunOrders.execute(order, proof)`. Signed and proved: pays the order's `fee`. Built by the MCP tool `withdraw_token`.

| Field | Type | Meaning |
|---|---|---|
| `action` | string | `"withdrawTokens"` |
| `order.action` | uint | 7 (WithdrawTokens) |
| `order.token` | address | the MurkFun token (a launch: its predicted address, `factory.predictTokenAddress`) |
| `order.amount` | uint | tokens (wei) to send |
| `order.minOut` | uint | most tokens (wei) sold to pay the fee; 0 = pay it from the BNB balance only |
| `order.to` | address | recipient (public: use a fresh address you control; a MurkFun contract or token, WBNB or a burn address is refused (`bad_recipient`)) |
| `order.nonce` | uint | the pseudonym's next nonce for this token (`market.nonces(token, pseudonym)`) |
| `order.relayer` | address | the relayer's address (`relayer` from `GET /v1/quote`); it receives `fee` |
| `order.fee` | uint | relayer fee in wei (`fee` from `GET /v1/quote`), paid from the pseudonym's internal BNB balance for `token` after the action |
| `order.deadline` | uint | unix time after which the order reverts; at least `minDeadlineSecs` (`GET /v1/info`) in the future when submitted |
| `order.holderRoot` | uint | an accepted root of the holder set (`MurkFunHolderRoots.acceptedRoot()`) the proof shows the wallet is in |
| `order.pseudonym` | uint | the wallet's pseudonym for `token`: H(secret, token), the secret from the wallet's seed signature |
| `order.nullifier` | uint | H(secret, token, nonce): used once |
| `proof` | bytes | the order proof (UltraHonk, circuits/order, ~9.5 KB): this wallet, a holder in `holderRoot`, signed exactly this order with a fresh signature; made locally by the MCP |

#### `setDevRecipient`

The token's dev pseudonym changes the public address that receives dev fees (curve, LP and hook fees).

Becomes `MurkFunOrders.execute(order, proof)`. Signed and proved: pays the order's `fee`. Built by the MCP tool `set_fee_recipient`.

| Field | Type | Meaning |
|---|---|---|
| `action` | string | `"setDevRecipient"` |
| `order.action` | uint | 9 (SetDevRecipient) |
| `order.token` | address | the MurkFun token (a launch: its predicted address, `factory.predictTokenAddress`) |
| `order.amount` | uint | 0 (unused) |
| `order.minOut` | uint | 0 (unused) |
| `order.to` | address | new dev fee recipient; a MurkFun contract or token, WBNB or a burn address is refused (`bad_recipient`) |
| `order.nonce` | uint | the pseudonym's next nonce for this token (`market.nonces(token, pseudonym)`) |
| `order.relayer` | address | the relayer's address (`relayer` from `GET /v1/quote`); it receives `fee` |
| `order.fee` | uint | relayer fee in wei (`fee` from `GET /v1/quote`), paid from the pseudonym's internal BNB balance for `token` after the action |
| `order.deadline` | uint | unix time after which the order reverts; at least `minDeadlineSecs` (`GET /v1/info`) in the future when submitted |
| `order.holderRoot` | uint | an accepted root of the holder set (`MurkFunHolderRoots.acceptedRoot()`) the proof shows the wallet is in |
| `order.pseudonym` | uint | the wallet's pseudonym for `token`: H(secret, token), the secret from the wallet's seed signature |
| `order.nullifier` | uint | H(secret, token, nonce): used once |
| `proof` | bytes | the order proof (UltraHonk, circuits/order, ~9.5 KB): this wallet, a holder in `holderRoot`, signed exactly this order with a fresh signature; made locally by the MCP |

#### `launch`

Launch a token without a creator buy (sponsored: no fee). The Launch order makes its pseudonym the dev, which may hold up to the platform's dev limit (the token's `Terms.devCap`, 30% of supply; you do not set it); the token address (CreateX CREATE3) commits to the spec and the factory's current terms, and the order binds that address. While the factory's privacy-funding rule is on (`GET /v1/params`; the owner can change it through the 24 h timelock), a creator buy is paid from a privacy pool: `privacyPoolLaunch` (0xbow) or `railgunLaunch` (a Railgun unshield to MurkFun's Railgun adapter).

Becomes `MurkFunOrders.launch(spec, order, proof)`. Sponsored: no fee (the relayer pays the gas; rate-limited per IP). Built by the MCP tool `create_token` without a creator buy.

| Field | Type | Meaning |
|---|---|---|
| `action` | string | `"launch"` |
| `spec.name` | string | token name, at most 64 characters |
| `spec.symbol` | string | token symbol, at most 16 characters |
| `spec.metadataURI` | string | `ipfs://<cid>` of the metadata JSON (TOKEN_METADATA.md) or `""`; permanent |
| `spec.devFeeRecipient` | address | public address that receives dev fees (= `order.to`); a MurkFun contract or token (the one being launched included), WBNB or a burn address is refused (`bad_recipient`) |
| `spec.devSalt` | bytes32 | the dev salt: the launch key's address in the top 20 bytes, then 12 free bytes (random, or ground for a vanity address) |
| `spec.launchSig` | bytes | the launch key's 65-byte signature (r, s, v) of `factory.launchDigest(token, order.pseudonym)`: only the holder of the key the salt names can launch at that address |
| `order.action` | uint | 10 (Launch) |
| `order.token` | address | the MurkFun token (a launch: its predicted address, `factory.predictTokenAddress`) |
| `order.amount` | uint | 0 (no creator buy) |
| `order.minOut` | uint | 0 (unused) |
| `order.to` | address | the dev fee recipient (= `spec.devFeeRecipient`) |
| `order.nonce` | uint | the pseudonym's next nonce for this token (`market.nonces(token, pseudonym)`) |
| `order.relayer` | address | the relayer's address (`relayer` from `GET /v1/quote`); it receives `fee` |
| `order.fee` | uint | relayer fee in wei (`fee` from `GET /v1/quote`), paid from the pseudonym's internal BNB balance for `token` after the action |
| `order.deadline` | uint | unix time after which the order reverts; at least `minDeadlineSecs` (`GET /v1/info`) in the future when submitted |
| `order.holderRoot` | uint | an accepted root of the holder set (`MurkFunHolderRoots.acceptedRoot()`) the proof shows the wallet is in |
| `order.pseudonym` | uint | the wallet's pseudonym for `token`: H(secret, token), the secret from the wallet's seed signature |
| `order.nullifier` | uint | H(secret, token, nonce): used once |
| `proof` | bytes | the order proof (UltraHonk, circuits/order, ~9.5 KB): this wallet, a holder in `holderRoot`, signed exactly this order with a fresh signature; made locally by the MCP |

#### `graduate`

Retry a graduation (sponsored, permissionless). Graduation is automatic: the buy that sells out the curve graduates the token in the same transaction. This is only for when that failed (`GraduationFailed`: the sold-out curve then waits for a retry).

Becomes `MurkFunMarket.graduate(token)`. Sponsored: no fee (the relayer pays the gas; rate-limited per IP). Built by the MCP tool `graduate`.

| Field | Type | Meaning |
|---|---|---|
| `action` | string | `"graduate"` |
| `token` | address | the MurkFun token |

#### `collectLpFees`

After graduation: pay out the token's post-graduation fees to the dev / platform recipients (sponsored, permissionless).

Becomes `MurkFunLocker.collect(token)`. Sponsored: no fee (the relayer pays the gas; rate-limited per IP). Built by the MCP tool `claim_lp_fees`.

| Field | Type | Meaning |
|---|---|---|
| `action` | string | `"collectLpFees"` |
| `token` | address | the MurkFun token |

#### `claimDevFees`

Pay the curve dev fees accrued for a token to its dev fee recipient (sponsored, permissionless).

Becomes `MurkFunMarket.claimDevFees(token)`. Sponsored: no fee (the relayer pays the gas; rate-limited per IP). Built by the MCP tool `claim_lp_fees`.

| Field | Type | Meaning |
|---|---|---|
| `action` | string | `"claimDevFees"` |
| `token` | address | the MurkFun token |

<!-- end of generated order tables -->

Example (`sell`, values shortened):

```json
{
  "action": "sell",
  "order": {
    "action": "5", "token": "0x1234…abcd", "amount": "1000000000000000000000000", "minOut": "9700000000000000",
    "to": "0x0000000000000000000000000000000000000000", "nonce": "3", "relayer": "0x5b1f…c0de",
    "fee": "103500000000000", "deadline": "1793790000", "holderRoot": "1452…", "pseudonym": "8817…", "nullifier": "3361…"
  },
  "proof": "0x0000…"
}
```

## Errors

| HTTP | `error` | Meaning | What to do |
|---|---|---|---|
| 400 | `bad_json` | the body is not JSON | fix the request |
| 400 | `bad_order` | the body is not a JSON object | fix the request |
| 400 | `bad_action` | unknown `action` (order or quote) | use one of `GET /v1/info` → `actions` |
| 400 | `bad_field` | a field is missing or malformed (also `token` / `amount` of a quote, and a `params.processor` that is not the 0xbow adapter); `reason` names it | fix that field (and re-prove if it is bound) |
| 400 | `bad_target` | a Railgun-paid order's `adapter` is not on the factory's privacy-funder allowlist now, or is not a MurkFun Railgun adapter of this factory | use the deployment's `railgunAdapter`; if MurkFun removed it from the allowlist, pay from 0xbow instead |
| 400 | `bad_unshield` | a Railgun transaction is not a NORMAL unshield of WBNB to the adapter bound to this order (`adaptContract`, `adaptParams` = keccak256(abi.encode(order)), `npk`, chain id), or the unshields do not deliver exactly the order's `amount` after Railgun's current unshield fee; `reason` says which | build the Railgun transaction again with exactly the adapter, adapt params and gross amount for this order (if Railgun's fee changed, a new order) |
| 400 | `unknown_token` | the order's (or quote's) token is not a MurkFun token (`factory.marketOf(token)` is 0) | check the token address |
| 400 | `not_graduated` | `collectLpFees` for a token that has not graduated (it has no locker and no LP fees yet) | claim curve dev fees with `claimDevFees`; collect LP fees after graduation |
| 400 | `bad_recipient` | a `withdrawBnb` / `withdrawTokens` / `setDevRecipient` order's `to`, or a launch's `devFeeRecipient`, is an address where the funds would be lost or stuck: the order's own token (or the token a launch creates), any MurkFun token, WBNB, a MurkFun contract (factory, market, order gate, Dex, locker, Infinity hook, holder set, 0xbow and Railgun adapters, any privacy funder), the zero, a burn or a precompile / system address. The contracts refuse some of these themselves (`BadRecipient`, `MurkFunFactory.isBlockedRecipient`) and accept the rest; the relayer does not send such an order | sign and prove a new order to an address you control (the MCP refuses these before signing) |
| 400 | `orders_unset` | the market the order goes to has no order gate (`market.orders()` is 0): only before the deployment is wired | try again later |
| 400 | `wrong_relayer` | the order's `relayer` is not this relayer | quote again from this relayer, sign and prove a new order |
| 400 | `not_sponsored` | a fee-less action this relayer does not sponsor | send it yourself (the contract functions are permissionless) |
| 400 | `busy` | an order of this pseudonym or nullifier (or spending this 0xbow note, or launching with this salt) is still pending | wait for it (`GET /v1/orders/:id`), then build the next one with the new nonce |
| 400 | `reverted_before` | this exact order already reverted on chain (it is never sent again), or an order of this pseudonym or 0xbow note reverted recently (backed off: 1 min, ×4 per further revert, at most 24 h) | build a new order (the revert's `error` in `GET /v1/orders/:id` says why); after a backoff, retry once the time in `reason` has passed |
| 400 | `deadline_too_soon` | the order's `deadline` < now + `minDeadlineSecs` | quote again, sign and prove a new order |
| 400 | `simulation_failed` | the transaction would revert; `reason` is the decoded contract error, e.g. `Slippage()`, `CapExceeded()`, `WrongNonce()` (stale nonce), `NullifierUsed()` (already executed), `UnknownRoot()`, `InvalidProof()` (a changed order), `Expired()`, `PrivacyPoolRequired()`, `NotLaunchKey()` / `WrongToken()` (a launch), a 0xbow adapter error (`WrongPrivacyPoolAmount()`, `NotProcessor()`, `PoolVault_…`), or a Railgun one (`NotBoundToOrder(i)`, `NotAWbnbUnshield(i)`, `WrongUnshieldAmount(…)`, Railgun's own `RailgunSmartWallet: …` / `RailgunLogic: …` text, e.g. an invalid SNARK proof, a spent nullifier, an unknown merkle root or `Gas price too low`) | fix the cause; nothing was sent |
| 400 | `market_paused` | the token's market is paused by its guardian (`MarketPaused()`): while it is paused every market action reverts (launches, buys, sells, funding, graduation, withdrawals, the fee recipient change, curve fee claims; `collectLpFees` is outside the market and still goes through) | nothing was sent; do not resubmit in a loop: submit the identical order again after the unpause (`paused()` on the market, or the MCP's `status`), it stays valid until its `deadline` |
| 400 | `fee_too_low` | the order's `fee` is below the gas cost at the current gas price (e.g. a completing buy signed with a `standard` quote) | quote again (in the right gas class), sign and prove a new order |
| 400 | `broadcast_failed` | no submission endpoint accepted the transaction (for a trade: no private endpoint; trades never fall back to a public RPC) | nothing was sent: resubmit the identical order, now or a little later |
| 400 | `nothing_to_claim` | a sponsored `collectLpFees` / `claimDevFees` whose BNB payout would not cover its gas (token-side LP fees alone do not count) | nothing was sent; claim once more BNB fees have accrued, or send the claim yourself (permissionless) |
| 404 | `not_found` | unknown route or order id | |
| 413 | `too_large` | body over the size limit (128 KiB by default) | |
| 415 | `unsupported_media_type` | `POST` without `Content-Type: application/json` | |
| 429 | `rate_limited` | too many requests, orders or sponsored actions from this IP address | retry after the `Retry-After` header |
| 500 | `internal` | unexpected relayer error | retry; check `GET /v1/orders/:id` if an id was returned |
| 503 | `overloaded` | too many orders being simulated or pending at once | nothing was sent: resubmit the identical order shortly |
| 503 | `simulation_unavailable` | the relayer could not read the chain to simulate the order (an RPC failure, not a revert) | nothing was sent: resubmit the identical order shortly |
| 400 | `sponsor_budget` | a sponsored action while the relayer's daily budget for sponsored gas is used up or the gas price is above its limit for sponsored actions | nothing was sent: retry later, or send it yourself (permissionless) |
| 503 | `relayer_underfunded` | the relayer's gas balance is too low | retry later |
| 503 | `misconfigured` | the relayer is not configured | retry later |
| 503 | `unavailable` | the relayer is temporarily unavailable | retry after the `Retry-After` header |

The MCP tools turn these into hints for the agent (`src/errors.ts`); [AGENT_GUIDE.md §7](AGENT_GUIDE.md#7-failure-handling)
lists the contract errors and what to do.

## Limits

Per client IP address: 120 requests per minute on every route, 20 `POST /v1/orders` per minute, and a separate
per-minute cap on sponsored actions (operator settings; a refusal is `429 rate_limited` with `Retry-After`). Request
bodies up to 128 KiB. A Railgun-paid order carries at most 8 Railgun transactions of at most 16 nullifiers and 16
commitments each, ciphertext annotation data up to 1 KiB and memos up to 2 KiB (`bad_field` above that). The relayer sees the client's IP address and the time of each order: use a VPN or Tor if that
matters.
