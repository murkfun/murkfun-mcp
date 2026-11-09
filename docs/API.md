# MurkFun indexer API

The MurkFun indexer reads MurkFunFactory, MurkFunMarket, MurkFunDex, MurkFunLocker, MurkFunInfinityHook and
MurkFunPrivacyPoolAdapter events, plus the swaps of each graduated token's PancakeSwap pool on whichever venue it
graduated to (Infinity `CLPoolManager.Swap` filtered by our PoolId, v3 pool `Swap`, V2 pair `Swap`/`Sync`), and
serves this JSON API. Only the factory's address is configured: every market the factory has used, each market's
Dex, each Dex's locker, hook and pool manager, and the 0xbow adapter are discovered from the chain (`MarketSet`,
`ChangeExecuted` re-points, `market.dexOf` / `dex.lockerOf` / `hookOf` at each graduation, the privacy-funder
allowlist) and followed for good: a token is always served through the market it was listed in and the Dex, locker and
hook that graduated it. The website and the MCP tools
(`list_launches`, `token_info`) can both use it. It never holds keys. The only write endpoints are the IPFS uploads for
token images and metadata ([below](#ipfs-token-images-and-metadata)), which MurkFun pins on IPFS.

Trading is not part of this API: trades are proved orders sent to the relayer, documented in
[RELAYER_API.md](RELAYER_API.md) (an agent reaches it through the `murkfun-mcp` tools or their shell commands,
[AGENT_GUIDE.md](AGENT_GUIDE.md#how-your-agent-talks-to-murkfun)).

**Deployment:** MurkFun serves this API at `https://api.murk.fun/v1` (`indexerUrl` in the MCP's
[networks/bsc.json](../networks/bsc.json)). Answers may be up to ~10 s older than the chain (cached). The holder set
routes ([below](#holder-set-v1holders)) are served at `https://murk.fun/v1/holders/*` (`holdersApi` in the same file).

- Base URL: `https://api.murk.fun/v1`.
- `GET` only (except `POST /v1/ipfs/image` and `/v1/ipfs/metadata`), CORS `*` for reads, `Cache-Control: max-age=2`. The uploads are for the MCP / CLI: no CORS, and a request carrying an `Origin` header (a web page) is refused (403 `browser_upload`).
- Amounts are JSON numbers in whole units (BNB, tokens; 18 decimals already applied). Prices are **BNB per token**;
  fields ending in `Usd` / `usd` are US dollars ([USD values](#usd-values)).
- Addresses (tokens, markets, pools, funders, traders, recipients, every contract) are EIP-55 checksummed in every
  answer. An address in a URL or a query may be written in any letter case.
- Timestamps are unix seconds from block time. "24h" windows are measured from the indexed chain head time, not the
  server clock.
- Errors: `{ "error": "..." }` with status 400 (bad parameter) or 404 (unknown token or route).

## USD values

BNB/USD comes from Chainlink's BNB/USD feed on BSC (`0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE`, `description()`
"BNB / USD", 8 decimals), read on chain: no API key, no third-party price service.

- Every trade stores the feed's price at the trade's block (`latestRoundData` at that block, also for history and
  backfills). If that read fails, the nearest block's stored price is used; a trade with no price known yet has
  `usd: null` until it is filled in. A USD value is always the value at trade time: it is never re-priced with
  today's BNB.
- `priceUsd` / `marketCapUsd` of a token: its last trade's price × BNB/USD of that trade's block (× total supply). A token
  with no trade yet: its start price × the current BNB/USD.
- `volumeUsd` / `volume24hUsd` (token and `/stats`): the sum of the trades' USD values; null while any trade in the sum
  has no price yet (never a partial sum).
- `bnbUsd` on `/stats` and `/tokens/:address`: the current price, `{ "price": 612.4, "updatedAt": 1793290000, "source":
  "chainlink" }` (`updatedAt` = the feed's own update time), re-read every ~30 s; null when no feed is readable.
- When the feed can not be read, every USD field is null.

## Pseudonyms

Every MurkFun holder appears per token as a pseudonym (H(secret, token), derived from the wallet's seed signature; [SIGNED_ORDERS.md](SIGNED_ORDERS.md)). The API shows it as
a short id: `#` + the last 4 hex digits of the pseudonym, e.g. `#a3f2`.

- Short ids are only meaningful inside one token. The same `#a3f2` in two tokens is two unrelated identities.
- No endpoint is keyed by pseudonym across tokens, by design. Pseudonyms of different tokens are not linkable from
  the proofs alone (the wallet's operator, the user's RPC, MurkFun's servers by IP address, and timing or amounts can
  still link them), and the API does not try to link them.
- Two holders of one token can share a short id (1 in 65,536 per pair). Filtering trades by short id is a suffix match.

## Endpoints

### `GET /v1/health`

```json
{ "ok": true, "cursor": 130267393, "cursorTime": 1793233864, "head": 130267396, "lag": 3, "reorgs": 0, "lastError": null }
```

`cursor` is the last fully indexed block. `lag = head - cursor` (the indexer stays a few blocks behind head).

### `GET /v1/privacy-funding`

The curve-phase privacy-pool funding rule (MurkFunFactory, owner-settable, global: not part of a
token's terms; off on production since 2026-11-09, pending the 24 h timelock: any wallet may fund). While `requiredOnCurve` is true, BuyDirect / Fund orders and creator buys of a token still on its curve accept BNB
only from an address in `allowlist` (the deploy script lists MurkFun's two adapters: MurkFunPrivacyPoolAdapter for 0xbow and
MurkFunRailgunAdapter for Railgun); 0xbow buys always come from 0xbow, Railgun buys from a Railgun unshield; after
graduation the rule does not apply. The current state is re-read from the factory at indexer start and after every
`PrivacyFundingRequiredSet` / `PrivacyFunderSet` event; `history` comes from those indexed events (newest first, ≤ 200).
`{ requiredOnCurve: bool | null, allowlist: address[], asOfBlock: number | null, appliesTo: string,
history: [{ event: "funding_required_on" | "funding_required_off" | "funder_added" | "funder_removed", funder, block, tx, ts }] }`
(`requiredOnCurve: null` = the indexer could not read it, e.g. an older factory). The same `{requiredOnCurve, allowlist,
asOfBlock}` is in `GET /v1/params` as `privacyFunding` (or `null`).

### `GET /v1/params`

The CURRENT defaults, i.e. the terms a token listed now gets (`MurkFunFactory.currentTerms()` + MurkFunDex settings, re-read at
every indexer start; the factory owner can change them within bounds). Each token keeps the terms it
was listed with: see `terms` in `GET /v1/tokens/:address`.
`chainId, appliesTo ("new tokens"), market, markets, factory, locker, dex, hook, clPoolManager, privacyPoolAdapter,
totalSupply, curveSupply, lpSupply,
graduationRaiseBnb, startPriceBnb, endPriceBnb, holderCapBps, devCapBps, tradeFeeBps, devFeeShareBps, routerFeeBps,
lockerDevShareBps, infinityFeeBps, graduationVenues, repairBudgetBps, privacyFunding`. `holderCapBps`: the most one
pseudonym may hold of a token on its curve, in bps of the supply. `devCapBps` (default 3000 = 30%): the platform's dev
limit, the most the dev pseudonym may hold on the curve; never below `holderCapBps`, set by the factory owner only (a
dev does not choose it). `infinityFeeBps` (default 100 = 1%):
the post-graduation fee MurkFunInfinityHook charges in BNB on every swap of a token's Infinity pool. There is no 0xbow
minimum: a buy only has to exceed its relayer fee. `market` is the factory's current market (new tokens are listed
there); `markets` is every market the factory has used, oldest first (each keeps serving the tokens listed in it).
`dex`, `hook`, `clPoolManager`, `locker`: what the current market's Dex uses for the next graduation (a graduated
token's own are in its `graduation`). `privacyPoolAdapter`: the MurkFunPrivacyPoolAdapter (0xbow's processor) or null.

`graduationVenues` is the order MurkFunDex tries (`venueAt(0..3)`):
`[{ "kind": "pancake-infinity", "feeTier": 0 }, { "kind": "pancake-v3", "feeTier": 10000 },
{ "kind": "pancake-v3", "feeTier": 2500 }, { "kind": "pancake-v2", "feeTier": 2500 }]`. Fee tiers are the pools' LP
fees in hundredths of a bip (10000 = 1%); Infinity's is 0 (its LP is burnt; the hook's fee is `infinityFeeBps`).

### `GET /v1/stats`

Platform totals: `tokens, graduated, onCurve, trades, trades24h, volumeBnb, volume24hBnb, volumeUsd, volume24hUsd,
bnbUsd, openPositions` (count of
(token, pseudonym) pairs with a non-zero balance), `privacyPoolBuys, bnbWithdrawals {count, bnb}, tokenWithdrawals
{count}, fees {platformBnb, devBnb, relayerBnb, lpFeesCollectedBnb, postGraduationFeesBnb}, feeClaims {count, bnb,
paidAsWbnb {count, bnb}}, asOf`. `postGraduationFeesBnb` is every BNB fee the Infinity hook has charged (all tokens,
MurkFun-routed and direct swaps); `platformBnb` / `devBnb` include it, split by each token's `lockerDevShareBps` (and
the curve fee by `devFeeShareBps`; the router fee is the platform's). `feeClaims`: payouts of the market's fee claims
(curve / router / relayer fees) and of the hook's; `paidAsWbnb` is what arrived as WBNB because the recipient rejects
BNB (every MurkFun fee payout falls back to WBNB).

### `GET /v1/launches`

| Query | Values | Default |
|---|---|---|
| `sort` | `new` (newest first), `progress` (curve progress, graduated first), `volume` (24h volume), `mcap`, `active` / `lastTrade` (most recent trade first; a token with no trade yet counts from its launch) | `new` |
| `status` | `all`, `curve` (not graduated, incl. sold out), `graduated`, `sold_out` | `all` |
| `q` | substring of name / symbol / address | |
| `limit`, `offset` | `limit` ≤ 200 | 50, 0 |

Response: `{ total, sort, items: Launch[] }` where a `Launch` is:

```json
{
  "address": "0x…", "name": "Bog Frog", "symbol": "BOGF", "metadataUri": "ipfs://bafkrei…", "createdAt": 1793183330, "createdBlock": 130265200,
  "image": "https://api.murk.fun/v1/ipfs/bafkrei…",
  "metadata": { "uri": "ipfs://bafkrei…", "cid": "bafkrei…", "mutable": false, "status": "ok",
    "description": "Lives at the bottom of the bog.", "image": "ipfs://bafkrei…", "imageUrl": "https://api.murk.fun/v1/ipfs/bafkrei…",
    "links": { "telegram": "https://t.me/example" } },
  "status": "curve | sold_out | graduated",
  "progress": 0.953,
  "curve": { "tokensSold": 762400000, "curveSupply": 800000000, "bnbReserve": 8.61, "graduationRaiseBnb": 10 },
  "priceBnb": 3.84e-8, "marketCapBnb": 38.4, "priceUsd": 2.35e-5, "marketCapUsd": 23516.2, "change24h": 0.42,
  "volumeBnb": 14.4, "volume24hBnb": 9.1, "volumeUsd": 8790.5, "volume24hUsd": 5571.8,
  "trades": 542, "trades24h": 300, "buys": 500, "sells": 42,
  "holders": 147, "lastTradeAt": 1793290000,
  "lastTrade": { "id": 9120, "who": "#a3f2", "side": "buy", "bnb": 0.35, "usd": 214.3, "at": 1793290000, "source": "murkfun" },
  "venue": null,
  "devCapBps": 3000,
  "moderation": "ok | flagged | hidden"
}
```

- `name`, `symbol`, `metadataUri`, `metadata`, `image` are `null` when moderation withholds them (`moderation`, see
  [Moderation](#moderation)): show the address and a placeholder.
- `metadata` (null when the token has no URI or the API has no IPFS uploads): the off-chain document
  ([TOKEN_METADATA.md](TOKEN_METADATA.md)) as re-pinned and validated by MurkFun. Show it only when `status` is
  `ok`; `pending` = not fetched / pinned yet (retrying), `invalid` = not a ≤ 16 KB v1 JSON document, `mismatch` = its
  name / symbol differ from the chain (ignored, per spec), `external` = an `https://` URI (`mutable: true`, not fetched),
  `unsupported` = anything else (`data:` …). `description` is plain text; `links` only https URLs under `website`, `x`,
  `telegram`, `discord`, `github`. `imageUrl` / top-level `image`: the image through this API once it is pinned
  (`https://api.murk.fun/v1/ipfs/<cid>`).
- `status`: `curve`; `sold_out` = the buy that sold out the curve could not graduate the token in the same transaction
  (its automatic graduation failed: `graduation.failures`); buys wait until anyone retries with `graduate(token)`
  (sells to the curve still work while the market is not paused); `graduated`. The selling-out buy normally graduates the token itself, so `sold_out` is rare.
- `progress` = tokens sold / curve supply (1 once graduated). `curve` is the state after the last curve trade, as its
  `Bought` / `Sold` event reports it (`bnbReserve`, `tokensSold`). `holders` = pseudonyms holding a non-zero balance inside MurkFun.
- `priceBnb` is the curve's marginal price after the last trade (the event's `price`), or the pool price after the last
  swap once graduated.
- `lastTrade`: the token's latest trade on any venue (null before the first one). `who` is the pseudonym's short id in
  this token, null for an `external` swap on the graduated pool; `id` is the trade's id (as in `/trades`), so a client
  polling `sort=lastTrade` can tell a new trade from the one it already showed.
- `marketCapBnb` = `priceBnb` × total supply. `change24h` compares with the last price at or before 24 h ago (in BNB).
- `priceUsd`, `marketCapUsd`, `volumeUsd`, `volume24hUsd`, `lastTrade.usd`: USD at trade time ([USD values](#usd-values));
  `priceUsd` / `marketCapUsd` are null while unknown.
- `venue` after graduation: `{ "kind": "pancake-infinity" | "pancake-v3" | "pancake-v2", "pool": "0x…", "poolId": "0x…" | null, "feeTier": 10000 }`.
  For Infinity, `pool` is the shared CLPoolManager and `poolId` identifies MurkFun's pool (native BNB / token, LP fee 0,
  tick spacing 200, `MurkFunInfinityHook`), and the object also has `hookFeeBps` (the token's fee in BNB, e.g. 100); for
  v3 / V2 `pool` is the pool / pair and `poolId` is null.
- `devCapBps`: the most the token's dev pseudonym may hold on the curve, in bps of the supply: the platform's dev limit
  (`/params` `devCapBps`) as snapshotted in the token's terms at listing (`devCap` / `totalSupply`); a later parameter
  change never alters it. Every other pseudonym is bounded by the token's `holderCapBps`.

### `GET /v1/tokens/:address`

A `Launch` plus:

```json
{
  "bnbUsd": { "price": 612.4, "updatedAt": 1793290000, "source": "chainlink" },
  "createdTx": "0x…",
  "dev": { "pseudonym": "#5be0", "capBps": 3000, "feeRecipient": "0x…" },
  "terms": { "totalSupply": 1000000000, "curveSupply": 800000000, "lpSupply": 200000000, "graduationRaiseBnb": 10,
    "holderCapBps": 100, "devCapBps": 3000, "tradeFeeBps": 100, "devFeeShareBps": 3000, "routerFeeBps": 0,
    "lockerDevShareBps": 5000, "infinityFeeBps": 100, "startPriceBnb": 3.125e-9, "endPriceBnb": 5e-8 },
  "fees": { "tradeFeeBps": 100, "curveFeesBnb": 0.1, "routerFeesBnb": 0, "hookFeesBnb": 0.02, "toPlatformBnb": 0.08,
    "toDevBnb": 0.04, "relayerFeesBnb": 0.11 },
  "curveCompleted": { "at": 1793283914, "block": 130458160, "tx": "0x…", "bnbReserve": 10.0, "priceBnb": 2.8e-8,
    "bnbUsd": 612.4, "bnbReserveUsd": 6124.0, "priceUsd": 1.71e-5 },
  "privacyPoolBuys": 510,
  "buysPaidFrom": { "privacypool": { "count": 510, "bnb": 30.2 }, "railgun": { "count": 12, "bnb": 4.1 },
    "direct": { "count": 1, "bnb": 0.2 }, "balance": { "count": 40, "bnb": 3.3 } },
  "withdrawals": { "bnb": { "count": 3, "amount": 0.05 }, "tokens": { "count": 1, "amount": 4000000 } },
  "graduation": { … same as /graduation … }
}
```

`buysPaidFrom` counts MurkFun buys by what paid for them (see `fundedBy` below). `fees`: `curveFeesBnb` (the curve fee),
`routerFeesBnb` (MurkFun's post-graduation router fee, 0 by default), `hookFeesBnb` (the Infinity hook's BNB fee on
every swap of the token's pool, MurkFun-routed or not; 0 off Infinity); `toPlatformBnb` / `toDevBnb` split all three
(curve fee by `devFeeShareBps`, hook fee by `lockerDevShareBps`, router fee to the platform). `curveCompleted`: the
buy that sold out the curve (`CurveCompleted`: final reserve and last curve price, = the LP opening price; in USD at
that buy's BNB/USD, null while unknown), or null.
`feeRecipient` is the latest one (`DevFeeRecipientSet`), else the one set at creation. `dev.capBps` = `devCapBps`.
`terms`: the token's own terms, snapshotted when it was listed (later parameter changes never alter them), with the
caps in bps of the supply (`holderCapBps`, `devCapBps`).

### `GET /v1/tokens/:address/trades`

| Query | | Default |
|---|---|---|
| `limit` | ≤ 500 | 50 |
| `before` | trade `id` for paging (use `next` from the previous page) | |
| `pseudonym` | `#a3f2` (suffix match) or the full 0x… 32-byte value; only within this token | |

```json
{ "items": [ {
  "id": 1203, "tx": "0x…", "block": 130267001, "at": 1793230000,
  "side": "buy | sell | fund", "venue": "curve | pancake-infinity | pancake-v3 | pancake-v2 | null", "source": "murkfun | external",
  "who": "#a3f2", "isDev": false, "trader": null,
  "bnb": 0.0198, "tokens": 412345.6, "fee": 0.000198, "hookFee": null, "priceBnb": 4.1e-8,
  "usd": 12.13, "bnbUsd": 612.4, "priceUsd": 2.51e-5, "feeUsd": 0.12, "hookFeeUsd": null,
  "fundedBy": "privacypool | railgun | direct | balance | wallet | null", "creatorBuy": false, "completesCurve": false,
  "curveAfter": { "tokensSold": 762400000, "bnbReserve": 8.61 }, "relayerFee": 0.0002
} ], "next": 1163 }
```

- `usd` = `bnb` × `bnbUsd`, the BNB/USD price at the trade's block; `priceUsd` = `priceBnb` × `bnbUsd` (null for fund
  rows); `feeUsd` = `fee` × `bnbUsd` and `hookFeeUsd` = `hookFee` × `bnbUsd` (null when `hookFee` is). All are null
  until the trade's BNB/USD is known.
- `bnb` is the gross BNB of the trade (fees included). `fee` is MurkFun's fee (1% on the curve, router fee after
  graduation). `hookFee` (Infinity only, else null): the BNB MurkFunInfinityHook charged on this trade (MurkFun rows:
  the `venueFee` of `Bought` / `Sold`, exact; external rows: derived from the pool amounts and the token's fee, exact
  within 1 wei). On Infinity a buy's `bnb` is what the trader paid in total and a sell's is what the pool paid out
  before both fees (the pseudonym received `bnb − fee − hookFee`). A MurkFun trade's total fee is `fee + hookFee`.
- A buy for more BNB than it needs (the buy that sells out the curve, or an exact-out buy) only spends what it used:
  `bnb` is that; the rest stays in the pseudonym's BNB balance in MurkFun. `completesCurve`: this buy sold out the curve
  (`CurveCompleted`; it graduates the token in the same transaction). `curveAfter` (curve trades, else null): tokens
  sold and BNB reserve right after the trade, from the event.
- `creatorBuy`: the dev's first buy inside the launch transaction (a Launch order with a creator buy): creating a token is the dev's
  first buy, up to 30% of the supply (the platform's dev limit, `devCapBps`; the dev does not set it), and nobody can
  buy before it. While the factory's privacy-funding rule is on (`GET /v1/privacy-funding`; the owner can change it
  through the 24 h timelock) it is paid from a privacy pool like any other curve buy (0xbow through
  MurkFunPrivacyPoolAdapter, or Railgun through MurkFunRailgunAdapter; `fundedBy` says which); on chain its `DirectBuyFunded.from` is the factory.
- `source: "external"` rows are swaps made directly on the graduated Pancake pool by anyone (aggregators, Pancake's
  router, bots); `who` is null and `trader` is the transaction's sender (`tx.from`; the swap's own sender is usually a
  router contract). Swaps routed by MurkFun (swap sender = MurkFunDex) are reported once, from the market's `Bought`/`Sold`
  event, with the pseudonym and the pool price after the swap.
- Amounts of external trades: for a buy `bnb` includes the pool's LP fee (v3 / V2) or the hook fee (Infinity, LP fee
  0); for a sell it is the pool's BNB output (on Infinity the trader received `bnb − hookFee`).
- `fundedBy` (buys): `privacypool` = paid from a 0xbow note in the same transaction (any amount; MurkFunPrivacyPoolAdapter
  withdraws it and pays it into a BuyDirect order); `railgun` = a BuyDirect order paid by MurkFunRailgunAdapter from a Railgun
  unshield in the same transaction; `direct` = a BuyDirect order paid by another address; `balance` = it spent the pseudonym's internal BNB balance
  (sell proceeds, a completing buy's change, or an earlier funding row).
- `side: "fund"` rows are Fund-order credits (no trade): `bnb` = the amount, `trader` = the funding address
  (public), `fundedBy` = `railgun` (from MurkFunRailgunAdapter) or `wallet`. They have negative ids, are listed between the
  trades of the same page (newest first), and are never a paging cursor.

### `GET /v1/tokens/:address/holders`

```json
{
  "totalSupply": 1000000000, "holderCount": 147, "holderCapTokens": 10000000, "top10Share": 0.087,
  "buckets": [
    { "label": "pseudonyms", "tokens": 762400000, "share": 0.7624 },
    { "label": "curve_unsold", "tokens": 37600000, "share": 0.0376 },
    { "label": "lp_reserved", "tokens": 200000000, "share": 0.2 }
  ],
  "holders": [ { "rank": 1, "who": "#5be0", "isDev": true, "tokens": 29000000, "share": 0.029 } ],
  "note": "…"
}
```

Buckets before graduation: `pseudonyms`, `curve_unsold`, `lp_reserved`. After graduation: `pseudonyms` (still inside
MurkFun), `pancake_pool` (pool reserves at the cursor block, see `poolBalances` below), `burnt` (graduation leftovers sent to 0xdead),
`outside_murkfun` (everything else: withdrawn tokens and Pancake buyers' wallets, not attributed). `holderCapTokens` is
null after graduation (no cap). `limit` ≤ 1000, default 100.

### `GET /v1/tokens/:address/candles`

| Query | | Default |
|---|---|---|
| `interval` | `1m`, `5m`, `15m`, `1h`, `4h`, `1d` | `5m` |
| `limit` | most recent N candles, ≤ 2000 | 300 |
| `fill` | `0` disables gap filling | filled |

```json
{ "interval": "5m", "startPriceBnb": 3.125e-9, "graduatedAt": 1793260000,
  "candles": [ { "t": 1793183400, "o": 3.125e-9, "h": 3.2e-9, "l": 3.125e-9, "c": 3.2e-9, "v": 0.06, "n": 3,
    "oUsd": 1.91e-6, "hUsd": 1.96e-6, "lUsd": 1.91e-6, "cUsd": 1.96e-6, "vUsd": 36.7 } ] }
```

`oUsd`…`cUsd` / `vUsd`: the same candle in USD, each trade at the BNB/USD of its own block (the first candle opens at the
start price × the first trade's BNB/USD); null when no BNB/USD is known.

Prices come from every trade (curve marginal price after the trade, or the pool price after the swap). The first
candle opens at the curve start price; each candle opens at the previous close; empty buckets are filled flat with
`v = n = 0` up to the head time.

### `GET /v1/tokens/:address/graduation`

```json
{
  "graduated": true,
  "configuredOrder": [ { "kind": "pancake-infinity", "feeTier": 0 }, { "kind": "pancake-v3", "feeTier": 10000 }, … ],
  "lpFeeSplit": { "devBps": 5000, "platformBps": 5000 },
  "venue": "pancake-infinity", "pool": "0xa0ff…058b", "poolId": "0x1d91…d7ab", "feeTier": 0,
  "dex": "0x…", "locker": null, "hook": "0x…", "positionId": "1625525",
  "bnbRangePositionId": "1625524", "tx": "0x…", "at": 1793283914, "block": 130458160,
  "liquidity": { "bnb": 9.99999999, "tokens": 199999999.8 }, "repaired": false,
  "leftovers": { "tokensBurnt": 0.2, "wbnbToTreasury": 1e-8 },
  "skippedVenues": [], "failures": [],
  "trades": { "murkfun": { "trades": 53, "volumeBnb": 4.45, "routerFeesBnb": 0, "hookFeesBnb": 0.0445 },
    "external": { "trades": 19, "volumeBnb": 7.17 } },
  "lp": { "form": "burnt", "nft": "0x55f4…c226", "positionId": "1625525", "bnbRangePositionId": "1625524",
    "owner": "0x000000000000000000000000000000000000dead" },
  "postGraduationFees": { "currency": "BNB", "feeBps": 100, "swaps": 72, "earnedBnb": 0.1162, "fromMurkFunTradesBnb": 0.0445,
    "fromOtherTradesBnb": 0.0717, "paidBnb": 0.1, "unpaidBnb": 0.0162, "claims": 2, "toDevBnb": 0.05, "toPlatformBnb": 0.05,
    "paidAsWbnb": 0 },
  "lpFeesCollected": { "count": 0, "bnb": 0, "tokens": 0 },
  "poolBalances": { "tokens": 234867750.4, "bnb": 8.53, "block": 130458520, "method": "ranged positions" }
}
```

- `venue` / `feeTier`: where MurkFunDex graduated the token (`Graduated` event; same as `market.venueOf`). `dex`: the
  Dex that graduated it and routes its MurkFun trades (`market.dexOf(token)`); `locker` (v3 / V2): the MurkFunLocker
  holding its LP (`dex.lockerOf`); `hook` (Infinity): its MurkFunInfinityHook (`dex.hookOf`). A re-pointed Dex, locker or
  hook only applies to later graduations. On Infinity and v3 the LP is two ranged positions (all the BNB on [curve start
  price, graduation price], the LP tokens above the graduation price):
  `positionId` is MurkFunLocker's `Locked.id`, the token range's NFT (v3 NFT / Infinity CLPositionManager NFT owned by
  0x…dEaD), and `bnbRangePositionId` the BNB range's (`RangesPlaced.bnbId`); on V2 (full range) `positionId` is the
  principal claim on sqrt(k) and `bnbRangePositionId` is null.
- `lp`: Infinity `{form: "burnt", nft: <CLPositionManager>, positionId, bnbRangePositionId, owner: 0x…dEaD}`; v3 / V2
  `{form: "locked", holder: <MurkFunLocker>, positionId, bnbRangePositionId}`.
- `postGraduationFees` (Infinity only, else null): the hook's BNB fee on every swap through the pool (`SwapFee` events,
  split into MurkFun-routed and other trades) and its payouts (`FeesClaimed`, dev / platform; `paidAsWbnb`: the part
  paid as WBNB to a recipient that rejects BNB). `trades.murkfun.hookFeesBnb` / `routerFeesBnb`: the fees MurkFun-routed
  trades paid (`Bought` / `Sold` `venueFee` and `fee`). `lpFeesCollected` is the
  v3 / V2 locker's `Collected` (both assets); it stays 0 on Infinity (no LP fees; the LP is burnt).
- `failures`: one entry per `GraduationFailed`: the automatic graduation inside the selling-out buy reverted (`reason`
  decoded like `skippedVenues`, `reasonData` raw); the token stays `sold_out` until `graduate(token)` (permissionless,
  the retry) succeeds.
- `skippedVenues`: one entry per `GraduationVenueSkipped` (venues tried before the one that worked). `reason` is the
  decoded revert (a MurkFunDex / MurkFunLocker error name or `Error(string)`), else the raw data; `reasonData` is the raw
  revert data.
- `trades`: post-graduation trades on the pool, routed by MurkFun vs. made directly on Pancake.
- `poolBalances`: v3 / V2 = `balanceOf(pool)` for the token and WBNB (`method: "balanceOf"`). Infinity keeps every
  pool's funds in the shared Vault, so the amounts are what MurkFun's two ranged positions hold at the pool's current
  price (`method: "ranged positions"`, `MurkFunLocker.reservesOf(token)`; other LPs' liquidity is not included).
- `repaired` is only meaningful for v3 (a pre-initialised pool moved to the curve price).

Before graduation only `graduated: false`, `configuredOrder`, `lpFeeSplit`, `skippedVenues` and `failures` are present.

## Holder set: `/v1/holders/*`

The holder set every MurkFun order proves membership in (`SIGNED_ORDERS.md` §4), shown on the site's "BN agent
holders" tab (币安智能体持有者): every SPACE ID Agent ID holder on BSC that claimed its Agent ID through
`HandleRegistry.register` (the user path), and the MurkFunHolderRoots batches
(`0xD59867DADC96202284Fa54d016C6d66a0adBaE24`) that put them in the depth-26 Poseidon2 tree.

- **Who answers.** MurkFun's holder-set service keeps the whole set in memory and answers every route; the API's
  cache keeps each answer for 15 s and serves the last one (up to 600 s) while the service is
  unreachable (`x-murkfun-cache: hit | miss | stale`). It is a convenience, never a trust anchor: every answer can be
  checked against the chain, and `murkfun-holders tree` (https://github.com/murkfun/holder-roots) rebuilds the whole
  set from the contract's events by itself.
- **`source`** in every answer: `chain` (the registry's and HolderRoots' events read over RPC by the service).
  **`asOfBlock`**: the BSC block the data is complete up to (the finalized head the service scanned to).
- The batches are always the contract's own: the live posted batches, each with its challenge window (`usableFrom`,
  as the contract fixed it at posting) and whether it is **accepted** (past its window and not held by an open origin
  dispute of it or an earlier batch: the roots orders can prove against). Roots are recomputed from the posted lists
  and compared with the posted ones (`rootMismatches`).
- Leaf = Poseidon2(address), empty leaf 0, 2^16 batch slots × 1024 leaves. Field elements are `0x` + 64 hex digits.
  Addresses are EIP-55. Mint times come from block timestamps (the chain source interpolates between block
  timestamps read at most 50,000 blocks apart; BSC blocks come at a fixed interval).

### `GET /v1/holders/summary`

```json
{ "holders": 174745, "registered": 174745, "adminMinted": 0, "included": 174700, "pending": 45, "queued": 0,
  "challengeable": 0, "batches": 176,
  "currentRoot": "0x29cc3dbe7e1abf3d133b616056e401879d8486e42a57b9342e336e80661cf5a6",
  "acceptedRoot": "0x21eaaf77c583b91df289d173baf2e389543ed7aaec8f8b763d83e6e04b83da46", "acceptedBatch": 174,
  "lastBatchAt": 1794470400, "nextBatchAt": 1794474000, "challengePeriod": 3600, "rootHistory": 64,
  "openDisputes": 0, "rootMismatches": [], "registry": "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F",
  "holderRoots": "0xD59867DADC96202284Fa54d016C6d66a0adBaE24", "operator": "0x7EB4E00c640F56A395a678d927f8bED75b66A84C",
  "owner": "0x7EB4E00c640F56A395a678d927f8bED75b66A84C", "bond": "0", "minBond": "0", "disputeDeposit": "0",
  "syncedBlock": 132605000, "syncedTime": 1794472380, "syncedAt": 1794472400, "syncing": false, "lastError": null,
  "source": "chain", "asOfBlock": 132605000 }
```

`included` = addresses in a live batch; `pending` = `register` holders in none; `queued` = live forced-inclusion
entries; `challengeable` = listed addresses a fraud proof can remove plus leaves a fraud proof removed (below).
`currentRoot` = root after the last live batch; `acceptedRoot` / `acceptedBatch` = the newest accepted one (`null`
before the first). `nextBatchAt` = the operator's next batch (one per hour after the last one; `null` while nobody
waits). `challengePeriod` / `rootHistory` / `minBond` / `disputeDeposit` = the contract's current parameters.
`syncedTime` = the time of `syncedBlock`; `syncedAt` = when the service finished that round. `owner` and `operator`
are the same EOA today: the holder set has no timelock and no pause, its owner is not a multisig, and `minBond` is 0
(the governance section of https://github.com/murkfun/holder-roots).

### `GET /v1/holders/lookup?q=<0x address | name | name.ai>`

`status`:

| status | meaning |
|---|---|
| `included` | in batch `batch` at `position`; `accepted` = the batch is accepted; `proof` (only then) = `{ leaf, leafIndex, siblings[26] (leaf level first: 10 in the batch, 16 across batches), root, rootBatch, batchRoot }` against the accepted root; before that `usableFrom` says when the batch's window ends |
| `pending` | `register` holder in no batch yet; `eta` = the next batch; `queued` = its forced-inclusion entry `{ position, at }` |
| `admin_minted` | minted with `adminRegister`: excluded |
| `challengeable` | `reason`: `admin_minted_included` (`disputeOrigin`, only inside the batch's challenge window), `not_holder_included` (`challenge`, any time) or `neutralized` (a fraud proof removed it) |
| `not_holder` | no Agent ID |

Also `address`, `handle` (`name.ai`), `origin` (`register` / `admin`), `mint` `{ block, logIndex, tx, time }`,
`batchPostedAt`, `neutralized`. 400 for anything that is neither an address nor a valid handle (a–z, 0–9).

### `GET /v1/holders/batches?page=N`

25 per page, newest first: `{ total, page, pageSize, items: [{ id, count, fromBlock, toBlock, postedAt, usableFrom,
accepted, subtreeRoot, newRoot, tx }] }`. `fromBlock` / `toBlock` = the operator's informational scan range.

### `GET /v1/holders/batch/:id?page=N`

One batch with its addresses, 100 per page in list order: `items: [{ position, address, handle, origin }]` plus the
batch fields and `fromRoot`. 404 for an id that is not a live batch.

### `GET /v1/holders/pending?page=N`

`register` holders in no batch, newest first, 100 per page: `{ total, eta, items: [{ address, handle, block, time, tx,
queued }] }`.

### `GET /v1/holders/challengeable?page=N`

100 per page: `items: [{ address, handle, reason, batch, position, at, tx }]`.

## IPFS: token images and metadata

MurkFun pins the uploads on IPFS. See [TOKEN_METADATA.md](TOKEN_METADATA.md).
Errors: `{ "error": "<code>", "reason": "…" }`.

### `POST /v1/ipfs/image`

Body: the raw bytes of a PNG, JPEG, WebP or GIF, ≤ 1,000,000 bytes (`Content-Type` is ignored; the magic bytes decide;
never SVG), at most 300 frames. The image must already be **square, 256–1024 px** (422 `not_square` / `bad_size` with
the size; it is not resized). It is not decoded: the file is rebuilt at the byte level with only what draws the
picture (EXIF / GPS / XMP / ICC / text chunks / comments / thumbnails / unknown chunks and anything after the end
marker are dropped; a JPEG keeps a minimal EXIF with just its orientation); the pixel data is unchanged. `stripped`
lists what was removed.

Added as CIDv1 (`bafkrei…` up to 256 KiB, `bafybei…` above) and pinned.

```json
{ "cid": "bafkrei…", "uri": "ipfs://bafkrei…", "url": "https://api.murk.fun/v1/ipfs/bafkrei…", "width": 512, "height": 512,
  "bytes": 48213, "format": "png", "animated": false, "stripped": ["eXIf", "tEXt", "trailing data"] }
```

413 over 1 MB, 415 not one of the four formats, 422 malformed / not decodable / wrong size / too many frames, 502
`cid_mismatch` (the pinning answered another CID than the bytes have; nothing is recorded).

### `POST /v1/ipfs/metadata`

`Content-Type: application/json`, body ≤ 32 KB: `{ "name", "symbol", "description"?, "image"?: "ipfs://<CID>",
"links"?: { "website"?, "x"?, "telegram"?, "discord"?, "github"? } }`. Unknown fields / link keys, non-https links,
over-long values or an `image` that is not `ipfs://<CID>` → 400 `bad_metadata` with the reason. The server writes the
canonical document (fixed key order, no whitespace, ≤ 16 KB), adds and pins it:
`{ "cid", "uri", "url", "bytes", "document" }`. `name` / `symbol` must be exactly what `createToken` gets.

Both uploads are rate-limited per IP address, per minute and per day (429 + `Retry-After`), and overall per day (503
`busy`); uploads that no listed token uses yet have a storage budget (507 `storage_budget`). Content that was flagged
or hidden before (same bytes, same CID) is refused: 451 `content_blocked`; so is a document whose text hits the word
list (451). Uploads are published at once.

### `GET /v1/ipfs/:cid`

The bytes of a CID MurkFun knows: a live upload, or a listed token's metadata / image that MurkFun pinned. Anything
else is 404 (it is not an open gateway), and so is anything flagged or hidden by moderation, from that moment (within
about 30 s). `:cid` must be a bare CIDv0 (`Qm…`) or base32 CIDv1 (`b…`): no path, no query (400). 504 when the IPFS
gateway behind it does not answer; capped at 16 KB (metadata) / 1 MB (images). Headers: `Content-Type` from the
sniffed bytes (`image/png|jpeg|webp|gif` or `application/json`), `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: public, max-age=600` and the same
`CDN-Cache-Control` (short: moderation can withdraw a CID).

### Moderation

Content is never held back for review: it is shown when indexed / uploaded. Names, symbols and metadata documents go
through a word list (at upload, or when first seen); images are not scanned by MurkFun itself (the CDN in front of the
public domain scans what passes through its cache for CSAM). The admin
hide list (token address or CID) applies on the next request.
Each token carries `moderation`:

| `moderation` | Meaning | What the API returns |
|---|---|---|
| `ok` | scanned, nothing found | everything |
| `flagged` | the word list matched the description / links (→ metadata and image withheld) or the name / symbol (→ token withheld) | the flagged parts are `null` |
| `hidden` | on the admin hide list (the token, its metadata CID, or its image CID) | token or metadata CID: `name`, `symbol`, `metadataUri`, `metadata`, `image` all `null`; image CID: `image` / `metadata.image*` `null` |
| `null` | the API runs without IPFS uploads (no moderation) | on-chain fields only |

Withheld fields are `null` (show the address and a placeholder). Curve, trades, holders, fees and graduation are never
affected. Withheld CIDs answer 404 on `GET /v1/ipfs/:cid`.

## For the MCP tools

- `list_launches` → `GET /v1/launches?sort=new&limit=<limit>&offset=<offset>`.
- `upload_token_metadata` → `POST /v1/ipfs/image` (if an image is given), then `POST /v1/ipfs/metadata`.
- `token_info` market part → `GET /v1/tokens/:address`. The user's own
  balances must still be read on chain by the MCP with the user's pseudonym (`tokenBalance`, `bnbBalance`), never
  sent to the API: querying the API with your own pseudonym tells the API operator which pseudonym is yours.
