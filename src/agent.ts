// MurkFun tool implementations, independent of the MCP transport (index.ts wires them to stdio MCP).
// Runs on the user's machine: secrets never leave it. Every order is signed by the wallet for exactly that order and
// proven here (orders.ts); only the signed, proved orders are sent to the relayer, which cannot alter them. The
// wallet never sends a MurkFun transaction (its only transactions are 0xbow's: the keystore and deposits).
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  createPublicClient, createWalletClient, http, parseEther, formatEther, encodeFunctionData, encodeAbiParameters, isAddress, getAddress,
  zeroAddress, keccak256, stringToHex, type Address, type Hex, type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { holderRootsFromBlock, type McpConfig } from "./config.js";
import { Vault, type NoteRec, type VaultData, type RailgunRelayRec } from "./vault.js";
import { zkInit } from "./zk.js";
import * as zk from "./orders.js";
import { PrivacyPools, EP, PV, KS, MIN_DEPOSIT, NATIVE, epAbi, ksAbi, vaultAbi, type Note } from "./pp.js";
import { launchDigest, orderData, wireOrder, railgunAbi, railgunGross, TOKEN_SPEC_TUPLE, type Order, type Relay } from "./murkfun.js";
import { marketAbi, factoryAbi, ordersAbi, holderRootsAbi, tokenAbi, lockerAbi, hookAbi, dexAbi, privacyPoolAdapterAbi, railgunAdapterAbi } from "./abi.js";
import { fence } from "./fence.js";
import { RelayerClient, RelayerError, type OrderStatus, type Quote } from "./relayerClient.js";
import { IndexerClient, type Launch } from "./indexer.js";
import { revertName, hintFor, decodeRevert, simulationCode } from "./errors.js";
import { grindDevSalt, launchDevSalt, predictToken, MAX_VANITY_HEX } from "./create3.js";
import { agentNftAbi, noAgentIdMessage } from "./agentId.js";
import { BawSigner } from "./baw.js";
import { freshCurveBuy, capRoom, completesCurve, withSlippage, minBig, type CurveTerms } from "./curve.js";
import { decodeTradeReceipt, type TradeReceipt } from "./receipt.js";
import { fetchHolderLookup, verifyHolderProof, lookupClaim } from "./holdersApi.js";
import { LogRpc, batchProbe } from "./logRpc.js";
import { parseRailgunTxs, checkRailgunTxs, readRailgunTxFile, RailgunTxError, type RailgunRelayAction } from "./railgunRelay.js";
import { agentIdOfName, lookupHolder, parseHolderQuery } from "./holdersLookup.js";
import { checkRecipient as recipientRules, RecipientError, type RecipientCheck } from "./recipients.js";

const BPS = 10_000n;
const fmt = (x: bigint) => formatEther(x);
/** `part` of `whole` in bps (rounded down). */
const bpsOf = (part: bigint, whole: bigint) => Number((part * 10_000n) / whole);
const VENUES: Record<number, string> = { 1: "PancakeSwap Infinity CL", 2: "PancakeSwap v3", 3: "PancakeSwap V2" }; // MurkFunLocker.Venue
/** Shown with a buy that completes the curve. */
const GRADUATION_NOTE = "This buy completes the curve: it fills what is left and graduates the token into its PancakeSwap pool in the same transaction. " +
  "The completing buy pays that graduation gas, so its relayer fee is a completing-buy fee (relayerFee shows it next to a standard buy's fee). " +
  "BNB it does not need stays in your pseudonym's internal balance for this token (buy source=balance or withdraw_bnb). " +
  "If the graduation fails the buy still goes through, and anyone can retry with graduate.";
/** The same for a buy sent by MurkFun's Railgun adapter or another wallet (no relayer). */
const GRADUATION_NOTE_DIRECT = "This buy completes the curve: it fills what is left and graduates the token into its PancakeSwap pool in the same transaction, paying that gas. " +
  "If the graduation fails the buy still goes through, and anyone can retry with graduate.";
const GRADUATION_GAS_HINT = "1.3M (Infinity) to 7M (v3 / V2 fallback) gas";
/** Where BNB a funded buy does not spend goes (an exact-out buy's headroom, the rest of a buy that completes the curve). */
const UNSPENT_NOTE = "BNB the buy does not spend stays in your pseudonym's internal balance for this token: buy source=balance or withdraw_bnb.";
/** The curve-phase funding rule as users read it (MurkFunFactory.privacyFundingRequired). */
const PRIVACY_RULE = "During the curve, MurkFun only accepts BNB from privacy pools, through its own adapters: 0xbow (MurkFun's 0xbow adapter) and Railgun (MurkFun's Railgun adapter, which pays an order exactly what a Railgun unshield sent it); after graduation the token also trades publicly on PancakeSwap.";
/** How the Railgun transaction of a Railgun-paid order is built (`railgun` of buy / fund_pseudonym / create_token
 *  source=railgun). */
const RAILGUN_BUILD = "Railgun (private): with a Railgun wallet or the Railgun SDK, build the Railgun transaction(s) that unshield railgun.unshield.amountWei of railgun.unshield.token (WBNB) to railgun.adapter (MurkFun's Railgun adapter; Railgun keeps railgun.unshield.unshieldFeeBps bps, so exactly railgun.unshield.arrivesWei arrives), unshield type NORMAL, with railgun.adaptContract as the adapt contract and railgun.adaptParams as the adapt parameters (Railgun engine: TransactionBatch.setAdaptID({ contract, parameters })) and minGasPrice 0, and prove them (do not send them to a Railgun broadcaster: they only relay Railgun's own contracts). Railgun's own RelayAdapt cross-contract calls are refused by MurkFun: only the adapter is allowlisted. The rest of your Railgun balance stays shielded.";
/** How it is sent through the MurkFun relayer (`relay`). */
const RAILGUN_RELAY = "Then submit_railgun {transactions} (the proved Railgun transactions as JSON, or the calldata; CLI: murkfun-mcp submit_railgun --transactionsFile <file>) posts relay.body with them to the MurkFun relayer (relay.url) and waits like any order: the relayer checks the binding, simulates and sends MurkFunRailgunAdapter's call itself, and is paid relay.feeBnb by the order. The sender on chain is the shared MurkFun relayer, so no wallet of yours pays gas or links your Railgun buys. Alternative: call railgun.submit.function on railgun.adapter yourself from any account with the transactions, railgun.submit.order (orderEncoded: abi.encode(order)) and railgun.submit.orderProof: that account pays the gas and is public (the relayer fee in the order is paid either way; selfSubmit:true signs an order without it).";
/** The same when the order names no relayer (selfSubmit). */
const RAILGUN_SELF = "Then call railgun.submit.function on railgun.adapter with the transactions, railgun.submit.order (orderEncoded: abi.encode(order)) and railgun.submit.orderProof, from any account: it pays the gas, is public as the sender, and learns nothing about your pseudonyms (this order names no relayer: selfSubmit; without it the MurkFun relayer sends it for a fee, submit_railgun).";
/** Railgun relay records submit_railgun may send (again): not sent yet, or not executed for sure (`dropped`: the relayer
 *  cancelled its transaction; `reverted`: mined and reverted, nothing spent). `submitted` (pending), `failed` (the
 *  relayer lost track: it may still be mined) and `mined` keep the guard. Sending the identical order again is safe
 *  either way: its nonce and the Railgun nullifiers execute at most once. */
const RAILGUN_RESUBMITTABLE = new Set(["pending", "dropped", "reverted"]);
/** Default validity of a Railgun-paid order (minutes): building and proving the Railgun transaction takes a while. */
const RAILGUN_VALID_MINUTES = 30;
/** Headroom on the relayer fee of a Railgun-paid order (bps over the quote): it is submitted only once the Railgun
 *  proof is made (minutes later), and a fee the gas price has outgrown by then (`fee_too_low`) would cost a new order
 *  and a new Railgun proof. The fee with it is what the wallet signs, so that fee is what every limit is checked on
 *  (checkRelayQuote: MURKFUN_MAX_RELAYER_FEE_BNB, _BPS and the gas multiple; ~1.5x the gas at the default margins). */
const RAILGUN_FEE_HEADROOM_BPS = 2500n;
/** The relayer fee a signed order carries for `action`: the quote, plus RAILGUN_FEE_HEADROOM_BPS for a Railgun-paid
 *  order (relayer actions railgun*). */
export const signedRelayFee = (action: string, quoted: bigint) =>
  action.startsWith("railgun") ? quoted * (10_000n + RAILGUN_FEE_HEADROOM_BPS) / 10_000n : quoted;
const VENUE_KINDS: Record<string, number> = { "pancake-infinity": 1, "pancake-v3": 2, "pancake-v2": 3 }; // indexer API

/** Market stats from the indexer (public data; docs/API.md). */
function indexerMarket(l: Launch) {
  return {
    status: l.status, priceBnb: l.priceBnb, marketCapBnb: l.marketCapBnb, change24hPct: Math.round(l.change24h * 10_000) / 100,
    volume24hBnb: l.volume24hBnb, volumeBnb: l.volumeBnb, trades24h: l.trades24h, trades: l.trades, holders: l.holders,
    createdAt: l.createdAt, lastTradeAt: l.lastTradeAt,
  };
}

/** A list_launches row from the indexer, with the same core fields as the on-chain summary. */
function indexerSummary(l: Launch) {
  const v = l.venue;
  return {
    token: getAddress(l.address), name: l.name, symbol: l.symbol, graduated: l.status === "graduated",
    // withheld by MurkFun's display moderation: name / symbol null here (still readable on chain with token_info)
    ...(l.moderation === "flagged" || l.moderation === "hidden" ? { moderation: l.moderation } : {}),
    // same shape as market.venueOf via tokenState: {venue, fee, pool, name}
    ...(v ? { venue: { venue: VENUE_KINDS[v.kind] ?? null, fee: v.feeTier ?? null, pool: v.pool && isAddress(v.pool) ? getAddress(v.pool) : v.pool, name: VENUES[VENUE_KINDS[v.kind] ?? 0] ?? v.kind, ...(v.poolId ? { poolId: v.poolId } : {}) } } : {}),
    raisedBnb: String(l.curve.bnbReserve), curveProgressPct: Math.floor(l.progress * 10_000 + 1e-6) / 100,
    ...indexerMarket(l),
  };
}

export class ToolError extends Error {}

/** The message of an error from outside MurkFun's own code (an RPC, the Agentic Wallet CLI, an API), fenced as
 *  third-party text: the model reads it as data, never as instructions. MurkFun's own errors pass as they are. */
function foreign(e: unknown): string {
  if (e instanceof ToolError || e instanceof RelayerError) return (e as Error).message;
  return fence("error", String((e as Error)?.message ?? e));
}

/** A buy request: `amount` BNB (exact in) or tokens (`exactOut`). */
interface Want { amount: bigint; exactOut: boolean; slip: bigint; dryRun: boolean }
interface TokenSt { graduated: boolean; tokensSold: bigint; curveSupply: bigint }
/** MurkFunMarket.Terms fields a creator buy needs: the curve and the dev limit (`devCap`, tokens). */
type CreatorBuyTerms = CurveTerms & { devCap: bigint };

/** Plain privacy advice for 0xbow deposits and buys (warnings, never refusals). */
const ROUND_DEPOSITS = ["0.5", "1", "5"].map((x) => parseEther(x));
const WAIT_AFTER_DEPOSIT_S = 3600n;

function asAddress(x: string, field: string): Address {
  if (!isAddress(x)) throw new ToolError(`${field} is not a valid address`);
  return getAddress(x);
}

/** A relayer quote is bound into the signed order as is: refuse a fee above `max` (MURKFUN_MAX_RELAYER_FEE_BNB), which
 *  no gas price explains (a faulty or hostile relayer). */
export function checkRelayerFee(action: string, fee: bigint, max: bigint) {
  if (fee > max) {
    throw new ToolError(`relayer_fee_too_high: the relayer quotes ${fmt(fee)} BNB for ${action}, above the limit of ${fmt(max)} BNB (MURKFUN_MAX_RELAYER_FEE_BNB); nothing was signed or sent`);
  }
}

/** The most gas MurkFun's orders take (the relayer's typical gas per action, its `TYPICAL_GAS`:
 *  the measured gas, x 1.5; this also covers the post-graduation gas class, + 200k): a relayer's own `gasUnits` above
 *  it does not raise the fee bound. A completing buy adds the graduation. */
export const MAX_ORDER_GAS: Record<string, bigint> = {
  privacyPoolBuy: 2_925_000n, privacyPoolLaunch: 4_275_000n, railgunBuy: 3_450_000n, railgunFund: 3_300_000n, railgunLaunch: 5_250_000n, buy: 1_650_000n, buyExactOut: 1_650_000n, sell: 1_680_000n,
  withdrawBnb: 1_575_000n, withdrawTokens: 1_800_000n, setDevRecipient: 1_500_000n, launch: 2_850_000n, graduate: 18_000_000n,
  collectLpFees: 630_000n, claimDevFees: 120_000n,
};
export const MAX_GRADUATION_GAS = 10_500_000n;
/** The gas price bound: at most this multiple of the MCP's own RPC gas price. */
const MAX_GAS_PRICE_MULTIPLE = 2n;

/** At most `maxFeeBps` of the order's BNB value (a buy's BNB, a sell's expected proceeds, a withdrawal, a creator
 *  buy's cost). */
export function checkFeeShare(action: string, fee: bigint, valueWei: bigint, maxFeeBps: number) {
  if (valueWei > 0n && fee * 10_000n > valueWei * BigInt(maxFeeBps)) {
    throw new ToolError(`relayer_fee_too_high: the relayer fee ${fmt(fee)} BNB is more than ${maxFeeBps / 100}% of the order's ${fmt(valueWei)} BNB (MURKFUN_MAX_RELAYER_FEE_BPS) for ${action}; trade a larger amount or retry later; nothing was signed or sent`);
  }
}

/** Every term of a relayer quote that goes into a signed order, checked before the wallet signs: the relayer is the
 *  pinned one (or the one this vault saw first at this relayer URL); the deadline lies between `now + 60 s` and
 *  `now + maxValidityS` (a far deadline would let a relayer hold the order and execute it whenever the price suits
 *  it); the fee is at most the absolute cap, at most `maxFeeMultiple` x gas x gas price where the gas is the quote's
 *  own but at most MAX_ORDER_GAS (a quote without it is refused) and the price the quote's own but at most 2 x the
 *  MCP's own RPC gas price (`localGasPriceWei`), and at most `maxFeeBps` of the order's BNB `amountWei` when there is
 *  one (checkFeeShare; the callers check the other values once known). */
export function checkRelayQuote(
  action: string,
  q: { relayer: string; fee: string; deadline: string; gasUnits?: string; quoteGasPriceWei?: string; gasPriceWei?: string; gasClass?: string; graduates?: boolean },
  c: { now: bigint; relayer?: string; maxFeeWei: bigint; maxFeeBps: number; maxFeeMultiple: number; maxValidityS: number; amountWei?: bigint; localGasPriceWei?: bigint; maxGasPriceWei?: bigint },
) {
  if (c.relayer && getAddress(q.relayer) !== getAddress(c.relayer)) {
    throw new ToolError(`relayer_mismatch: the quote names relayer ${q.relayer}, not ${c.relayer}; nothing was signed or sent`);
  }
  const deadline = BigInt(q.deadline);
  if (deadline < c.now + 60n || deadline > c.now + BigInt(c.maxValidityS)) {
    throw new ToolError(`relayer_deadline_out_of_range: the quoted deadline is ${deadline - c.now} s from now, outside 60 s - ${c.maxValidityS} s (MURKFUN_MAX_ORDER_VALIDITY_S); nothing was signed or sent`);
  }
  const fee = BigInt(q.fee);
  checkRelayerFee(action, fee, c.maxFeeWei);
  const quoted = q.quoteGasPriceWei ?? q.gasPriceWei;
  if (fee > 0n) {
    if (!q.gasUnits || !quoted) throw new ToolError(`relayer_quote_incomplete: the relayer's quote for ${action} has no gas estimate; nothing was signed or sent`);
    const completing = q.gasClass === "completing-buy" || q.graduates === true;
    const maxGas = (MAX_ORDER_GAS[action] ?? MAX_ORDER_GAS.graduate) + (completing ? MAX_GRADUATION_GAS : 0n);
    const gas = minBig(BigInt(q.gasUnits), maxGas);
    // the per-action bound: this action's most gas at the configured highest gas price, whatever any RPC reports
    if (c.maxGasPriceWei !== undefined && fee * 100n > maxGas * c.maxGasPriceWei * BigInt(Math.round(c.maxFeeMultiple * 100))) {
      throw new ToolError(`relayer_fee_too_high: the relayer quotes ${fmt(fee)} BNB for ${action}, more than this action can cost (${maxGas} gas at ${fmt(c.maxGasPriceWei * 10n ** 9n)} gwei x ${c.maxFeeMultiple}; MURKFUN_MAX_GAS_PRICE_GWEI); nothing was signed or sent`);
    }
    const price = c.localGasPriceWei ? minBig(BigInt(quoted), c.localGasPriceWei * MAX_GAS_PRICE_MULTIPLE) : BigInt(quoted);
    const cost = gas * price;
    if (fee * 100n > cost * BigInt(Math.round(c.maxFeeMultiple * 100))) {
      throw new ToolError(`relayer_fee_too_high: the relayer quotes ${fmt(fee)} BNB for ${action}, more than ${c.maxFeeMultiple} x its gas (${fmt(cost)} BNB: at most ${maxGas} gas at most ${MAX_GAS_PRICE_MULTIPLE} x this RPC's gas price; MURKFUN_MAX_FEE_MULTIPLE); nothing was signed or sent`);
    }
  }
  if (c.amountWei !== undefined) checkFeeShare(action, fee, c.amountWei, c.maxFeeBps);
}

/** Destinations of withdrawals and fee recipients (an instruction injected through third-party text can not send
 *  funds elsewhere): the MURKFUN_WITHDRAW_ALLOWLIST addresses, or only the vault's own wallet when it is unset
 *  (`wallet`); "*" allows any. Both sides are compared checksummed, so an entry written in any letter case matches. */
export function checkDestination(to: Address, allow: Address[] | "any" | undefined, what: string, wallet?: Address) {
  if (allow === "any") return;
  const list = allow ?? (wallet ? [wallet] : []);
  if (!list.some((a) => getAddress(a) === getAddress(to))) {
    throw new ToolError(`destination_not_allowed: ${to} is not in MURKFUN_WITHDRAW_ALLOWLIST (${what}${allow ? "" : "; unset, so only this vault's own wallet is allowed"}); nothing was signed or sent. Only the user can allow more destinations: to use a fresh address (better for privacy than the wallet), the user adds it to MURKFUN_WITHDRAW_ALLOWLIST in the MCP server's environment (comma-separated addresses, or * for any) and restarts the MCP server`);
  }
}

/** Shown when funds or fees go to the user's own wallet: that ties the pseudonym to the wallet in public. */
export const OWN_WALLET_PRIVACY = "this destination is your own wallet: the transfer publicly links this pseudonym (and the token) to your wallet. For privacy use a fresh address the user adds to MURKFUN_WITHDRAW_ALLOWLIST";

/** A signed, proved order and the gate it goes to. */
interface Made { order: Order; proof: Hex; signedAt: number; market: Address; gate: Address }

export class MurkFunAgent {
  readonly pub: PublicClient;
  readonly relayer: RelayerClient;
  readonly vault: Vault;
  readonly indexer?: IndexerClient;
  private _pp?: PrivacyPools;
  private _secret?: bigint;
  private _account?: PrivateKeyAccount;
  private _baw?: BawSigner;
  private _bb?: Promise<string>;

  constructor(readonly cfg: McpConfig) {
    // cacheTime 0: viem otherwise reuses getBlockNumber for 4 s, and the incremental 0xbow / holder-set log scans
    // (pp.ts, holderBatches) would stop at a stale head and miss the change note of a buy mined seconds ago
    this.pub = createPublicClient({ cacheTime: 0, transport: http(cfg.rpc, { timeout: 120_000, retryCount: 3 }) });
    this.relayer = new RelayerClient(cfg.relayerUrl);
    this.vault = new Vault(path.join(cfg.home, "vault.json"), cfg.passphrase ?? "");
    if (cfg.indexerUrl) this.indexer = new IndexerClient(cfg.indexerUrl, { chainId: cfg.chainId, market: cfg.deployment.market, factory: cfg.deployment.factory });
    this.logRpc = new LogRpc({
      main: this.pub, mainUrl: cfg.rpc, urls: cfg.logRpcs ?? [], chainId: cfg.chainId,
      probe: batchProbe(this.pub, async () => this.holderRootsOf(await this.currentMarket()), holderRootsFromBlock(cfg.deployment)),
    });
  }
  /** The endpoint eth_getLogs scans go to: MURKFUN_RPC if it serves them, else the first of MURKFUN_LOG_RPCS that does
   *  (probed once per process, logRpc.ts). */
  private readonly logRpc: LogRpc;
  private async logClient(): Promise<PublicClient> {
    try {
      return await this.logRpc.client();
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
  }

  static async create(cfg: McpConfig) {
    await zkInit();
    return new MurkFunAgent(cfg);
  }

  // ------------------------------------------------------------------ state
  /** Before every tool call: pick up vault changes made by another process on the same MURKFUN_HOME (CLI calls next to
   *  a running MCP server); everything derived from the old secrets is dropped. */
  syncVault() {
    if (this.vault.refresh()) this.forget();
  }
  private forget() { this._pp = undefined; this._secret = undefined; this._account = undefined; this._baw = undefined; this.holderBatchCache.clear(); this.apiPaths.clear(); }
  private get data(): VaultData {
    if (!this.cfg.passphrase) throw new ToolError("MURKFUN_PASSPHRASE is not set: the vault cannot be opened");
    if (!this.vault.exists()) throw new ToolError("no vault yet: call setup first");
    if (!this.vault.data) this.vault.load();
    return this.vault.data;
  }
  /** The wallet's key (only when the MCP holds it; the Binance Agentic Wallet signs through baw). */
  private get account() {
    if (!this.data.eoaKey) throw new ToolError(`BAW_WALLET: the wallet ${this.data.account} is a Binance Agentic Wallet; it has no private key here and signs through the baw CLI`);
    return (this._account ??= privateKeyToAccount(this.data.eoaKey));
  }
  /** The wallet signs and sends through the Binance Agentic Wallet CLI. */
  private get isBaw() { return this.data.signer === "baw"; }
  private get baw() {
    if (!this._baw) {
      const want = this.data.account ? getAddress(this.data.account) : undefined;
      if (want && this.cfg.bawAccount && getAddress(this.cfg.bawAccount) !== want) {
        throw new ToolError(`BAW_ACCOUNT_MISMATCH: this vault belongs to the agent wallet ${want}, but MURKFUN_BAW_ACCOUNT is ${getAddress(this.cfg.bawAccount)}`);
      }
      this._baw = new BawSigner({ bin: this.cfg.bawPath, account: want ?? this.cfg.bawAccount, chainId: this.cfg.chainId });
    }
    return this._baw;
  }
  /** The public wallet: holds the Agent ID, signs every order, deposits into 0xbow. */
  private get walletAddress(): Address { return this.data.eoaKey ? this.account.address : getAddress(this.data.account!); }
  /** The wallet's seed signature (setup): the identity secret behind every pseudonym. */
  private get seedSig(): Hex {
    if (!this.data.seedSig) throw new ToolError("NOT_SET_UP: the wallet has not signed the MurkFun seed message yet: call setup");
    return this.data.seedSig;
  }
  /** The 0xbow seed (keystore and note secrets), derived from the seed signature. */
  private get seed(): Hex {
    if (!this.data.seed) throw new ToolError("NOT_SET_UP: call setup first");
    return this.data.seed;
  }
  private get secret() { return (this._secret ??= zk.secretOf(this.seedSig)); }
  private get pp() {
    return (this._pp ??= new PrivacyPools(this.pub, this.seed, this.walletAddress, {
      snapshotUrl: this.cfg.ppSnapshotUrl, aspLeavesUrl: this.cfg.aspLeavesUrl, circuitsDir: this.cfg.circuitsDir, logChunk: this.cfg.logChunk, scanFrom: this.cfg.ppScanFrom,
      logs: () => this.logClient(),
    }));
  }
  private get D() { return this.cfg.deployment; }
  private wallet() {
    const chain = { id: this.cfg.chainId, name: "bsc", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [this.cfg.rpc] } } };
    return createWalletClient({ account: this.account, chain, transport: http(this.cfg.rpc, { timeout: 120_000 }) });
  }

  // ------------------------------------------------------------------ routing (re-points are followed on chain)
  private markets = new Map<Address, Address>();

  /** The market `t` was listed in (factory.marketOf), for the token's whole life: every order, nonce and quote of `t`
   *  goes to it. Cached once known (a non-zero answer never changes). */
  private async marketOf(t: Address): Promise<Address> {
    const known = this.markets.get(t);
    if (known) return known;
    const m = await this.pub.readContract({ address: this.D.factory, abi: factoryAbi, functionName: "marketOf", args: [t] }) as Address;
    if (m === zeroAddress) throw new ToolError(`${t} is not a MurkFun token`);
    this.markets.set(t, getAddress(m));
    return getAddress(m);
  }
  /** The market new tokens are listed in (factory.market(); the owner can re-point it with the timelock). */
  private async currentMarket(): Promise<Address> {
    return getAddress(await this.pub.readContract({ address: this.D.factory, abi: factoryAbi, functionName: "market" }) as Address);
  }
  /** A read of `t`'s own market. */
  /** The chain's time: the latest block's timestamp. Every deadline the MCP builds (orders, quotes, Railgun calls,
   *  launches) starts from it, never from this machine's clock: a slow local clock would make every order expire on
   *  arrival (`Expired()`), a fast one would sign orders valid longer than asked. */
  async chainNow(): Promise<bigint> {
    return (await this.pub.getBlock({ blockTag: "latest" })).timestamp;
  }

  /** A deadline `minutes` (default 5, at least 5, at most maxValidMinutes) after the chain's time: an order is valid only briefly, so a signed
   *  order nobody sent can not be executed much later at a price the user no longer wants. */
  /** The longest validity an order this MCP signs may carry, in minutes: MURKFUN_MAX_ORDER_VALIDITY_S (a far deadline
   *  lets whoever holds the signed order execute it whenever the price suits them), at least RAILGUN_VALID_MINUTES (a
   *  Railgun proof takes a while). */
  private maxValidMinutes(): number {
    return Math.max(Math.floor((this.cfg.maxOrderValidityS ?? 0) / 60), RAILGUN_VALID_MINUTES);
  }

  private async deadlineIn(minutes?: number): Promise<bigint> {
    const max = this.maxValidMinutes();
    if (minutes !== undefined && minutes > max) {
      throw new ToolError(`validity_too_long: validMinutes ${minutes} is above ${max} (MURKFUN_MAX_ORDER_VALIDITY_S, at least ${RAILGUN_VALID_MINUTES} min): a signed order must not stay executable for long; nothing was signed or sent`);
    }
    return (await this.chainNow()) + 60n * BigInt(Math.min(Math.max(Math.floor(minutes ?? 5), 5), max));
  }

  private async tread<T = any>(t: Address, functionName: string, args: unknown[] = []): Promise<T> {
    return this.pub.readContract({ address: await this.marketOf(t), abi: marketAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
  }
  /** A read of the current market (pause status, new launches). */
  private async cread<T = any>(functionName: string, args: unknown[] = [], market?: Address): Promise<T> {
    return this.pub.readContract({ address: market ?? await this.currentMarket(), abi: marketAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
  }
  /** `market`'s order gate (MurkFunOrders: market.orders(), re-pointable with the market's timelock). */
  private async ordersOf(market: Address): Promise<Address> {
    const a = getAddress(await this.cread<Address>("orders", [], market));
    if (a === zeroAddress) throw new ToolError(`ORDERS_UNSET: the market ${market} has no order gate yet`);
    return a;
  }
  private verifiedGates = new Set<Address>();
  /** The gate's verifier must be the build the bundled circuit proves for: otherwise every proof would
   *  revert InvalidProof. Checked once per gate and process, before the wallet signs. */
  private async checkVerifier(gate: Address) {
    const want = this.cfg.verifierCodeHash;
    if (!want || this.verifiedGates.has(gate)) return;
    const v = await this.pub.readContract({ address: gate, abi: ordersAbi, functionName: "VERIFIER" }) as Address;
    const code = await this.pub.getCode({ address: v });
    if (!code || keccak256(code) !== want) {
      throw new ToolError(`VERIFIER_MISMATCH: the order gate ${gate} verifies with ${v}, not the verifier this murkfun-mcp's circuit is built for (update murkfun-mcp: npm install -g https://github.com/murkfun/murkfun-mcp/releases/latest/download/murkfun-mcp.tgz); nothing was signed or sent`);
    }
    this.verifiedGates.add(gate);
  }
  /** The holder set `market`'s gate checks roots against (MurkFunOrders.HOLDER_ROOTS()). */
  private async holderRootsOf(market: Address): Promise<Address> {
    return getAddress(await this.pub.readContract({ address: await this.ordersOf(market), abi: ordersAbi, functionName: "HOLDER_ROOTS" }) as Address);
  }
  /** The Agent ID registry the holder set is built from (MurkFunHolderRoots.AGENT_NFT()). */
  private async agentNft(): Promise<Address> {
    return getAddress(await this.pub.readContract({ address: await this.holderRootsOf(await this.currentMarket()), abi: holderRootsAbi, functionName: "AGENT_NFT" }) as Address);
  }

  /** Send a tx from the user's own wallet (0xbow only: keystore registration, deposit) and require success. */
  private async ownTx(req: { address: Address; abi: any; functionName: string; args: unknown[]; value?: bigint; gas?: bigint }) {
    let hash: Hex;
    if (this.isBaw) {
      // Binance Agentic Wallet: preview (simulation + risk check), then execute; never when the App must confirm
      const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args } as never);
      try {
        hash = await this.baw.sendTransaction({ from: this.walletAddress, to: req.address, value: req.value ?? 0n, data, gas: req.gas });
      } catch (e) {
        throw new ToolError(`${foreign(e)} [${req.functionName}]`);
      }
    } else {
      hash = await this.wallet().writeContract({ ...req, chain: undefined } as never);
    }
    const r = await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (r.status !== "success") throw new ToolError(`${req.functionName} reverted (tx ${hash})`);
    return r;
  }

  // ------------------------------------------------------------------ the holder set and signed orders

  /** Live MurkFunHolderRoots batches (address lists and subtree roots from the Batch events; a fraud proof's
   *  Challenged drops a batch and every later one), per holder-set contract, scanned incrementally. */
  private holderBatchCache = new Map<Address, { to: bigint; list: { addrs: Address[]; subtreeRoot: bigint }[] }>();
  /** The relayer address this relayer URL first quoted with (quotes naming another are refused). */
  private chainChecked = false;
  /** The RPC is the configured chain (MURKFUN_CHAIN_ID), and so is MURKFUN_RPC_CHECK (once per process). */
  private async checkChain() {
    if (this.chainChecked) return;
    const urls = [this.cfg.rpc, ...(this.cfg.rpcCheck ? [this.cfg.rpcCheck] : [])];
    for (const u of urls) {
      const id = await createPublicClient({ transport: http(u, { timeout: 30_000 }) }).getChainId();
      if (id !== this.cfg.chainId) throw new ToolError(`WRONG_CHAIN: the RPC answers chain id ${id}, not ${this.cfg.chainId}; nothing was signed or sent`);
    }
    this.chainChecked = true;
  }
  private async holderBatches(roots: Address) {
    const latest = await (await this.logClient()).getBlockNumber();
    // from the holder set's own deploy block: a reused live holder set posted batches before the rest was deployed
    const c = this.holderBatchCache.get(roots) ?? { to: holderRootsFromBlock(this.D) - 1n, list: [] };
    const list = c.list.slice();
    const evs = (holderRootsAbi as unknown as any[]).filter((x) => x.type === "event" && (x.name === "Batch" || x.name === "Challenged"));
    const logs = c.to < latest ? await this.logsChunked(roots, evs, undefined, c.to + 1n) : [];
    for (const l of logs) {
      const id = Number(l.args.id);
      if (l.eventName === "Batch") {
        list.length = Math.min(list.length, id); // a re-posted slot replaces a dropped one
        list.push({ addrs: (l.args.addrs as Address[]).map((a) => getAddress(a)), subtreeRoot: BigInt(l.args.subtreeRoot) });
      } else list.length = Math.min(list.length, id);
    }
    // re-scan the last blocks next time (log visibility lag)
    this.holderBatchCache.set(roots, { to: latest - 20n > c.to ? latest - 20n : c.to, list: logs.length && latest - 20n > c.to ? list.slice() : c.list });
    return list;
  }

  /** The wallet's path in the latest accepted holder root of `market`'s gate (or why there is none). First from the
   *  holder-set API (MURKFUN_HOLDERS_API: one HTTP request, its proof checked here and against the on-chain accepted
   *  root, never trusted), else rebuilt from the holder set's Batch events (an RPC that serves eth_getLogs). */
  private async holderPath(market: Address): Promise<zk.HolderPath & { source: "api" | "logs" }> {
    await this.checkChain();
    const roots = await this.holderRootsOf(market);
    if (this.cfg.rpcCheck) {
      // a second RPC must agree on the latest accepted root: one RPC alone could hand this wallet an older root to
      // tag its orders with
      const [a, b] = await Promise.all([this.pub, createPublicClient({ transport: http(this.cfg.rpcCheck, { timeout: 30_000 }) })].map((c) =>
        c.readContract({ address: roots, abi: holderRootsAbi, functionName: "acceptedRoot" }) as Promise<readonly [bigint, bigint]>));
      if (a[0] !== b[0]) throw new ToolError("ROOT_MISMATCH: MURKFUN_RPC and MURKFUN_RPC_CHECK disagree on the accepted holder root; retry later");
    }
    const [acceptedRoot, acceptedId] = await this.pub.readContract({ address: roots, abi: holderRootsAbi, functionName: "acceptedRoot" }) as readonly [bigint, bigint];
    if (acceptedRoot === 0n) throw new ToolError("NO_ACCEPTED_ROOT: the holder set has no accepted batch yet (the operator's first batch is still in its challenge window); try again later");
    const api = await this.holderPathFromApi(acceptedRoot);
    if (api.path) return { ...api.path, source: "api" };
    try {
      return { ...(await this.holderPathFromLogs(roots, acceptedRoot, acceptedId)), source: "logs" };
    } catch (e) {
      // no log endpoint: say what the API said (unverified) and why its proof was not used
      if (/^NO_LOG_RPC/.test((e as Error).message) && (api.claim || api.why)) {
        throw new ToolError(api.claim
          ? `${api.claim} (the holder-set API's answer; it can not be checked on chain without an RPC that serves eth_getLogs: ${(e as Error).message})`
          : `${(e as Error).message} [holder-set API: ${api.why}]`);
      }
      throw e;
    }
  }

  /** Verified API paths by wallet (the latest accepted root's). */
  private apiPaths = new Map<Address, zk.HolderPath>();
  /** The wallet's path from the holder-set API if its proof checks out: leaf = H(wallet), the siblings reach its root,
   *  and that root is the holder set's latest accepted root on chain (not just any known root: an older root would set
   *  this wallet's orders apart). Otherwise why not (`why`), with the API's own negative answer (`claim`). */
  private async holderPathFromApi(acceptedRoot: bigint): Promise<{ path?: zk.HolderPath; why?: string; claim?: string }> {
    if (!this.cfg.holdersApi) return {};
    // one lookup per accepted root (at most hourly), not one per order: the request names the wallet, so it should not
    // come with every order signature
    const cached = this.apiPaths.get(this.walletAddress);
    if (cached?.root === acceptedRoot) return { path: cached };
    let lookup;
    try {
      lookup = await fetchHolderLookup(this.cfg.holdersApi, this.walletAddress);
    } catch (e) {
      return { why: `unreachable (${foreign(e)})` };
    }
    if (!lookup?.proof) {
      const claim = lookupClaim(lookup, this.walletAddress);
      return { why: claim ? `no proof (status ${fence("reason", String(lookup.status))})` : "no proof in its answer", claim };
    }
    try {
      const p = verifyHolderProof(lookup, this.walletAddress);
      if (p.root !== acceptedRoot) return { why: "its proof's root is not the accepted root on chain" };
      this.apiPaths.set(this.walletAddress, p);
      return { path: p };
    } catch (e) {
      return { why: `proof rejected: ${(e as Error).message}` };
    }
  }

  /** The wallet's path rebuilt from the holder set's Batch events (the log endpoint, logClient). */
  private async holderPathFromLogs(roots: Address, acceptedRoot: bigint, acceptedId: bigint): Promise<zk.HolderPath> {
    let list = await this.holderBatches(roots);
    // The cached batches must rebuild the accepted root BEFORE the wallet is looked up: a Batch event an
    // RPC left out (e.g. the wallet's own) would otherwise read as "not a holder" for good, with the scan cursor past
    // it. On a mismatch the cache is dropped and rebuilt from the events once.
    const rebuilds = (l: typeof list) => l.length > Number(acceptedId) && zk.globalTree(l.slice(0, Number(acceptedId) + 1).map((x) => x.subtreeRoot)).root() === acceptedRoot;
    if (!rebuilds(list)) {
      this.holderBatchCache.delete(roots);
      list = await this.holderBatches(roots);
      if (!rebuilds(list)) throw new ToolError("ROOT_MISMATCH: the holder batches from the RPC do not rebuild the accepted root (RPC lagging or missing logs?); retry");
    }
    const accepted = list.slice(0, Number(acceptedId) + 1);
    const p = zk.holderPath(accepted, this.walletAddress);
    if (!p) {
      const pending = zk.holderPath(list, this.walletAddress);
      throw new ToolError(pending
        ? `NOT_ACCEPTED_YET: your wallet is in holder batch ${pending.batch}, which is still in its challenge window (the contract's CHALLENGE_PERIOD, currently 1 h): try again later`
        : `NOT_A_HOLDER_YET: ${this.walletAddress} is not in the holder set yet. New Agent ID holders are added by the holder-set operator's next batch (no transaction from you); status shows holderSet. A holder left out can be forced in (enqueue on MurkFunHolderRoots), which reveals interest in MurkFun.`);
    }
    if (p.root !== acceptedRoot) {
      this.holderBatchCache.delete(roots); // rebuilt from the events on the retry (a missed log must not stick)
      throw new ToolError("ROOT_MISMATCH: the local holder tree does not match the accepted root (RPC lagging?); retry");
    }
    return p;
  }

  /** holders_lookup: one entry of the holder set (address | name | name.ai), read-only: no wallet, no vault
   *  (holdersLookup.ts says what is checked how). */
  async holdersLookup(o: { query: string }) {
    try {
      parseHolderQuery(o.query); // a bad query is refused before anything is read
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
    await this.checkChain();
    const roots = await this.holderRootsOf(await this.currentMarket());
    const registry = getAddress(await this.pub.readContract({ address: roots, abi: holderRootsAbi, functionName: "AGENT_NFT" }) as Address);
    const reg = <T>(functionName: string, args: unknown[]) => this.pub.readContract({ address: registry, abi: agentNftAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
    return lookupHolder(o.query, {
      registry,
      ownerOfName: async (name) => {
        const owner = await reg<Address>("ownerOf", [agentIdOfName(name)]).catch(() => null);
        return owner ? getAddress(owner) : null;
      },
      handleOf: (a) => reg<string>("handleOf", [a]),
      balanceOf: (a) => reg<bigint>("balanceOf", [a]),
      acceptedRoot: () => this.pub.readContract({ address: roots, abi: holderRootsAbi, functionName: "acceptedRoot" }) as Promise<readonly [bigint, bigint]>,
      batchInfo: async (id) => {
        const b = await this.pub.readContract({ address: roots, abi: holderRootsAbi, functionName: "batches", args: [BigInt(id)] }) as readonly unknown[];
        return { postedAt: Number(b[2] as bigint), usableFrom: Number(b[6] as bigint) };
      },
      batches: () => this.holderBatches(roots),
      api: async (a) => (this.cfg.holdersApi ? await fetchHolderLookup(this.cfg.holdersApi, a).catch(() => undefined) : undefined),
      receiptLogs: async (tx) => (await this.pub.getTransactionReceipt({ hash: tx })).logs,
    });
  }

  private pseudonym(t: Address): bigint { return zk.pseudonymOf(this.secret, t); }

  private track(token: Address) {
    if (!this.data.tokens.includes(token)) { this.data.tokens.push(token); this.vault.save(); }
  }

  /** TokenState read by field name from the generated ABI, so added fields (e.g. a graduation venue) do not shift
   *  anything. Venue fields are passed through as-is; trading never depends on them (see simulate). */
  private async tokenState(token: Address) {
    const t = await this.tread<any[]>(token, "tokens", [token]);
    const names: string[] = ((marketAbi as unknown as any[]).find((x) => x.type === "function" && x.name === "tokens")?.outputs ?? []).map((o: any) => o.name);
    const raw: Record<string, any> = {};
    names.forEach((n, i) => { raw[n] = t[i]; });
    if (!raw.listed) throw new ToolError(`${token} is not a MurkFun token`);
    // the token's own terms, snapshotted at listing (the factory's parameters are owner-settable; later changes never apply)
    const terms = await this.tread<{ curveSupply: bigint; holderCap: bigint; devCap: bigint; tradeFeeBps: number }>(token, "termsOf", [token]);
    const venue: Record<string, unknown> = {};
    if (raw.graduated) {
      const fn = (marketAbi as unknown as any[]).find((x) => x.type === "function" && x.name === "venueOf");
      const v = await this.tread<any[]>(token, "venueOf", [token]);
      fn.outputs.forEach((o: any, i: number) => { venue[o.name] = typeof v[i] === "bigint" ? v[i].toString() : v[i]; });
      venue.name = VENUES[Number(venue.venue)] ?? `venue ${venue.venue}`;
    }
    return {
      bnbReserve: raw.bnbReserve as bigint, tokensSold: raw.tokensSold as bigint, listed: true,
      graduated: raw.graduated as boolean, devFeeRecipient: raw.devFeeRecipient as Address, devPseudonym: raw.devPseudonym as bigint,
      devFees: raw.devFees as bigint, venue, curveSupply: terms.curveSupply, holderCap: terms.holderCap, devCap: terms.devCap, tradeFeeBps: Number(terms.tradeFeeBps),
    };
  }


  /** The wallet signs EIP-712 `td` here (a local key) or through the Binance Agentic Wallet. */
  private async signTyped(td: ReturnType<typeof zk.seedTypedData> | ReturnType<typeof zk.orderAuthTypedData>, twice = false): Promise<Hex> {
    if (this.isBaw) {
      try {
        const json = zk.typedDataJson(td as never);
        return twice ? await this.baw.signTypedDataTwice(this.walletAddress, json) : await this.baw.signTypedData(this.walletAddress, json);
      } catch (e) {
        throw new ToolError(foreign(e));
      }
    }
    const sig = await this.account.signTypedData(td as never);
    if (twice && (await this.account.signTypedData(td as never)) !== sig) throw new ToolError("NONDETERMINISTIC: the wallet signed the seed message twice with different signatures");
    return sig;
  }

  private bb() {
    return (this._bb ??= zk.ensureBb({ bb: this.cfg.bbPath, cacheDir: path.join(this.cfg.home, "bin"), download: this.cfg.bbDownload })
      .catch((e) => { this._bb = undefined; throw new ToolError(foreign(e)); }));
  }

  /** Build, sign and prove an order: the holder path in the latest accepted root, the pseudonym's next nonce (or
   *  `nonce`), a random salt, ONE fresh wallet signature over OrderAuth{orderHash} (the wallet sees only that opaque
   *  hash), then the local proof. `market`: the token's own (default) or, for a launch, the current market. */
  private async makeOrder(f: { action: number; token: Address; amount: bigint; minOut: bigint; to?: Address; relay: Relay; nonce?: bigint; market?: Address }): Promise<Made> {
    const market = f.market ?? await this.marketOf(f.token);
    await this.checkVerifier(await this.ordersOf(market));
    const pseudonym = this.pseudonym(f.token);
    const [path_, nonce] = await Promise.all([this.holderPath(market), f.nonce ?? this.cread<bigint>("nonces", [f.token, pseudonym], market)]);
    const fields: zk.OrderFields = {
      chainId: BigInt(this.cfg.chainId), market, action: f.action, token: f.token, amount: f.amount, minOut: f.minOut, to: f.to ?? zeroAddress,
      nonce, relayer: f.relay.relayer, fee: f.relay.fee, deadline: f.relay.deadline,
    };
    const salt = zk.randomSalt();
    const orderSig = await this.signTyped(zk.orderAuthTypedData(zk.orderHashOf(fields, salt)));
    const signedAt = Date.now();
    const w = await zk.orderWitness({ seedSig: this.seedSig, orderSig, path: path_, order: fields, salt });
    if (w.pseudonym !== pseudonym) throw new ToolError("pseudonym derivation mismatch");
    let proof: Hex;
    try {
      ({ proof } = await zk.proveOrder(w.inputs, { bb: await this.bb() }));
    } catch (e) {
      throw e instanceof ToolError ? e : new ToolError((e as Error).message);
    }
    const order: Order = {
      action: f.action, token: f.token, amount: f.amount, minOut: f.minOut, to: fields.to, nonce, relayer: f.relay.relayer, fee: f.relay.fee,
      deadline: f.relay.deadline, holderRoot: path_.root, pseudonym, nullifier: w.nullifier,
    };
    return { order, proof, signedAt, market, gate: await this.ordersOf(market) };
  }

  /** Wait until a random time after the wallet's signature (Binance sees when it signs: the order should not land
   *  right after), then return the delay. */
  private async delayFrom(signedAt: number) {
    const d = zk.randomDelayMs(this.cfg.orderDelayMs[0], this.cfg.orderDelayMs[1]);
    const wait = signedAt + d - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return d;
  }

  /** Railgun's (or a plain wallet's after graduation) call of a signed order: MurkFunOrders.execute{value}. */
  private orderCall(made: Made, value: bigint) {
    return { to: made.gate, value, data: encodeFunctionData({ abi: ordersAbi, functionName: "execute", args: [made.order as never, made.proof] }) };
  }

  /** An unsigned order for a quote: MurkFunMarket.execute as `market`'s gate would call it, simulated with eth_call
   *  from the gate's address. It is not signed and carries no proof, so whoever sees the call (the RPC) has nothing that
   *  could ever be submitted. `value`: a BuyDirect quote's payment (the gate gets the balance through a state override). */
  private async simulateOrder<T = bigint>(t: Address, f: { action: number; amount: bigint; minOut?: bigint; to?: Address; relayer?: Address }, value = 0n): Promise<T> {
    const market = await this.marketOf(t);
    const gate = await this.ordersOf(market);
    const p = this.pseudonym(t);
    const [nonce, now] = await Promise.all([this.cread<bigint>("nonces", [t, p], market), this.chainNow()]);
    const order: Order = {
      action: f.action, token: t, amount: f.amount, minOut: f.minOut ?? 0n, to: f.to ?? zeroAddress, nonce,
      relayer: f.relayer ?? zeroAddress, fee: 0n, deadline: now + 600n, holderRoot: 0n, pseudonym: p, nullifier: 0n,
    };
    const sim = "0x000000000000000000000000000000000000F00D" as Address; // the submitter: any address after graduation
    try {
      const { result } = await this.pub.simulateContract({
        address: market, abi: marketAbi, functionName: "execute", args: [order, sim] as never, account: gate, value,
        ...(value > 0n ? { stateOverride: [{ address: gate, balance: value + parseEther("1") }] } : {}),
      } as never);
      return result as T;
    } catch (e) {
      throw this.quoteError(e);
    }
  }

  /** The error of a quote simulation. An RPC refusing the call's third parameter (the balance override of a
   *  BuyDirect quote) is named. */
  private quoteError(e: unknown): ToolError {
    const name = revertName(e), all = `${name} ${(e as Error)?.message ?? ""}`;
    if (!/revert/i.test(all) && /state ?override|too many (arguments|params)|invalid (params|argument)|unknown (field|variant)|not supported|-32602/i.test(all)) {
      return new ToolError(
        "RPC_NO_STATE_OVERRIDE: the RPC (MURKFUN_RPC) does not apply eth_call state overrides, which quotes of a graduated token's direct buys need. " +
        "Nothing was sent. Set MURKFUN_RPC to an RPC that supports them (the third eth_call parameter: geth, erigon, reth and most hosted BSC RPCs do).",
      );
    }
    return new ToolError(`${simulationCode(name)}: ${name}${hintFor(name)}`);
  }

  /** After graduation: the tokens a routed exact-in buy of `value` BNB gets on `t`'s venue now (a simulated BuyDirect
   *  order; any address may pay into a graduated token). Venue-agnostic, so a 0xbow buy is quoted without a 0xbow
   *  withdrawal. */
  private async routedBuy(t: Address, value: bigint): Promise<bigint> {
    return this.simulateOrder(t, { action: zk.ACTION.BuyDirect, amount: value }, value);
  }

  /** After graduation there is no curve quote: an upper bound on what `tokens` cost on `t`'s venue (router and venue
   *  fees included), from simulated routed exact-in buys. The average price of a buy rises with its size, so
   *  probe x tokens / tokensOut(probe) >= the real cost whenever tokensOut(probe) >= tokens; probes grow until
   *  that holds. The exact-out buy then spends only the real cost (the rest stays in the balance). */
  private async routedExactOutBound(t: Address, tokens: bigint): Promise<bigint> {
    let probe = parseEther("0.001");
    for (let i = 0; i < 6; i++) {
      const got = await this.routedBuy(t, probe);
      if (got >= tokens) return (probe * tokens + got - 1n) / got;
      probe = got > 0n ? (probe * tokens / got) * 2n : probe * 100n;
    }
    throw new ToolError(`the venue cannot fill ${fmt(tokens)} tokens of ${t} (simulated buys of up to ${fmt(probe)} BNB fall short): buy fewer tokens`);
  }

  /** Relayer terms for `action`. For a curve-phase buy, `token` + `amount` (BNB offered; tokens with `exactOut`) let
   *  the relayer detect a buy that completes the curve (a graduated token has no curve to complete); `completes` says the MCP found that itself (quoteBuy / quoteBuyExactOut).
   *  A trade names its `token` in every case: on a graduated token it swaps through the pool, which the relayer quotes
   *  in the post-graduation gas class.
   *  Such a buy also pays the graduation gas: its fee is quoted in the completing-buy gas class, and the standard
   *  fee is fetched too so the agent can tell the user the difference. */
  private async relayQuote(action: string, o: { token?: Address; amount?: bigint; exactOut?: boolean; completes?: boolean; valueWei?: bigint } = {}) {
    const q = await this.relayer.quote(action, { graduates: o.completes, token: o.token, amount: o.amount, exactOut: o.exactOut });
    // the fee the wallet signs (a Railgun-paid order's with its headroom) is the one checked against every limit
    // (with the headroom added after the checks, a quote at a limit would sign above it)
    const relay: Relay = { relayer: q.relayer, fee: signedRelayFee(action, BigInt(q.fee)), deadline: BigInt(q.deadline) };
    // pinned: MURKFUN_RELAYER_ADDRESS, else the first relayer this vault saw at this URL (kept in the vault, so every
    // CLI call and MCP process pins the same one)
    const pinned = this.cfg.relayerAddress ?? this.data.relayers?.[this.relayer.url];
    const [block, localGasPriceWei] = await Promise.all([this.pub.getBlock(), this.pub.getGasPrice()]);
    checkRelayQuote(action, { ...q, fee: relay.fee.toString() }, {
      now: block.timestamp, relayer: pinned, maxFeeWei: this.cfg.maxRelayerFeeWei,
      maxFeeBps: this.cfg.maxRelayerFeeBps, maxFeeMultiple: this.cfg.maxFeeMultiple, maxValidityS: this.cfg.maxOrderValidityS,
      amountWei: o.valueWei ?? (o.exactOut ? undefined : o.amount), localGasPriceWei, maxGasPriceWei: this.cfg.maxGasPriceWei,
    });
    if (!pinned) {
      (this.data.relayers ??= {})[this.relayer.url] = getAddress(q.relayer);
      this.vault.save();
    }
    const completing = q.gasClass === "completing-buy" || q.graduates === true;
    const standard = completing ? signedRelayFee(action, BigInt((await this.relayer.quote(action)).fee)) : undefined;
    return { relay, completing, quote: q, standardFee: standard };
  }

  /** The relayer fee as the agent should report it: a completing buy's fee next to a standard buy's. */
  static feeInfo(r: { relay: Relay; completing: boolean; quote: Quote; standardFee?: bigint }) {
    return {
      relayerFeeBnb: fmt(r.relay.fee),
      ...(r.completing
        ? {
          relayerFee: {
            gasClass: "completing-buy", feeBnb: fmt(r.relay.fee), standardBuyFeeBnb: fmt(r.standardFee ?? 0n), ...(r.quote.gasUnits ? { gasUnits: r.quote.gasUnits } : {}),
            note: `This buy completes the curve and graduates the token in the same transaction, so the relayer fee covers the graduation gas: ${fmt(r.relay.fee)} BNB instead of ${fmt(r.standardFee ?? 0n)} BNB for a standard buy.`,
          },
        }
        : {}),
    };
  }

  /** A signed order through the relayer: after the random delay from the signature, submit, record in the vault, wait
   *  for the outcome. When nothing was sent (broadcast_failed, overloaded, relayer_unreachable) or the order was dropped
   *  (not executed), the identical order is resubmitted, at most MURKFUN_ORDER_RETRIES times (relayerClient.run): a
   *  signed order can never execute twice. */
  private async submitOrder(action: string, t: Address, made: Made, extra: Record<string, unknown> = {}, onAccepted?: (id: string) => void) {
    const delay = await this.delayFrom(made.signedAt);
    const s = await this.submit(action, t, { action, order: wireOrder(made.order), proof: made.proof, ...extra }, onAccepted);
    return Object.assign(s, { submitDelayMs: delay });
  }

  /** Submit to the relayer, record in the vault, wait for the outcome (see submitOrder). */
  private async submit(action: string, token: Address | undefined, order: unknown, onAccepted?: (id: string) => void): Promise<OrderStatus & { attempts?: number }> {
    let rec: VaultData["orders"][number] | undefined;
    const r = await this.relayer.run(order, { retries: this.cfg.orderRetries, backoffMs: this.cfg.orderRetryBackoffMs }, this.cfg.orderWaitMs, (a) => {
      if (rec && rec.status === "submitted") rec.status = "dropped"; // the previous submission of this order
      rec = { id: a.id, action, token, txHash: a.txHash, status: a.status, createdAt: Date.now() };
      this.data.orders.push(rec);
      onAccepted?.(a.id);
      this.vault.save();
    });
    rec!.status = r.status.status;
    this.vault.save();
    return { ...r.status, ...(r.attempts > 1 ? { attempts: r.attempts } : {}) };
  }

  private static orderResult(s: OrderStatus & { attempts?: number; submitDelayMs?: number }) {
    return {
      orderId: s.id, status: s.status, txHash: s.txHash, ...(s.error ? { error: s.error } : {}), ...(s.attempts ? { attempts: s.attempts } : {}),
      ...(s.submitDelayMs !== undefined ? { submitDelayMs: s.submitDelayMs } : {}),
      ...(s.status === "submitted" ? { hint: "not mined yet; check order_status later" } : {}),
      ...(s.status === "dropped" ? { hint: "not executed (the relayer dropped it) after every resubmission; nothing was spent: retry later" } : {}),
    };
  }

  /** What a mined buy did, from its receipt: tokens bought, BNB spent, the BNB it did not spend (`offered` minus
   *  Bought.bnbIn; it stays in the pseudonym's balance), and whether it completed the curve and graduated the token. */
  private async buyOutcome(t: Address, s: OrderStatus, offered?: bigint) {
    if (s.status !== "mined" || !s.txHash) return {};
    const r = await this.pub.getTransactionReceipt({ hash: s.txHash });
    return MurkFunAgent.outcomeFields(decodeTradeReceipt(r.logs as never, await this.marketOf(t), t, this.pseudonym(t)), offered);
  }

  static outcomeFields(d: TradeReceipt, offered?: bigint) {
    const out: Record<string, unknown> = {};
    if (d.bought) {
      out.boughtTokens = fmt(d.bought.tokensOut);
      out.spentBnb = fmt(d.bought.bnbIn);
      if (d.bought.venueFee > 0n) out.venueFeeBnb = fmt(d.bought.venueFee);
      if (offered !== undefined && offered > d.bought.bnbIn) { out.unspentBnb = fmt(offered - d.bought.bnbIn); out.unspent = UNSPENT_NOTE; }
    }
    if (d.curveCompleted) out.curveCompleted = true;
    if (d.graduated) {
      out.graduation = { graduated: true, venue: VENUES[d.graduated.venue] ?? `venue ${d.graduated.venue}`, pool: d.graduated.pool, fee: d.graduated.fee, ...(d.graduated.repaired ? { repaired: true } : {}) };
    } else if (d.graduationFailed) {
      out.graduation = {
        graduated: false, reason: decodeRevert(d.graduationFailed.reason),
        next: "The buy went through and the curve is sold out, but its automatic graduation failed: anyone can retry with graduate (sells to the curve work meanwhile).",
      };
    }
    return out;
  }

  // ================================================================== tools

  /** Create the encrypted vault (or load it) and have the wallet sign the fixed MurkFun seed message (twice: the
   *  signature must be deterministic, one wallet = one secret). The wallet: the Binance Agentic Wallet (signer=baw),
   *  a key file, or a new key made here (then back it up). Nothing is sent: MurkFun has no registration. */
  async setup(opts: { walletKeyFile?: string; signer?: "local" | "baw"; recoveryFile?: string } = {}) {
    if (!this.cfg.passphrase) throw new ToolError("set MURKFUN_PASSPHRASE (or MURKFUN_PASSPHRASE_FILE) in the MCP server environment first");
    let created = false, imported = 0;
    if (!this.vault.exists()) {
      if (this.cfg.passphrase.length < 12) throw new ToolError("MURKFUN_PASSPHRASE is too short: use at least 12 characters (a long random phrase)");
      if (opts.recoveryFile) {
        // secrets are read from the file here and never pass through the agent's context
        // a file that is not JSON (e.g. a raw key file) must not echo any of its text in the error
        let r: any;
        try {
          r = JSON.parse(fs.readFileSync(opts.recoveryFile, "utf8"));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code) throw new ToolError(`cannot read the recovery file (${(e as NodeJS.ErrnoException).code})`);
          throw new ToolError("not a MurkFun recovery file");
        }
        if (!r || typeof r !== "object") throw new ToolError("not a MurkFun recovery file");
        const key = /^0x[0-9a-fA-F]{64}$/.test(r.walletKey ?? "") ? r.walletKey as Hex : undefined;
        if (r.format !== "murkfun-recovery" || !key) throw new ToolError("not a MurkFun recovery file");
        this.vault.create({ eoaKey: key });
        await this.ensureSeedSig();
        for (const d of r.deposits ?? []) {
          const v = BigInt(d.valueWei), n = this.pp.depositNote(Number(d.index), v);
          this.data.deposits.push({ index: Number(d.index), value: v.toString(), label: n.label.toString(), commitment: n.commitment.toString(), createdAt: Date.now() });
          imported++;
        }
        for (const t of r.tokens ?? []) if (isAddress(t)) this.data.tokens.push(getAddress(t));
        this.vault.save();
      } else {
        this.vault.create(await this.walletSource(opts));
      }
      created = true;
    } else {
      if (opts.recoveryFile || opts.walletKeyFile || opts.signer) throw new ToolError(`a vault already exists at ${Vault.shown(this.vault.file)}; refusing to overwrite it (back it up and move it away first)`);
      this.vault.load();
    }
    const me = this.walletAddress;
    const [bal, agentIds] = await Promise.all([
      this.pub.getBalance({ address: me }),
      this.agentNft().then((nft) => this.pub.readContract({ address: nft, abi: agentNftAbi, functionName: "balanceOf", args: [me] })).catch(() => undefined),
    ]);
    if (agentIds === 0n) {
      return {
        created, vaultFile: Vault.shown(this.vault.file), wallet: me, walletBalanceBnb: fmt(bal), agentNft: false, ...(this.isBaw ? { signer: "baw" } : {}),
        ...this.customStatus(),
        next: [noAgentIdMessage(me).replace(/^NO_AGENT_NFT: /, ""), "Then call setup again (the wallet signs the MurkFun seed message once)."],
      };
    }
    const signed = await this.ensureSeedSig();
    const backup = this.isBaw
      ? "Your Binance Agentic Wallet is your backup: signing the same seed message again gives back the same pseudonyms and 0xbow notes (recover_from_wallet {signer:\"baw\"}). Keep the Binance account and the MCP passphrase safe; there is no key to export."
      : opts.walletKeyFile
        ? "Your wallet is your backup: signing the same seed message again gives back the same pseudonyms and notes. Guard that wallet's key; backup {path} keeps an encrypted copy of the vault."
        : "Your wallet is your backup. This wallet was just created here, so save its key now: export_recovery {path, confirm:true} (plaintext file for offline storage) and backup {path} (encrypted copy).";
    return {
      created, vaultFile: Vault.shown(this.vault.file), wallet: me, walletBalanceBnb: fmt(bal), ...(this.isBaw ? { signer: "baw" } : {}),
      ...(agentIds !== undefined ? { agentNft: agentIds > 0n } : {}), seedSigned: signed ? "now (twice, identical: a deterministic signer)" : "already",
      ...(opts.recoveryFile ? { importedDeposits: imported } : {}),
      holderSet: await this.holderStatus(),
      ...this.customStatus(),
      next: !created ? ["Vault loaded."]
        : opts.recoveryFile ? ["Call recover to find the current 0xbow notes and your MurkFun positions on-chain, then status."]
        : [backup,
          "Every MurkFun order needs a fresh signature from this wallet for exactly that order (the signer sees only an opaque hash); the wallet never sends a MurkFun transaction.",
          "To buy, pay from Railgun (the default): shield BNB into a Railgun wallet (a new shield can be spent after Railgun's Proof of Innocence standby, about 1 h); then buy {token, bnbAmount} returns the Railgun transaction to build and submit_railgun {transactions} has the MurkFun relayer send it (this wallet needs no BNB for it).",
          `Or 0xbow Privacy Pools (buy source=note): the wallet ${me} deposits BNB (deposit {amountBnb}; ~0.003 BNB gas for the keystore registration and the deposit), then waits for 0xbow's ASP to approve the deposit, which can take hours or much longer.`],
    };
  }

  /** The wallet: the Binance Agentic Wallet, a key file read here, or a new random key. */
  private async walletSource(o: { walletKeyFile?: string; signer?: "local" | "baw" }): Promise<{ eoaKey?: Hex; account?: Address; signer?: "baw" }> {
    if ((o.signer ?? (o.walletKeyFile ? "local" : this.cfg.signer)) === "baw") {
      if (o.walletKeyFile) throw new ToolError("signer=baw uses the Binance Agentic Wallet signed in with `baw auth signin`; walletKeyFile is for a key held here (MURKFUN_BAW_ACCOUNT picks the agent-wallet address)");
      return this.bawSource();
    }
    if (o.walletKeyFile) {
      const k = fs.readFileSync(o.walletKeyFile, "utf8").trim();
      const key = (k.startsWith("0x") ? k : `0x${k}`) as Hex;
      if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new ToolError("walletKeyFile must contain one hex private key");
      return { eoaKey: key };
    }
    return {};
  }

  /** The Binance Agentic Wallet's address (`baw wallet address`; MURKFUN_BAW_ACCOUNT if it has several). */
  private async bawSource(): Promise<{ account: Address; signer: "baw" }> {
    const s = new BawSigner({ bin: this.cfg.bawPath, account: this.cfg.bawAccount, chainId: this.cfg.chainId });
    try {
      return { account: await s.address(), signer: "baw" };
    } catch (e) {
      throw new ToolError(foreign(e));
    }
  }

  /** The wallet signs the fixed seed message (twice: deterministic) and the vault keeps it; the 0xbow seed derives
   *  from it. The signature is never returned or logged. True if it was signed now. */
  private async ensureSeedSig(): Promise<boolean> {
    if (this.data.seedSig) return false;
    const sig = await this.signTyped(zk.seedTypedData(), true);
    if ((await zk.seedSigner(sig)) !== this.walletAddress) throw new ToolError("WRONG_SIGNER: the seed signature is not from this vault's wallet");
    try {
      zk.secretOf(sig); // canonical (low s) only
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
    this.data.seedSig = sig;
    this.data.seed = zk.privacySeedOf(sig);
    this.vault.save();
    this._secret = undefined; this._pp = undefined;
    return true;
  }

  /** Where the wallet is in the holder set of the current market's gate: in an accepted root (orders work), in a batch
   *  still in its challenge window, or not yet in (the operator adds new holders; no transaction from the user). The
   *  same source as orders: `source` "api" (the holder-set API's proof, checked here and on chain) or "logs". */
  private async holderStatus() {
    try {
      const p = await this.holderPath(await this.currentMarket());
      return { inAcceptedRoot: true, batch: p.batch, source: p.source };
    } catch (e) {
      const m = (e as Error).message;
      return { inAcceptedRoot: false, reason: m };
    }
  }

  /** Deposit BNB into 0xbow from the user's wallet (public; registers the wallet's 0xbow keystore first if needed).
   *  Needs ASP approval before it can fund buys. */
  async deposit(o: { amountBnb: string }) {
    const value = parseEther(o.amountBnb);
    if (value < MIN_DEPOSIT) throw new ToolError("BELOW_MINIMUM: the 0xbow minimum deposit is 0.02 BNB");
    const me = this.walletAddress;
    const bal = await this.pub.getBalance({ address: me });
    if (bal < value + parseEther("0.001")) throw new ToolError(`wallet has ${fmt(bal)} BNB; need ${o.amountBnb} + gas`);
    if (!(await this.pp.isKeystoreRegistered())) {
      // 0xbow's keystore (its own contract, not MurkFun's): registered once, from the wallet, before the first deposit
      await this.ownTx({ address: KS, abi: ksAbi, functionName: "setAuthPolicy", args: [this.pp.authDigest, this.pp.nkHash] });
    }
    const index = this.data.deposits.length;
    const d = await this.pp.depositProof(index, value);
    const rec = { index, value: value.toString(), label: d.note.label.toString(), commitment: d.note.commitment.toString(), createdAt: Date.now() } as VaultData["deposits"][number];
    this.data.deposits.push(rec);
    this.vault.save(); // record before sending: the secrets are derived from (seed, index)
    const advice = [
      ...(ROUND_DEPOSITS.includes(value) ? [] : ["Privacy: deposits of round amounts (0.5 / 1 / 5 BNB) blend in with everyone else's; an unusual amount is easier to follow."]),
      "Privacy: wait a while after the deposit before buying, and do not buy exactly the deposited amount: spend a different amount and keep some change in the pool.",
    ];
    const r = await this.ownTx({ address: EP, abi: epAbi, functionName: "deposit", args: [d.sol, d.noteData, "0x"], value, gas: 1_500_000n });
    const ts = await this.pp.commitmentTime(d.note.commitment);
    if (ts === 0n) throw new ToolError("deposit mined but the commitment is not in the pool?");
    rec.txHash = r.transactionHash;
    rec.timestamp = ts.toString();
    this.data.notes.push({ depositIndex: index, spendIndex: 0, value: value.toString(), label: rec.label, commitment: rec.commitment, timestamp: ts.toString(), status: "unspent" });
    this.vault.save();
    return {
      depositIndex: index, amountBnb: o.amountBnb, txHash: r.transactionHash, privacy: advice,
      next: "Wait for 0xbow ASP approval (it can take hours or much longer, and the ASP may not approve a deposit at all: then the user exits through 0xbow's own app, ragequit). Poll status every 5-10 minutes. Back up the vault now. Then buy any amount from the note: buy {token, bnbAmount, source:\"note\"}. Railgun (the default source) does not wait for 0xbow's ASP.",
    };
  }

  /** Deposits recorded but not yet seen on-chain (interrupted): add their notes. */
  private async syncDeposits() {
    let changed = false;
    for (const d of this.data.deposits) {
      if (d.timestamp || this.data.notes.some((n) => n.depositIndex === d.index)) continue;
      const ts = await this.pp.commitmentTime(BigInt(d.commitment));
      if (ts === 0n) continue;
      d.timestamp = ts.toString();
      this.data.notes.push({ depositIndex: d.index, spendIndex: 0, value: d.value, label: d.label, commitment: d.commitment, timestamp: ts.toString(), status: "unspent" });
      changed = true;
    }
    if (changed) this.vault.save();
  }

  /** `deployment: "custom"` (and what differs) when the deployment, relayer or verifier hash is not the bundled
   *  network file's (config.ts customValues), and every configuration warning (stderr is hidden by most clients). */
  private customStatus() {
    const c = this.cfg.custom ?? [], w = this.cfg.warnings ?? [];
    return {
      ...(c.length ? { deployment: "custom", customValues: c, warning: "these network values are not the bundled ones: orders and funds go to the configured addresses; check that the user set them" } : {}),
      ...(w.length ? { configWarnings: w, configWarningsNote: "tell the user before any deposit or order" } : {}),
    };
  }

  async status() {
    // the configuration warnings reach the agent even before setup (no vault yet)
    const w = this.cfg.warnings ?? [];
    if (!this.vault.exists() && w.length) throw new ToolError(`no vault yet: call setup first. CONFIGURATION WARNING: ${w.join(" ")} Tell the user before any deposit or order.`);
    const me = this.walletAddress;
    if (!this.data.seedSig) {
      const bal = await this.pub.getBalance({ address: me });
      return { wallet: me, ...this.customStatus(), walletBalanceBnb: fmt(bal), ...(await this.pauseStatus()), privacyFunding: await this.privacyFunding(), seedSigned: false, next: "call setup (the wallet signs the MurkFun seed message once)", notes: [], positions: [], recentOrders: this.data.orders.slice(-10) };
    }
    await this.syncDeposits();
    await this.settlePendingNotes();
    const market = await this.currentMarket();
    const [bal, nft] = await Promise.all([
      this.pub.getBalance({ address: me }),
      this.agentNft().then((a) => this.pub.readContract({ address: a, abi: agentNftAbi, functionName: "balanceOf", args: [me] })),
    ]);
    const notes: any[] = [];
    for (const n of this.data.notes.filter((x) => x.status !== "spent")) {
      const asp = await this.pp.aspStatus(BigInt(n.label));
      notes.push({ depositIndex: n.depositIndex, spendIndex: n.spendIndex, valueBnb: fmt(BigInt(n.value)), status: n.status, aspApproved: asp.approved, ...(asp.reason ? { asp: asp.reason } : {}) });
    }
    const positions: any[] = [];
    for (const t of this.data.tokens as Address[]) {
      const p = this.pseudonym(t);
      const [tb, bb, st] = await Promise.all([this.tread<bigint>(t, "tokenBalance", [t, p]), this.tread<bigint>(t, "bnbBalance", [t, p]), this.tokenState(t)]);
      positions.push({ token: t, tokens: fmt(tb), bnb: fmt(bb), graduated: st.graduated, isDev: st.devPseudonym === p });
    }
    return {
      wallet: me, ...this.customStatus(), ...(this.isBaw ? { signer: "baw" } : {}), walletBalanceBnb: fmt(bal), market, ...(await this.pauseStatus(market)), privacyFunding: await this.privacyFunding(),
      agentNft: nft > 0n, seedSigned: true, holderSet: await this.holderStatus(), keystoreRegistered: await this.pp.isKeystoreRegistered(),
      notes, positions, recentOrders: this.data.orders.slice(-10),
    };
  }

  /** Newest first. Public market data: from the indexer when configured and healthy, else read from the chain. */
  async listLaunches(o: { limit?: number; offset?: number } = {}) {
    const limit = Math.min(o.limit ?? 20, 100), offset = o.offset ?? 0;
    const ix = await this.indexer?.launches(limit, offset);
    if (ix) return { total: ix.total, source: "indexer", launches: ix.items.map(indexerSummary) };
    const n = Number(await this.pub.readContract({ address: this.D.factory, abi: factoryAbi, functionName: "tokenCount" }));
    const out: any[] = [];
    for (let i = n - 1 - offset; i >= 0 && out.length < limit; i--) {
      const t = await this.pub.readContract({ address: this.D.factory, abi: factoryAbi, functionName: "allTokens", args: [BigInt(i)] }) as Address;
      out.push(await this.summary(t));
    }
    return { total: n, source: "chain", ...(this.indexer?.lastError ? { indexerError: this.indexer.lastError } : {}), launches: out };
  }

  private async summary(t: Address) {
    const [name, symbol, st] = await Promise.all([
      this.pub.readContract({ address: t, abi: tokenAbi, functionName: "name" }),
      this.pub.readContract({ address: t, abi: tokenAbi, functionName: "symbol" }),
      this.tokenState(t),
    ]);
    const price = st.graduated ? undefined : await this.tread<bigint>(t, "curvePrice", [t]);
    return {
      token: t, name, symbol, graduated: st.graduated, ...(st.graduated ? { venue: st.venue } : {}),
      raisedBnb: fmt(st.bnbReserve), curveProgressPct: Number((st.tokensSold * 10000n) / st.curveSupply) / 100, curveFeeBps: st.tradeFeeBps,
      ...(price !== undefined ? { curvePriceBnbPerToken: fmt(price) } : {}),
    };
  }

  /** Token state, dev and the user's own position are read on chain; volume, holders, price history (`market`) come
   *  from the indexer when one is configured and has the token. */
  async tokenInfo(o: { token: string }) {
    const t = asAddress(o.token, "token");
    const p = this.pseudonym(t);
    const [s, st, uri, tb, bb, cap, nonce, ix] = await Promise.all([
      this.summary(t), this.tokenState(t), this.pub.readContract({ address: t, abi: tokenAbi, functionName: "metadataURI" }),
      this.tread<bigint>(t, "tokenBalance", [t, p]), this.tread<bigint>(t, "bnbBalance", [t, p]), this.tread<bigint>(t, "capOf", [t, p]), this.tread<bigint>(t, "nonces", [t, p]),
      this.indexer?.token(t),
    ]);
    return {
      ...s, metadataURI: uri, marketContract: await this.marketOf(t), devFeeRecipient: st.devFeeRecipient, devFeesBnb: fmt(st.devFees),
      ...(st.graduated ? { postGraduation: await this.postGraduation(t, Number(st.venue.venue)) } : {}),
      ...(ix ? { market: indexerMarket(ix), marketSource: "indexer" } : { marketSource: "chain", ...(this.indexer?.lastError ? { indexerError: this.indexer.lastError } : {}) }),
      me: {
        pseudonym: p.toString(), tokens: fmt(tb), bnb: fmt(bb), isDev: st.devPseudonym === p, capTokens: st.graduated ? "none (graduated)" : fmt(cap),
        ...(st.graduated ? {} : { capRoomTokens: fmt(capRoom(cap, tb)) }), nonce: nonce.toString(),
      },
    };
  }

  /** After graduation. Infinity (venue 1): the LP is burnt (a CLPositionManager NFT owned by 0x…dEaD) and MurkFunInfinityHook
   *  charges the token's fee in BNB on every swap through the pool (MurkFun's routing and everyone else's), paid 50/50 (the
   *  token's split) to the dev / platform recipients by claim_lp_fees. v3 / V2: MurkFunLocker holds the LP; its fees are paid
   *  in BNB (WBNB) and the token. Read on chain. */
  private async postGraduation(t: Address, venue: number) {
    // the Dex that graduated this token and the locker / hook that took its position (a later re-point never moves them)
    const dex = await this.tread<Address>(t, "dexOf", [t]);
    const [split, locker] = await Promise.all([
      this.tread<number>(t, "lockerDevShareBps", [t]),
      this.pub.readContract({ address: dex, abi: dexAbi, functionName: "lockerOf", args: [t] }) as Promise<Address>,
    ]);
    if (venue !== 1) return { lp: "locked in MurkFunLocker (never withdrawable)", locker, fees: "LP fees in BNB (WBNB) + token", devShareBps: split };
    const hook = await this.pub.readContract({ address: dex, abi: dexAbi, functionName: "hookOf", args: [t] }) as Address;
    const [pos, feeBps, earned, unpaid] = await Promise.all([
      this.pub.readContract({ address: locker, abi: lockerAbi, functionName: "positions", args: [t] }) as Promise<readonly [number, Address, bigint, Hex]>,
      this.tread<number>(t, "infinityFeeBps", [t]),
      this.pub.readContract({ address: hook, abi: hookAbi, functionName: "feesEarned", args: [t] }) as Promise<bigint>,
      this.pub.readContract({ address: hook, abi: hookAbi, functionName: "feesAccrued", args: [t] }) as Promise<bigint>,
    ]);
    return {
      lp: "burnt: PancakeSwap Infinity position NFT owned by 0x000000000000000000000000000000000000dEaD", positionId: pos[2].toString(), locker, hook,
      fees: `${Number(feeBps) / 100}% of every swap, in BNB only`, feeBps: Number(feeBps), earnedBnb: fmt(earned), unpaidBnb: fmt(unpaid),
      devShareBps: split,
    };
  }

  /** The smallest ASP-approved unspent note holding at least `amount` (keeps big notes whole). Throws a clear error
   *  when every big-enough note is still waiting for the ASP, or when no single note is big enough. */
  private async spendableNote(amount: bigint): Promise<NoteRec> {
    await this.syncDeposits();
    await this.settlePendingNotes();
    const unspent = this.data.notes.filter((n) => n.status === "unspent");
    const candidates = unspent.filter((n) => BigInt(n.value) >= amount).sort((x, y) => (BigInt(x.value) < BigInt(y.value) ? -1 : 1));
    if (!candidates.length) {
      if (this.data.notes.some((n) => n.status === "pending")) throw new ToolError("a note spend is still pending (until its order lands, or its deadline passes without it: at most a few minutes); check order_status / status and retry");
      const sizes = unspent.map((n) => BigInt(n.value)).filter((v) => v > 0n).sort((x, y) => (x > y ? -1 : 1));
      throw new ToolError(sizes.length
        ? `NOTE_TOO_SMALL: no single 0xbow note holds ${fmt(amount)} BNB (largest: ${fmt(sizes[0])}; notes: ${sizes.map(fmt).join(", ")}). ` +
          "One buy spends one note. Buy at most the largest note's value, split the purchase into several buys (one per note), or deposit more. " +
          "(Merging notes is a 0xbow transaction this MCP does not make; 0xbow's own app can.)"
        : "no unspent 0xbow note: deposit first");
    }
    let firstReason = "";
    for (const n of candidates) {
      const asp = await this.pp.aspStatus(BigInt(n.label));
      if (asp.approved) return n;
      if (!firstReason) {
        const d = this.data.deposits.find((x) => x.index === n.depositIndex);
        const mins = d ? Math.round((Date.now() - d.createdAt) / 60_000) : undefined;
        firstReason = `WAITING_FOR_ASP: deposit #${n.depositIndex}${mins !== undefined ? ` (made ${mins} min ago)` : ""} is not usable yet: ${asp.reason}. ` +
          "0xbow's ASP must approve each deposit before it can fund buys; this can take hours or longer. " +
          "Nothing was spent. Poll status every 5-10 minutes and retry once aspApproved is true, or pay from Railgun instead " +
          "(buy without source, or source=railgun: it does not wait for 0xbow's ASP).";
      }
    }
    throw new ToolError(firstReason);
  }

  /** Plain privacy warnings for a 0xbow buy of `amount` from note `n` (never blocking). */
  private privacyWarnings(n: NoteRec, amount: bigint, nowS: bigint): string[] {
    const out: string[] = [];
    const d = this.data.deposits.find((x) => x.index === n.depositIndex);
    if (d && BigInt(d.value) === amount) out.push("This buy spends exactly the deposited amount, which links it to your deposit. A different amount (keeping some change in the pool) blends in better.");
    if (n.timestamp && nowS - BigInt(n.timestamp) < WAIT_AFTER_DEPOSIT_S && n.spendIndex === 0) out.push("This deposit is less than an hour old. Waiting a while after depositing makes the buy harder to tie to it.");
    return out;
  }

  /** A curve buy as the market computes it (quoteBuy for `amount` BNB gross, quoteBuyExactOut for `amount` tokens).
   *  `completes`: it takes the rest of the curve (it fills only that, and graduates the token in the same
   *  transaction): bnbUsed < amount (exact in) or filled < amount (exact out), or exactly the rest. */
  private async curveQuote(t: Address, st: { tokensSold: bigint; curveSupply: bigint }, amount: bigint, exactOut: boolean) {
    const [tokensOut, bnbUsed, fee] = await this.tread<readonly bigint[]>(t, exactOut ? "quoteBuyExactOut" : "quoteBuy", [t, amount]);
    return { tokensOut, bnbUsed, fee, completes: completesCurve(st.curveSupply - st.tokensSold, amount, exactOut, tokensOut, bnbUsed) };
  }

  /** curveQuote with the holding-cap check (the contract enforces the same cap). */
  private async curvePlan(t: Address, st: { tokensSold: bigint; curveSupply: bigint }, amount: bigint, exactOut: boolean) {
    const q = await this.curveQuote(t, st, amount, exactOut);
    const p = this.pseudonym(t);
    const [have, cap] = await Promise.all([this.tread<bigint>(t, "tokenBalance", [t, p]), this.tread<bigint>(t, "capOf", [t, p])]);
    if (have + q.tokensOut > cap) {
      throw new ToolError(`OVER_CAP: this buy (~${fmt(q.tokensOut)} tokens) would exceed the curve-phase holding cap of ${fmt(cap)} tokens ` +
        `(you hold ${fmt(have)}; at most ${fmt(capRoom(cap, have))} more: tokens:"cap" buys exactly that). Buy less, or wait for graduation (no cap after it).`);
    }
    return q;
  }

  /** `tokens` of an exact-out buy: a decimal amount, or "cap" = the room left under this pseudonym's holding cap
   *  (curve phase; the dev pseudonym's cap is the platform's dev limit). */
  private async tokensWanted(t: Address, st: { graduated: boolean }, tokens: string): Promise<bigint> {
    if (tokens !== "cap") return parseEther(tokens);
    if (st.graduated) throw new ToolError("tokens:\"cap\" applies during the curve only (there is no holding cap after graduation): give a token amount");
    const p = this.pseudonym(t);
    const [have, cap] = await Promise.all([this.tread<bigint>(t, "tokenBalance", [t, p]), this.tread<bigint>(t, "capOf", [t, p])]);
    const room = capRoom(cap, have);
    if (room === 0n) throw new ToolError(`OVER_CAP: you already hold the curve-phase cap of ${fmt(cap)} tokens; nothing left to buy before graduation`);
    return room;
  }

  /** The emergency pause of `market` (default: the current market) as `status` reports it: paused now, who holds the
   *  guardian role (one hot key; the owner removes it at once and sets a new one through the timelock), a new guardian
   *  the owner proposed (pending until `pendingGuardianEta`, void if the market is paused meanwhile), and whether the
   *  power was renounced (then nothing can pause). */
  private async pauseStatus(market?: Address) {
    const m = market ?? await this.currentMarket();
    const G = stringToHex("pauseGuardian", { size: 32 });
    const [marketPaused, pauseGuardian, pending, eta, pauseRenounced] = await Promise.all([
      this.cread<boolean>("paused", [], m), this.cread<Address>("pauseGuardian", [], m),
      this.cread<readonly [bigint, bigint, bigint]>("pendingChange", [G], m), this.cread<bigint>("etaOf", [G], m),
      this.cread<boolean>("pauseRenounced", [], m),
    ]);
    const pendingGuardian = eta !== 0n ? getAddress(`0x${pending[0].toString(16).padStart(40, "0")}`) : null;
    return {
      marketPaused, pauseGuardian, pausePowerActive: pauseGuardian !== zeroAddress, pauseRenounced,
      ...(pendingGuardian ? { pendingGuardian, pendingGuardianEta: new Date(Number(eta) * 1000).toISOString() } : {}),
    };
  }

  /** The curve-phase funding rule: while `requiredOnCurve`, MurkFun accepts BNB for a token still on its
   *  curve only from an allowlisted privacy-pool contract: MurkFun's Railgun adapter (buy / fund_pseudonym /
   *  create_token, source=railgun, the default) or MurkFun's 0xbow adapter (buy / create_token source=note). After
   *  graduation it does not apply. */
  private async privacyFunding() {
    const [requiredOnCurve, allowlist] = await Promise.all([
      this.pub.readContract({ address: this.D.factory, abi: factoryAbi, functionName: "privacyFundingRequired" }) as Promise<boolean>,
      this.pub.readContract({ address: this.D.factory, abi: factoryAbi, functionName: "privacyFunders" }) as Promise<Address[]>,
    ]);
    return { requiredOnCurve, allowlist: allowlist.map((a) => getAddress(a)) };
  }

  /** Whether a plain wallet may pay into a BuyDirect / Fund / creator-buy Launch order now (rule off, or the token
   *  graduated); throws a clear error if MurkFun's Railgun adapter is needed but not allowlisted. */
  private async publicFundingAllowed(graduated: boolean, adapter: Address) {
    if (graduated) return true;
    const pf = await this.privacyFunding();
    if (!pf.requiredOnCurve) return true;
    if (!pf.allowlist.some((a) => a === getAddress(adapter))) {
      throw new ToolError(`PRIVACY_POOL_REQUIRED: ${PRIVACY_RULE} MurkFun's Railgun adapter (${adapter}) is not on MurkFun's allowlist right now, ` +
        "so use source=note (0xbow) for this token. Nothing was sent.");
    }
    return false;
  }

  /** MurkFunRailgunAdapter of this deployment (every source=railgun path). */
  private railgunAdapter(): Address {
    if (!this.D.railgunAdapter) {
      throw new ToolError("NO_RAILGUN_ADAPTER: this MurkFun deployment has no Railgun adapter (deployment.railgunAdapter); use source=note (0xbow). Nothing was signed or sent");
    }
    return getAddress(this.D.railgunAdapter);
  }

  /** What a Railgun wallet needs for a signed order paid from Railgun: transactions that unshield WBNB to
   *  MurkFunRailgunAdapter (`unshield`: the gross that delivers exactly `order.amount` after Railgun's unshield fee, read
   *  now), bound to the adapter (`adaptContract`) and to this order (`adaptParams` = the adapter's
   *  keccak256(abi.encode(order))), then `submit`: the adapter's execute (or launch, with the token spec) with them, the
   *  order and its proof. The adapter pays the order exactly what the unshield delivered: nothing else can fund it. */
  private async railgunCall(adapter: Address, made: Made, spec?: { name: string; symbol: string; metadataURI: string; devFeeRecipient: Address; devSalt: Hex; launchSig: Hex }) {
    const rd = <T>(functionName: string, args: unknown[] = []) =>
      this.pub.readContract({ address: adapter, abi: railgunAdapterAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
    const [railgun, wbnb, adaptParams] = await Promise.all([rd<Address>("railgun"), rd<Address>("WBNB"), rd<Hex>("adaptParams", [made.order])]);
    const feeBps = BigInt(await this.pub.readContract({ address: railgun, abi: railgunAbi, functionName: "unshieldFee" }) as bigint);
    return {
      adapter, railgunProxy: getAddress(railgun),
      unshield: { token: getAddress(wbnb), amountWei: railgunGross(made.order.amount, feeBps).toString(), to: adapter, unshieldFeeBps: Number(feeBps), arrivesWei: made.order.amount.toString() },
      adaptContract: adapter, adaptParams,
      submit: {
        function: spec
          ? "launch((string,string,string,address,bytes32,bytes) spec, transactions, order, bytes orderProof)"
          : "execute(transactions, order, bytes orderProof)",
        order: wireOrder(made.order), orderEncoded: orderData(made.order), orderProof: made.proof,
        // the token spec ABI-encoded (its name / symbol are exactly the ones the order's token address commits to)
        ...(spec ? { specEncoded: encodeAbiParameters([TOKEN_SPEC_TUPLE], [spec]) } : {}),
      },
    };
  }

  /** Simulate the order call exactly as MurkFunRailgunAdapter makes it after its unshield: from the adapter, carrying
   *  the BNB (a state override gives the adapter the balance). */
  private async simulateAsAdapter(adapter: Address, call: { to: Address; value: bigint; data: Hex }) {
    try {
      return (await this.pub.call({ account: adapter, to: call.to, data: call.data, value: call.value, stateOverride: [{ address: adapter, balance: call.value + parseEther("1") }] })).data;
    } catch (e) {
      throw this.quoteError(e);
    }
  }

  /** Every market action is refused while the MurkFun guardian has paused `market` (the token's own market; the
   *  current one for a launch): launches, buys, sells, funding, graduation, withdraw_bnb, withdraw_tokens, the fee
   *  recipient change and curve fee claims. An emergency switch with no expiry: it lasts until the guardian unpauses
   *  or renounces, and the unpause resumes all of it. LP fee collection on a graduated pool (MurkFunLocker) is outside
   *  the market and is not paused. */
  private async isPaused(market: Address) {
    return await this.cread<boolean>("paused", [], market);
  }

  private async notPaused(what: string, market: Address) {
    if (!(await this.isPaused(market))) return;
    throw new ToolError(`MARKET_PAUSED: MurkFun is paused by its guardian (emergency switch), so ${what} is not possible right now. ` +
      "Nothing was sent. While paused every MurkFun action waits (launches, buys, sells, funding, graduation, withdraw_bnb, " +
      "withdraw_tokens, fee claims); your balances and holdings stay where they are. Everything resumes when the guardian " +
      "unpauses (the pause has no expiry; check status for marketPaused). LP fee collection on graduated pools is not paused.");
  }

  /** Refused while the token's market is paused (`notPaused`). `selling`: a sold-out curve still takes sells (exits
   *  never wait for a graduation); only buys wait for it. */
  private async tradable(t: Address, selling = false) {
    await this.notPaused(selling ? "selling" : "buying", await this.marketOf(t));
    const st = await this.tokenState(t);
    if (!st.graduated && st.tokensSold === st.curveSupply && !selling) {
      throw new ToolError("curve sold out but not graduated (its automatic graduation failed): buys wait until someone calls graduate (sells to the curve still work); then trade on the DEX pool");
    }
    return st;
  }

  /** Buy `bnbAmount` BNB worth (exact in) or exactly `tokens` tokens (exact out; "cap" = up to the holding cap):
   *  from Railgun (default: a signed order and the Railgun transaction to build for it, sent by submit_railgun; nothing
   *  sent from here), from a 0xbow note (source=note; any amount the note holds, the change stays in 0xbow), or from the
   *  internal balance. `dryRun`: quote only (expected fill, relayer fee and gas class, whether it completes the curve);
   *  nothing is proved or sent. */
  async buy(o: { token: string; source?: "note" | "railgun" | "balance"; bnbAmount?: string; tokens?: string; slippageBps?: number; validMinutes?: number; dryRun?: boolean; selfSubmit?: boolean }) {
    const t = asAddress(o.token, "token");
    const source = o.source ?? "railgun";
    if (!o.bnbAmount === !o.tokens) {
      throw new ToolError("give bnbAmount (BNB to spend, e.g. \"0.37\") or tokens (exactly this many tokens, e.g. \"1000000\", or \"cap\" = up to your holding cap), not both");
    }
    const st = await this.tradable(t);
    const exactOut = !!o.tokens;
    const amount = exactOut ? await this.tokensWanted(t, st, o.tokens!) : parseEther(o.bnbAmount!);
    if (amount <= 0n) throw new ToolError(`BELOW_MINIMUM: ${exactOut ? "tokens" : "bnbAmount"} must be > 0`);
    const w: Want = { amount, exactOut, slip: BigInt(o.slippageBps ?? 300), dryRun: !!o.dryRun };
    if (source === "railgun") return this.railgunBuy(t, st, w, o.validMinutes, !!o.selfSubmit);
    if (!w.dryRun) this.track(t);
    if (source === "note") {
      const r = await this.buyFromNote(t, st, w);
      return w.dryRun ? r : { ...r, balance: await this.position(t) };
    }
    return this.buyFromBalance(t, st, w);
  }

  /** source=balance: a Buy order (exact in) or a BuyExactOut order (at most cost x (1 + slippage), at most the
   *  balance minus the relayer fee) from the pseudonym's internal BNB balance. */
  private async buyFromBalance(t: Address, st: TokenSt, w: Want) {
    const p = this.pseudonym(t);
    const plan = st.graduated ? undefined : await this.curvePlan(t, st, w.amount, w.exactOut);
    const action = w.exactOut ? "buyExactOut" : "buy";
    const rq = await this.relayQuote(action, { token: t, amount: w.amount, exactOut: w.exactOut, completes: plan?.completes });
    const { relay } = rq;
    const bal = await this.tread<bigint>(t, "bnbBalance", [t, p]);
    let bnb: bigint, expected: bigint, cost: bigint, minOut = 0n;
    if (!w.exactOut) {
      bnb = w.amount;
      cost = plan?.bnbUsed ?? bnb; // a buy that completes the curve spends only what the rest costs
      if (bal < cost + relay.fee) throw new ToolError(`InsufficientBalance: internal balance ${fmt(bal)} BNB < ${fmt(cost)} + relayer fee ${fmt(relay.fee)}`);
      expected = plan ? plan.tokensOut : await this.simulateOrder(t, { action: zk.ACTION.Buy, amount: bnb, relayer: relay.relayer });
      minOut = expected * (BPS - w.slip) / BPS;
    } else {
      cost = plan ? plan.bnbUsed : await this.routedExactOutBound(t, w.amount);
      const room = bal > relay.fee ? bal - relay.fee : 0n;
      checkFeeShare(action, relay.fee, cost, this.cfg.maxRelayerFeeBps);
      bnb = minBig(withSlippage(cost, w.slip), room);
      if (bnb < cost) throw new ToolError(`InsufficientBalance: ${fmt(w.amount)} tokens cost ~${fmt(cost)} BNB + relayer fee ${fmt(relay.fee)}; the internal balance is ${fmt(bal)} BNB`);
      expected = plan ? plan.tokensOut : w.amount;
    }
    const quote = {
      expectedTokens: fmt(expected), ...(w.exactOut ? { maxBnb: fmt(bnb), [plan ? "costBnb" : "costBoundBnb"]: fmt(cost) } : { minTokens: fmt(minOut) }),
      ...MurkFunAgent.feeInfo(rq), ...MurkFunAgent.completionInfo(plan?.completes || rq.completing, bnb > cost ? bnb - cost : 0n, true),
    };
    if (w.dryRun) return { dryRun: true, token: t, source: "balance", ...quote };
    const made = await this.makeOrder({ action: w.exactOut ? zk.ACTION.BuyExactOut : zk.ACTION.Buy, token: t, amount: bnb, minOut: w.exactOut ? w.amount : minOut, relay });
    const s = await this.submitOrder(action, t, made);
    return { ...MurkFunAgent.orderResult(s), source: "balance", ...quote, ...(await this.buyOutcome(t, s, bnb)), balance: await this.position(t) };
  }

  /** `completesCurve` / graduation text for a buy that completes the curve (and the BNB it is expected not to spend). */
  static completionInfo(completes: boolean, unspent: bigint, relayed: boolean) {
    return {
      ...(completes
        ? { completesCurve: true, graduation: relayed ? GRADUATION_NOTE : `${GRADUATION_NOTE_DIRECT} Give the transaction enough gas: ~${GRADUATION_GAS_HINT} more than a plain buy.` }
        : {}),
      ...(unspent > 0n ? { expectedUnspentBnb: fmt(unspent), unspent: UNSPENT_NOTE } : {}),
    };
  }

  /** Railgun: a signed BuyDirect (exact in) or BuyDirectExactOut (exact out, value = cost x (1 + slippage) + relayer
   *  fee) order, paid by a Railgun unshield to MurkFun's Railgun adapter (`railgun`: what the Railgun wallet builds).
   *  The order names the MurkFun relayer and its fee (quoted like a 0xbow buy, relayer action railgunBuy), and `relay`
   *  is what submit_railgun posts once the Railgun transactions exist: the relayer sends the adapter call, so no wallet
   *  of the user pays gas. `selfSubmit`: an order without a relayer fee, to be sent by any account (`railgun.submit`).
   *  The adapter pays the order exactly what the unshield delivered and buys in the same transaction (with up to
   *  `amount - fee`); the rest of the Railgun balance stays shielded. A plain wallet may send the order itself (`call`)
   *  only after graduation or with the curve-phase rule off. BNB the buy does not need stays in the pseudonym's
   *  internal balance. Nothing is sent from here. */
  private async railgunBuy(t: Address, st: TokenSt, w: Want, validMinutes: number | undefined, selfSubmit: boolean) {
    const adapter = this.railgunAdapter();
    const p = this.pseudonym(t);
    const deadline = await this.deadlineIn(validMinutes ?? RAILGUN_VALID_MINUTES);
    const nonce = await this.tread<bigint>(t, "nonces", [t, p]);
    const publicOk = await this.publicFundingAllowed(st.graduated, adapter);
    let value: bigint, expected: bigint, cost: bigint, minOut = 0n;
    let plan: Awaited<ReturnType<MurkFunAgent["curvePlan"]>> | undefined;
    let rq: Awaited<ReturnType<MurkFunAgent["relayQuote"]>> | undefined;
    if (!w.exactOut) {
      value = w.amount;
      // the relayer fee comes out of the unshielded BNB: the buy gets the rest (as a 0xbow buy)
      rq = selfSubmit ? undefined : await this.noteBuyQuote(t, st, value, "railgunBuy");
      const net = value - (rq?.relay.fee ?? 0n);
      plan = st.graduated ? undefined : await this.curvePlan(t, st, net, false);
      // after graduation the quote is the market's own routed buyDirect (venue-agnostic)
      expected = plan ? plan.tokensOut : await this.routedBuy(t, net);
      cost = plan?.bnbUsed ?? net;
      minOut = expected * (BPS - w.slip) / BPS;
    } else {
      plan = st.graduated ? undefined : await this.curvePlan(t, st, w.amount, true);
      cost = plan ? plan.bnbUsed : await this.routedExactOutBound(t, w.amount);
      rq = selfSubmit ? undefined : await this.relayQuote("railgunBuy", { token: t, amount: w.amount, exactOut: true, completes: plan?.completes, valueWei: cost });
      value = withSlippage(cost, w.slip) + (rq?.relay.fee ?? 0n);
      expected = plan ? plan.tokensOut : w.amount;
    }
    // a Railgun proof takes a while: the order is valid for validMinutes, not the quote's few minutes
    const relay: Relay = rq ? { ...rq.relay, deadline } : { relayer: zeroAddress, fee: 0n, deadline };
    const net = value - relay.fee;
    const quote = {
      bnbAmount: fmt(value), expectedTokens: fmt(expected),
      ...(w.exactOut ? { tokens: fmt(w.amount), [plan ? "costBnb" : "costBoundBnb"]: fmt(cost) } : { minTokens: fmt(minOut) }),
      // selfSubmit: no relayer fee in the order (BNB above the cost is slippage room, kept in the balance: expectedUnspentBnb)
      ...(rq ? { boughtWithUpToBnb: fmt(net), ...MurkFunAgent.feeInfo(rq) } : { relayerFeeBnb: "0" }),
      ...MurkFunAgent.completionInfo(!!plan?.completes, net > cost ? net - cost : 0n, !!rq),
    };
    // a quote like the other dry runs: nothing is signed, proved or recorded
    if (w.dryRun) return { dryRun: true, token: t, source: "railgun", ...quote };
    this.track(t);
    const made = await this.makeOrder({ action: w.exactOut ? zk.ACTION.BuyDirectExactOut : zk.ACTION.BuyDirect, token: t, amount: value, minOut: w.exactOut ? w.amount : minOut, relay, nonce });
    const call = this.orderCall(made, value);
    await this.simulateAsAdapter(adapter, call);
    const railgun = await this.railgunCall(adapter, made);
    return {
      token: t, source: "railgun", ...quote, pseudonymNonce: nonce.toString(), deadline: relay.deadline.toString(),
      railgun,
      ...(rq ? { relay: this.railgunRelay("railgunBuy", t, made, railgun, net) } : {}),
      ...(publicOk ? { call: { to: call.to, value: call.value.toString(), data: call.data } } : { privacyRule: PRIVACY_RULE }),
      howTo: [
        `${RAILGUN_BUILD} ${rq ? RAILGUN_RELAY : RAILGUN_SELF}`,
        `All of the BNB is paid into MurkFun for this pseudonym${rq ? "; the relayer fee is paid from it" : ""}. ${UNSPENT_NOTE} If the price moved past the slippage limit or the cap would be crossed, the whole transaction reverts and nothing is unshielded.`,
        publicOk
          ? "Any other address can send `call` instead (it carries the BNB); that address is public and links itself to this pseudonym; the proofs do not link the pseudonym to your other pseudonyms (timing, amounts and IP can)."
          : `${PRIVACY_RULE} So there is no plain-wallet version of this call while the token is on its curve (MurkFun rejects it with PrivacyPoolRequired).`,
        `Valid until ${new Date(Number(relay.deadline) * 1000).toISOString()} and only while the pseudonym's nonce is ${nonce}: do not trade this token before it lands; if it went stale, call buy again (source railgun, the default: a new order, signed again).`,
        "Privacy: Binance sees when your wallet signed this order; let a random while pass before the Railgun transaction is sent.",
      ],
    };
  }

  /** `relay` of a Railgun-paid order the MurkFun relayer submits: its URL and the exact body to POST to /v1/orders
   *  once the Railgun transactions exist (`transactions` empty until then). Kept in the vault for submit_railgun (`id`). */
  private railgunRelay(action: RailgunRelayAction, t: Address, made: Made, rg: Awaited<ReturnType<MurkFunAgent["railgunCall"]>>, offered: bigint, spec?: Record<string, unknown>) {
    const id = crypto.randomBytes(6).toString("hex");
    const body = { action, ...(spec ? { spec } : {}), adapter: rg.adapter, transactions: [] as unknown[], order: wireOrder(made.order), proof: made.proof };
    const now = Date.now();
    // forget records whose order expired more than a day ago
    const list = (this.data.railgunRelays ?? []).filter((r) => Number(r.deadline) * 1000 > now - 86_400_000);
    const { transactions: _none, ...kept } = body;
    const rec: RailgunRelayRec = {
      id, action, token: t, createdAt: now, deadline: made.order.deadline.toString(), status: "pending",
      adapter: rg.adapter, adaptParams: rg.adaptParams, wbnb: rg.unshield.token, grossWei: rg.unshield.amountWei, offeredWei: offered.toString(), body: kept,
    };
    this.data.railgunRelays = [...list, rec];
    this.vault.save();
    return {
      id, url: this.relayer.url, method: "POST", endpoint: `${this.relayer.url}/v1/orders`, contentType: "application/json",
      relayer: made.order.relayer, feeBnb: fmt(made.order.fee),
      body,
      fill: "body.transactions = the proved Railgun transactions (IRailgun.Transaction as JSON, docs/RELAYER_API.md \"railgunBuy\"); then POST body, or call submit_railgun {id, transactions}",
      submitWith: `submit_railgun {"id":"${id}","transactions":[...]} (CLI: murkfun-mcp submit_railgun --id ${id} --transactionsFile <file>)`,
    };
  }

  /** A signed Fund order paid by a Railgun unshield to MurkFun's Railgun adapter (`railgun`), or, after graduation or
   *  with MurkFun's curve-phase rule off, by any wallet (`calls`, which can chain a Buy / BuyExactOut order from the
   *  funded balance; while the rule is on `calls` is omitted and `privacyRule` explains why). A chained buy needs the
   *  plain-wallet calls: with Railgun, buy source=railgun buys directly. Nothing is sent from here. Each order is signed
   *  by the wallet and binds the amount and the pseudonym's next nonce(s): any other action for this token first makes
   *  them stale (the call reverts and nothing is spent). */
  async fundPseudonym(o: { token: string; source?: "railgun" | "note"; amountBnb: string; buyBnb?: string; buyTokens?: string; slippageBps?: number; validMinutes?: number; selfSubmit?: boolean }) {
    // Railgun is the only private source a funding takes: a 0xbow note pays a buy (or a launch) directly
    if (o.source === "note") throw new ToolError("NO_NOTE_FUNDING: fund_pseudonym is paid from Railgun (the default); a 0xbow note pays a buy directly: buy {token, bnbAmount, source:\"note\"}. Nothing was signed or sent");
    const t = asAddress(o.token, "token");
    const value = parseEther(o.amountBnb);
    if (value <= 0n) throw new ToolError("BELOW_MINIMUM: amountBnb must be > 0");
    if (o.buyBnb && o.buyTokens) throw new ToolError("give buyBnb or buyTokens, not both");
    const market = await this.marketOf(t);
    await this.notPaused("funding a pseudonym", market);
    const chained = !!(o.buyBnb || o.buyTokens);
    const st = chained ? await this.tradable(t) : await this.tokenState(t);
    if (chained && st.graduated) throw new ToolError("after graduation fund first, then buy with source=balance (the DEX quote needs the funded balance)");
    const adapter = this.railgunAdapter();
    const publicOk = await this.publicFundingAllowed(st.graduated, adapter);
    if (chained && !publicOk) {
      throw new ToolError(`RAILGUN_BUYS_DIRECTLY: ${PRIVACY_RULE} A Railgun unshield pays one order, so a buy can not be chained to a Railgun funding: use buy source=railgun (it buys in the same transaction), or fund_pseudonym without buyBnb / buyTokens and then buy source=balance. Nothing was signed or sent.`);
    }
    this.track(t);
    const p = this.pseudonym(t);
    const slip = BigInt(o.slippageBps ?? 300);
    const deadline = await this.deadlineIn(o.validMinutes ?? RAILGUN_VALID_MINUTES);
    // the MurkFun relayer sends the Railgun funding for a fee paid from the credited BNB; a chained buy is a
    // plain-wallet call list (after graduation), sent by that wallet: no relayer fee
    const rq = o.selfSubmit || chained ? undefined : await this.relayQuote("railgunFund", { valueWei: value });
    if (rq && rq.relay.fee >= value) throw new ToolError(`BELOW_MINIMUM: relayer fee ${fmt(rq.relay.fee)} BNB >= the ${fmt(value)} BNB funding`);
    const relay: Relay = rq ? { ...rq.relay, deadline } : { relayer: zeroAddress, fee: 0n, deadline };
    const nonce = await this.tread<bigint>(t, "nonces", [t, p]);
    const fundOrder = await this.makeOrder({ action: zk.ACTION.Fund, token: t, amount: value, minOut: 0n, relay, nonce });
    const calls = [this.orderCall(fundOrder, value)];
    let chainedBuy: Record<string, unknown> = {};
    if (chained) {
      const exactOut = !!o.buyTokens;
      const amount = exactOut ? await this.tokensWanted(t, st, o.buyTokens!) : parseEther(o.buyBnb!);
      if (amount <= 0n) throw new ToolError("BELOW_MINIMUM: the chained buy must be > 0");
      const plan = await this.curvePlan(t, st, amount, exactOut);
      const bal = await this.tread<bigint>(t, "bnbBalance", [t, p]);
      if (bal + value < plan.bnbUsed) throw new ToolError(`InsufficientBalance: the buy costs ${fmt(plan.bnbUsed)} BNB > amountBnb + internal balance ${fmt(bal)}`);
      if (exactOut) {
        const maxBnb = minBig(withSlippage(plan.bnbUsed, slip), bal + value);
        calls.push(this.orderCall(await this.makeOrder({ action: zk.ACTION.BuyExactOut, token: t, amount: maxBnb, minOut: amount, relay, nonce: nonce + 1n }), 0n));
        chainedBuy = { buyTokens: fmt(amount), expectedTokens: fmt(plan.tokensOut), costBnb: fmt(plan.bnbUsed), maxBnb: fmt(maxBnb) };
      } else {
        const minOut = plan.tokensOut * (BPS - slip) / BPS;
        calls.push(this.orderCall(await this.makeOrder({ action: zk.ACTION.Buy, token: t, amount, minOut, relay, nonce: nonce + 1n }), 0n));
        chainedBuy = { buyBnb: fmt(amount), expectedTokens: fmt(plan.tokensOut), minTokens: fmt(minOut) };
      }
      chainedBuy = { ...chainedBuy, ...MurkFunAgent.completionInfo(plan.completes, 0n, false) };
    }
    await this.simulateAsAdapter(adapter, calls[0]);
    const railgun = await this.railgunCall(adapter, fundOrder);
    return {
      token: t, amountBnb: fmt(value), ...(rq ? { creditedBnb: fmt(value - relay.fee), ...MurkFunAgent.feeInfo(rq) } : {}),
      pseudonymNonce: nonce.toString(), deadline: relay.deadline.toString(), ...chainedBuy,
      ...(publicOk ? { calls: calls.map((c) => ({ to: c.to, value: c.value.toString(), data: c.data })) } : { privacyRule: PRIVACY_RULE }),
      railgun,
      ...(rq ? { relay: this.railgunRelay("railgunFund", t, fundOrder, railgun, value - relay.fee) } : {}),
      howTo: [
        `${RAILGUN_BUILD} ${rq ? RAILGUN_RELAY : RAILGUN_SELF}`,
        publicOk
          ? "Any wallet or other private source: send calls[] in order (calls[0] carries the BNB; the Railgun path funds only, calls[1] is the chained buy). Only the funding address is public (and linked to the pseudonym it funds); the proofs do not link that pseudonym to your other pseudonyms (timing, amounts and IP can)."
          : `${PRIVACY_RULE} A plain wallet cannot fund this pseudonym while the token is on its curve (MurkFun rejects it with PrivacyPoolRequired); use the Railgun transaction above, or buy source=note (0xbow).`,
        `Valid until ${new Date(Number(relay.deadline) * 1000).toISOString()} and only while the pseudonym's nonce is ${nonce}: do not trade this token before it lands; if it went stale, call fund_pseudonym again.`,
        "Afterwards check token_info; spend the balance with buy source=balance.",
      ],
    };
  }

  /** One 0xbow buy through MurkFun's 0xbow adapter (relayer order privacyPoolBuy): the 0xbow proof withdraws `amount`
   *  from the best-fitting note (the change note stays in 0xbow) and pays all of it into the pseudonym's balance; the
   *  buy spends up to `amount - relay.fee`, the relayer gets `relay.fee`. Exact in: `amount` = bnbAmount. Exact out:
   *  `amount` = cost x (1 + slippage) + relay.fee. BNB the buy does not need stays in the pseudonym's balance. */
  /** The relayer terms of an exact-in 0xbow buy of `amount` BNB. Its fee comes out of the withdrawal and the market
   *  buys with the rest, so whether the buy completes the curve (and pays the graduation gas) is decided on the net:
   *  the standard fee first, then the completing-buy quote only if the net completes the curve, and only if the net
   *  after that (higher) fee still completes it. */
  private async noteBuyQuote(t: Address, st: TokenSt, amount: bigint, action: "privacyPoolBuy" | "railgunBuy" = "privacyPoolBuy") {
    const std = await this.relayQuote(action, { token: t, valueWei: amount });
    if (std.relay.fee >= amount) throw new ToolError(`BELOW_MINIMUM: relayer fee ${fmt(std.relay.fee)} BNB >= the ${fmt(amount)} BNB buy`);
    if (st.graduated) return std;
    const net = amount - std.relay.fee;
    if (!(await this.curveQuote(t, st, net, false)).completes) return std;
    const rq = await this.relayQuote(action, { token: t, amount: net, completes: true });
    if (rq.relay.fee >= amount) throw new ToolError(`BELOW_MINIMUM: relayer fee ${fmt(rq.relay.fee)} BNB >= the ${fmt(amount)} BNB buy`);
    if (!(await this.curveQuote(t, st, amount - rq.relay.fee, false)).completes) {
      // after the standard fee the buy would complete the curve (and needs the completing-buy fee), after that fee it
      // would not: neither fee fits this amount
      const [, rest] = await this.tread<readonly bigint[]>(t, "quoteBuyExactOut", [t, 2n ** 256n - 1n]);
      throw new ToolError(
        `COMPLETION_BOUNDARY: ${fmt(amount)} BNB ends right at the end of the curve: the rest of the curve costs ${fmt(rest)} BNB, which ` +
        `with the completing-buy relayer fee (${fmt(rq.relay.fee)} BNB, it covers the graduation gas) is ${fmt(rest + rq.relay.fee)} BNB. ` +
        `Buy at least ${fmt(rest + rq.relay.fee)} BNB to complete the curve and graduate the token, or less than ${fmt(rest + std.relay.fee)} BNB.`,
      );
    }
    return rq;
  }

  private async buyFromNote(t: Address, st: TokenSt, w: Want) {
    let amount: bigint, tokensParam: bigint, expected: bigint, cost: bigint, minOut = 0n;
    let plan: Awaited<ReturnType<MurkFunAgent["curvePlan"]>> | undefined;
    let rq: Awaited<ReturnType<MurkFunAgent["relayQuote"]>>;
    if (!w.exactOut) {
      amount = w.amount;
      rq = await this.noteBuyQuote(t, st, amount);
      const net = amount - rq.relay.fee;
      plan = st.graduated ? undefined : await this.curvePlan(t, st, net, false);
      expected = plan ? plan.tokensOut : await this.routedBuy(t, net);
      cost = plan?.bnbUsed ?? net;
      minOut = expected * (BPS - w.slip) / BPS;
      tokensParam = minOut;
    } else {
      plan = st.graduated ? undefined : await this.curvePlan(t, st, w.amount, true);
      cost = plan ? plan.bnbUsed : await this.routedExactOutBound(t, w.amount);
      rq = await this.relayQuote("privacyPoolBuy", { token: t, amount: w.amount, exactOut: true, completes: plan?.completes, valueWei: cost });
      amount = withSlippage(cost, w.slip) + rq.relay.fee;
      expected = plan ? plan.tokensOut : w.amount;
      tokensParam = w.amount;
    }
    const { relay } = rq;
    const net = amount - relay.fee;
    const quote = {
      paidBnb: fmt(amount), boughtWithUpToBnb: fmt(net), expectedTokens: fmt(expected),
      ...(w.exactOut ? { tokens: fmt(w.amount), [plan ? "costBnb" : "costBoundBnb"]: fmt(cost) } : { minTokens: fmt(minOut) }),
      ...MurkFunAgent.feeInfo(rq), ...MurkFunAgent.completionInfo(!!plan?.completes, net > cost ? net - cost : 0n, true),
    };
    if (w.dryRun) {
      const n = await this.spendableNote(amount).then((x) => ({ noteBnb: fmt(BigInt(x.value)) }), (e) => ({ noteError: (e as Error).message }));
      return { dryRun: true, token: t, source: "note", ...quote, ...n };
    }
    const n = await this.spendableNote(amount);
    const warnings = this.privacyWarnings(n, amount, (await this.pub.getBlock()).timestamp);
    const note: Note = { value: BigInt(n.value), noteSecret: 0n, label: BigInt(n.label), commitment: BigInt(n.commitment), timestamp: BigInt(n.timestamp!) };
    note.noteSecret = n.spendIndex === 0 ? this.pp.depositNote(n.depositIndex, note.value).noteSecret : this.pp.changeNote(n.depositIndex, n.spendIndex, note.value, note.label).noteSecret;
    const change = this.pp.changeNote(n.depositIndex, n.spendIndex + 1, note.value - amount, note.label);
    const made = await this.makeOrder({ action: w.exactOut ? zk.ACTION.BuyDirectExactOut : zk.ACTION.BuyDirect, token: t, amount, minOut: tokensParam, relay });
    const params = { processor: this.D.privacyPoolAdapter, data: orderData(made.order) };
    const tx = await this.pp.transact(note, change, amount, params);
    const delay = await this.delayFrom(made.signedAt);
    const s = await this.spendNote(n, change, relay.deadline, (accepted) => this.submit("privacyPoolBuy", t, { action: "privacyPoolBuy", ppProof: tx.proof, params, noteData: tx.noteData, proof: made.proof }, accepted));
    return {
      ...MurkFunAgent.orderResult({ ...s, submitDelayMs: delay }), source: "note", ...quote, changeNoteBnb: fmt(change.value), ...(warnings.length ? { privacy: warnings } : {}),
      ...(await this.buyOutcome(t, s, net)),
    };
  }

  /** Spend note `n` through `send` (a relayer order with its retries, valid until `deadline`): the note is `pending`
   *  meanwhile and settled on chain afterwards (it is spent only if its change commitment exists). The 0xbow proof has
   *  left this machine as soon as the order is sent, and anyone holding it can still land it until the order's
   *  deadline, whatever the relayer reported: so the note stays `pending` until its change commitment is on chain
   *  (spent) or the deadline has passed on chain without it (spendable again; settlePendingNotes). A second proof over
   *  the same note before that would only collide with the first. Each order the relayer accepts is recorded on the
   *  note (`spend`). */
  private async spendNote(n: NoteRec, change: Note, deadline: bigint, send: (accepted: (id: string) => void) => Promise<OrderStatus & { attempts?: number }>) {
    n.status = "pending";
    // recorded before anything is sent: until `deadline` the order may land even if no relayer accepted it
    n.spend = { orderId: "", changeCommitment: change.commitment.toString(), changeValue: change.value.toString(), deadline: deadline.toString() };
    this.vault.save();
    const accepted = (orderId: string) => {
      n.spend = { orderId, changeCommitment: change.commitment.toString(), changeValue: change.value.toString(), deadline: deadline.toString() };
    };
    const live = async () => (await this.chainNow()) <= deadline;
    try {
      const s = await send(accepted);
      await this.settleNote(n, change, s.status === "submitted" || await live());
      return s;
    } catch (e) {
      await this.settleNote(n, change, await live().catch(() => true)).catch(() => this.vault.save()); // outcome unknown until the deadline
      throw e;
    }
  }

  /** After a note spend: if the change commitment exists on-chain the spend happened (whoever mined it). Else the note
   *  is spendable again, or stays `pending` with `stillPending` (its order is not final yet). */
  private async settleNote(n: NoteRec, change: { commitment: bigint; value: bigint }, stillPending = false) {
    const ts = await this.pp.commitmentTime(change.commitment);
    if (ts === 0n) {
      if (!stillPending) { n.status = "unspent"; delete n.spend; } // not executed: the note is still spendable
    } else {
      n.status = "spent";
      delete n.spend;
      this.data.notes.push({ depositIndex: n.depositIndex, spendIndex: n.spendIndex + 1, value: change.value.toString(), label: n.label, commitment: change.commitment.toString(), timestamp: ts.toString(), status: "unspent" });
    }
    this.vault.save();
  }

  /** Settle the notes whose order was still unmined when its tool returned: spent once the change commitment is on
   *  chain; spendable again only once the order's deadline has passed on chain without it (whatever the relayer
   *  reports: dropped, reverted, failed or unknown; the proof could still land until then). */
  private async settlePendingNotes() {
    let now: bigint | undefined;
    for (const n of this.data.notes.filter((x) => x.status === "pending" && x.spend)) {
      const sp = n.spend!, change = { commitment: BigInt(sp.changeCommitment), value: BigInt(sp.changeValue) };
      now ??= await this.chainNow();
      const live = !sp.deadline || now <= BigInt(sp.deadline);
      // unknown: wait. An order the relayer does not know (pruned, another relayer URL, never accepted) waits for its deadline
      const st = !sp.orderId ? "not_found" : await this.relayer.status(sp.orderId).then((x) => x.status, () => "not_found");
      // read the commitment after the status: a "mined" status then always finds it
      await this.settleNote(n, change, st === "submitted" || st === "mined" || live);
    }
  }

  private async position(t: Address) {
    const p = this.pseudonym(t);
    const [tb, bb] = await Promise.all([this.tread<bigint>(t, "tokenBalance", [t, p]), this.tread<bigint>(t, "bnbBalance", [t, p])]);
    return { tokens: fmt(tb), bnb: fmt(bb) };
  }

  /** Net BNB a sell of `tokensIn` would credit, on the curve (view) or on the graduated venue (simulated). */
  private async sellQuote(t: Address, graduated: boolean, tokensIn: bigint, relayer: Address): Promise<bigint> {
    if (!graduated) return (await this.tread<bigint[]>(t, "quoteSell", [t, tokensIn]))[0];
    return this.simulateOrder(t, { action: zk.ACTION.Sell, amount: tokensIn, relayer });
  }

  async sell(o: { token: string; amount?: string; percent?: number; slippageBps?: number }) {
    const t = asAddress(o.token, "token");
    const p = this.pseudonym(t);
    const st = await this.tradable(t, true);
    const have = await this.tread<bigint>(t, "tokenBalance", [t, p]);
    if (have === 0n) throw new ToolError("you hold no tokens of this token");
    if (o.percent !== undefined && !(o.percent > 0 && o.percent <= 100)) throw new ToolError("percent must be above 0 and at most 100");
    const tokensIn = o.amount ? parseEther(o.amount) : have * BigInt(Math.round((o.percent ?? 100) * 100)) / 10_000n;
    if (tokensIn < 0n) throw new ToolError("amount must be positive");
    if (tokensIn === 0n) throw new ToolError("BELOW_MINIMUM: amount rounds to 0 tokens");
    if (tokensIn > have) throw new ToolError(`InsufficientBalance: you hold ${fmt(have)} tokens`);
    const { relay } = await this.relayQuote("sell", { token: t });
    const expected = await this.sellQuote(t, st.graduated, tokensIn, relay.relayer);
    checkFeeShare("sell", relay.fee, expected, this.cfg.maxRelayerFeeBps);
    const minOut = expected * (BPS - BigInt(o.slippageBps ?? 300)) / BPS;
    const bal = await this.tread<bigint>(t, "bnbBalance", [t, p]);
    if (bal + minOut < relay.fee) throw new ToolError(`BELOW_MINIMUM: proceeds (${fmt(minOut)} BNB) cannot cover the relayer fee ${fmt(relay.fee)}; sell more`);
    const made = await this.makeOrder({ action: zk.ACTION.Sell, token: t, amount: tokensIn, minOut, relay });
    const s = await this.submitOrder("sell", t, made);
    return { ...MurkFunAgent.orderResult(s), tokensSold: fmt(tokensIn), expectedBnb: fmt(expected), relayerFeeBnb: fmt(relay.fee), balance: await this.position(t) };
  }

  async withdrawBnb(o: { token: string; to: string; amount?: string; confirmContract?: boolean }) {
    const t = asAddress(o.token, "token"), to = asAddress(o.to, "to");
    await this.tokenState(t);
    const dest = await this.checkRecipient(to, { what: "withdraw_bnb to", token: t, confirmContract: o.confirmContract });
    await this.notPaused("withdrawing BNB", await this.marketOf(t));
    const { relay } = await this.relayQuote("withdrawBnb");
    const bal = await this.tread<bigint>(t, "bnbBalance", [t, this.pseudonym(t)]);
    const amount = o.amount ? parseEther(o.amount) : bal - relay.fee;
    if (amount <= 0n) throw new ToolError(`BELOW_MINIMUM: nothing to withdraw (internal balance ${fmt(bal)} BNB, relayer fee ${fmt(relay.fee)})`);
    if (amount + relay.fee > bal) throw new ToolError(`InsufficientBalance: internal balance ${fmt(bal)} BNB cannot cover ${fmt(amount)} + relayer fee ${fmt(relay.fee)}`);
    checkFeeShare("withdrawBnb", relay.fee, amount, this.cfg.maxRelayerFeeBps);
    const made = await this.makeOrder({ action: zk.ACTION.WithdrawBnb, token: t, amount, minOut: 0n, to, relay });
    const s = await this.submitOrder("withdrawBnb", t, made);
    return { ...MurkFunAgent.orderResult(s), to, destination: MurkFunAgent.destinationInfo(dest), amountBnb: fmt(amount), relayerFeeBnb: fmt(relay.fee), balance: await this.position(t) };
  }

  async withdrawToken(o: { token: string; to: string; amount?: string; confirmContract?: boolean }) {
    const t = asAddress(o.token, "token"), to = asAddress(o.to, "to");
    const st = await this.tokenState(t);
    if (!st.graduated) throw new ToolError("NotGraduated: tokens can only be withdrawn after graduation; until then they stay in MurkFun (you can sell them on the curve)");
    const dest = await this.checkRecipient(to, { what: "withdraw_token to", token: t, confirmContract: o.confirmContract });
    await this.notPaused("withdrawing tokens", await this.marketOf(t));
    const p = this.pseudonym(t);
    const [have, bal] = await Promise.all([this.tread<bigint>(t, "tokenBalance", [t, p]), this.tread<bigint>(t, "bnbBalance", [t, p])]);
    if (have === 0n) throw new ToolError("you hold no tokens of this token");
    const { relay } = await this.relayQuote("withdrawTokens", { token: t });
    let maxForFee = 0n;
    if (bal < relay.fee) {
      // tokens needed to raise the fee shortfall, estimated from a simulated probe sale on the venue, x2 for safety
      const probe = have / 100n > 0n ? have / 100n : have;
      const bnbOut = await this.sellQuote(t, true, probe, relay.relayer);
      if (bnbOut === 0n) throw new ToolError("the pool returns 0 BNB for a probe sale; cannot pay the relayer fee from tokens");
      maxForFee = (relay.fee - bal) * probe * 2n / bnbOut + 1n;
    }
    const amount = o.amount ? parseEther(o.amount) : have - maxForFee;
    if (amount <= 0n || amount + maxForFee > have) throw new ToolError(`InsufficientBalance: you hold ${fmt(have)} tokens; up to ${fmt(maxForFee)} may be sold to pay the relayer fee`);
    const made = await this.makeOrder({ action: zk.ACTION.WithdrawTokens, token: t, amount, minOut: maxForFee, to, relay });
    const s = await this.submitOrder("withdrawTokens", t, made);
    return { ...MurkFunAgent.orderResult(s), to, destination: MurkFunAgent.destinationInfo(dest), amountTokens: fmt(amount), maxTokensSoldForFee: fmt(maxForFee), balance: await this.position(t) };
  }

  /** The creator buy on a fresh curve, exact from the token's terms (no slippage): exact in (`bnbAmount` wei, the relayer
   *  fee `relayFee` included) or exact out (`buyTokens`; "cap" = the dev limit). Throws OVER_CAP above the platform's
   *  dev limit `terms.devCap` (MurkFunMarket.capOf for the dev pseudonym), so an oversized buy is refused before
   *  anything is proved or sent. */
  static creatorBuy(terms: CreatorBuyTerms, o: { bnbAmount: bigint; buyTokens?: string }, relayFee: bigint) {
    const cap = terms.devCap;
    const exactOut = !!o.buyTokens;
    let value: bigint, tokenAmount: bigint;
    let buy;
    if (exactOut) {
      tokenAmount = o.buyTokens === "cap" ? cap : parseEther(o.buyTokens!);
      if (tokenAmount <= 0n) throw new ToolError("BELOW_MINIMUM: buyTokens must be > 0");
      buy = freshCurveBuy(terms, tokenAmount, true);
      value = buy.bnbUsed + relayFee; // exactly the cost: the outcome is deterministic
    } else {
      value = o.bnbAmount;
      if (value <= relayFee) throw new ToolError(`BELOW_MINIMUM: bnbAmount ${fmt(value)} must be more than the relayer fee ${fmt(relayFee)} BNB`);
      buy = freshCurveBuy(terms, value - relayFee, false);
      tokenAmount = buy.tokensOut; // minTokensOut = the exact outcome
    }
    if (buy.tokensOut > cap) {
      throw new ToolError(`OVER_CAP: the creator buy (${fmt(buy.tokensOut)} tokens) exceeds the platform's dev limit of ${fmt(cap)} tokens (${bpsOf(cap, terms.totalSupply) / 100}% of supply, the same for every token): buy less, or buyTokens:"cap" for exactly the limit`);
    }
    if (buy.tokensOut === 0n) throw new ToolError("BELOW_MINIMUM: the creator buy rounds to 0 tokens");
    return { exactOut, value, tokenAmount, buy, cap };
  }

  /** Launch a token; its dev pseudonym is this identity's pseudonym for the new token. `vanitySuffix` (optional, any
   *  dev): grind the dev salt until the token address ends with these hex characters. The address (CreateX CREATE3)
   *  commits to name, symbol, metadataURI, dev fee recipient, the terms the token gets and the salt, so the search
   *  runs after every other choice is final.
   *
   *  Creating a token is the dev's first buy: optional creator buy (`bnbAmount` exact in, or `buyTokens` exact out;
   *  "cap" = up to the dev limit), atomic with the creation, so nobody can buy before the dev. The dev pseudonym may hold up to the
   *  platform's dev limit during the curve (Terms.devCap, 30% of supply in the deployed configuration, snapshotted at
   *  listing), the same for every token and not chosen by the dev (not only by the curve). The launch is ONE signed Launch order (the wallet
   *  signs it, nonce 0 of the dev pseudonym): it binds the predicted token address, the dev fee recipient and the
   *  creator buy. While the factory's privacy-funding rule is on, it is paid from a privacy pool like every curve buy:
   *  source=railgun (default) signs a `railgunLaunch` order and returns the Railgun transaction to build (an unshield
   *  to MurkFun's Railgun adapter) with the relay to post (submit_railgun), or with selfSubmit the call to send; nothing
   *  is sent from here. source=note is ONE relayer order `privacyPoolLaunch` (a 0xbow withdrawal through MurkFun's 0xbow
   *  adapter; one relayer fee for launch + buy). The creator buy is the first trade on a fresh curve, so its outcome is computed exactly from
   *  factory.currentTerms() (curve.ts, the port of MurkFunCurve.buy): no slippage. Without a buy, the launch is
   *  relayer-sponsored (`launch`). */
  async createToken(o: {
    name: string; symbol: string; metadataURI: string; devFeeRecipient: string; vanitySuffix?: string;
    bnbAmount?: string; buyTokens?: string; source?: "note" | "railgun"; validMinutes?: number; dryRun?: boolean; confirmContract?: boolean; selfSubmit?: boolean;
  }) {
    const recipient = asAddress(o.devFeeRecipient, "devFeeRecipient");
    const dest = await this.checkRecipient(recipient, { what: "create_token devFeeRecipient", confirmContract: o.confirmContract });
    const bnbIn = o.bnbAmount ? parseEther(o.bnbAmount) : 0n;
    if (bnbIn < 0n) throw new ToolError("bnbAmount must be >= 0");
    if (bnbIn > 0n && o.buyTokens) throw new ToolError("give bnbAmount (BNB to spend) or buyTokens (exactly this many tokens, or \"cap\" = up to the dev limit), not both");
    const withBuy = bnbIn > 0n || !!o.buyTokens;
    // new tokens are listed in the current market: the Launch order goes to its gate
    const market = await this.currentMarket();
    await this.notPaused("launching a token", market);
    const paramsHash = await this.pub.readContract({ address: this.D.factory, abi: factoryAbi, functionName: "tokenParamsHash", args: [o.name, o.symbol, o.metadataURI, recipient] }) as Hex;
    // a one-time launch key: the salt names it, and its signature binds this launch to this wallet's dev pseudonym,
    // so nobody who sees the pending launch can take the address with their own Launch order
    const launchKey = privateKeyToAccount(`0x${crypto.randomBytes(32).toString("hex")}`);
    let salt = launchDevSalt(launchKey.address);
    let vanity: { suffix: string; tries: number } | undefined;
    if (o.vanitySuffix && !o.dryRun) {
      if (!new RegExp(`^(0x)?[0-9a-fA-F]{1,${MAX_VANITY_HEX}}$`).test(o.vanitySuffix)) throw new ToolError(`vanitySuffix: 1-${MAX_VANITY_HEX} hex characters`);
      const g = grindDevSalt(this.D.factory, paramsHash, o.vanitySuffix, launchKey.address);
      salt = g.devSalt;
      vanity = { suffix: o.vanitySuffix.toLowerCase().replace(/^0x/, ""), tries: g.tries };
    }
    const t = await this.pub.readContract({ address: this.D.factory, abi: factoryAbi, functionName: "predictTokenAddress", args: [o.name, o.symbol, o.metadataURI, recipient, salt] }) as Address;
    if (getAddress(t) !== getAddress(predictToken(this.D.factory, paramsHash, salt))) throw new ToolError("internal: local CREATE3 prediction differs from the factory's");
    // the token does not exist yet (no code to see): its own address as the dev fee recipient would strand every fee
    if (getAddress(t) === recipient) throw new ToolError(`bad_recipient: create_token devFeeRecipient ${recipient} is the address of the token this launch creates; its fees would be stuck there. Use an address you control; nothing was signed or sent`);
    const p = this.pseudonym(t);
    // a dry run signs nothing, not even with the one-time launch key
    const launchSig = o.dryRun ? "0x" as Hex : await launchKey.sign({ hash: launchDigest(this.cfg.chainId, this.D.factory, t, p) });
    const spec = { name: o.name, symbol: o.symbol, metadataURI: o.metadataURI, devFeeRecipient: recipient, devSalt: salt, launchSig };
    const source = o.source ?? "railgun";
    const validity = await this.deadlineIn(o.validMinutes ?? (source === "railgun" && withBuy ? RAILGUN_VALID_MINUTES : undefined));

    if (!withBuy) {
      if (o.dryRun) return { dryRun: true, token: "(chosen when sent: the address depends on a random salt)", sponsored: true };
      const made = await this.makeOrder({ action: zk.ACTION.Launch, token: t, amount: 0n, minOut: 0n, to: recipient, relay: { relayer: zeroAddress, fee: 0n, deadline: validity }, nonce: 0n, market });
      const s = await this.submitOrder("launch", t, made, { spec });
      if (s.status === "mined") this.track(t);
      return { ...MurkFunAgent.orderResult(s), token: t, devPseudonym: p.toString(), devFeeRecipient: MurkFunAgent.destinationInfo(dest), ...(vanity ? { vanity } : {}) };
    }

    // ---- creator buy
    // the terms the token gets at listing (its dev limit included): currentTerms() is part of the address commitment
    const terms = await this.pub.readContract({ address: this.D.factory, abi: factoryAbi, functionName: "currentTerms" }) as CreatorBuyTerms;
    // 0xbow: one relayer order; Railgun: the relayer sends the adapter's launch once the unshield is proved (a Railgun
    // proof takes a while: the order is valid for validMinutes), unless selfSubmit
    const action = source === "note" ? "privacyPoolLaunch" : "railgunLaunch";
    const rq = source === "note" || !o.selfSubmit ? await this.relayQuote(action) : undefined;
    const relay: Relay = rq ? (source === "note" ? rq.relay : { ...rq.relay, deadline: validity }) : { relayer: zeroAddress, fee: 0n, deadline: validity };
    const { exactOut, value, tokenAmount, buy, cap } = MurkFunAgent.creatorBuy(terms, { bnbAmount: bnbIn, buyTokens: o.buyTokens }, relay.fee);
    if (rq) checkFeeShare(action, relay.fee, buy.bnbUsed, this.cfg.maxRelayerFeeBps);
    const creatorBuy = {
      exactOut, tokens: fmt(buy.tokensOut), costBnb: fmt(buy.bnbUsed), curveFeeBnb: fmt(buy.fee), paidBnb: fmt(value), devCapTokens: fmt(cap), devCapPct: bpsOf(cap, terms.totalSupply) / 100,
      ...(rq ? MurkFunAgent.feeInfo(rq) : {}),
    };
    if (o.dryRun) return { dryRun: true, source, creatorBuy, ...(rq ? { note: "one relayer fee covers the creation and the buy" } : {}) };
    const made = await this.makeOrder({ action: exactOut ? zk.ACTION.LaunchExactOut : zk.ACTION.Launch, token: t, amount: value, minOut: tokenAmount, to: recipient, relay, nonce: 0n, market });
    const head = { token: t, devPseudonym: p.toString(), devFeeRecipient: MurkFunAgent.destinationInfo(dest), ...(vanity ? { vanity } : {}), source, creatorBuy };

    if (source === "railgun") {
      const adapter = this.railgunAdapter();
      const publicOk = await this.publicFundingAllowed(false, adapter);
      const call = { to: made.gate, value, data: encodeFunctionData({ abi: ordersAbi, functionName: "launch", args: [spec, made.order as never, made.proof] }) };
      await this.simulateAsAdapter(adapter, call);
      const railgun = await this.railgunCall(adapter, made, spec);
      return {
        ...head, deadline: relay.deadline.toString(),
        railgun,
        ...(rq ? { relay: this.railgunRelay("railgunLaunch", t, made, railgun, value - relay.fee, spec) } : {}),
        ...(publicOk ? { call: { to: call.to, value: call.value.toString(), data: call.data } } : { privacyRule: PRIVACY_RULE }),
        howTo: [
          `${RAILGUN_BUILD} ${rq ? RAILGUN_RELAY : RAILGUN_SELF} Here the call is the adapter's launch (railgun.submit.specEncoded is the token spec): it creates the token and makes the creator buy in one transaction.`,
          publicOk
            ? "Any other address can send `call` instead (it carries the BNB); that address is public and links itself to the dev pseudonym; the proofs do not link it to your other pseudonyms (timing, amounts and IP can)."
            : `${PRIVACY_RULE} So there is no plain-wallet version of this call (MurkFun rejects it with PrivacyPoolRequired).`,
          `Valid until ${new Date(Number(relay.deadline) * 1000).toISOString()}. Nothing was sent: the token exists only once this lands; then call token_info {token}. If it went stale, call create_token again (a new salt gives a new address).`,
        ],
      };
    }

    const n = await this.spendableNote(value);
    const warnings = this.privacyWarnings(n, value, (await this.pub.getBlock()).timestamp);
    const note: Note = { value: BigInt(n.value), noteSecret: 0n, label: BigInt(n.label), commitment: BigInt(n.commitment), timestamp: BigInt(n.timestamp!) };
    note.noteSecret = n.spendIndex === 0 ? this.pp.depositNote(n.depositIndex, note.value).noteSecret : this.pp.changeNote(n.depositIndex, n.spendIndex, note.value, note.label).noteSecret;
    const change = this.pp.changeNote(n.depositIndex, n.spendIndex + 1, note.value - value, note.label);
    const params = { processor: this.D.privacyPoolAdapter, data: orderData(made.order) };
    const tx = await this.pp.transact(note, change, value, params);
    const delay = await this.delayFrom(made.signedAt);
    const s = await this.spendNote(n, change, relay.deadline, (accepted) => this.submit("privacyPoolLaunch", t, { action: "privacyPoolLaunch", spec, ppProof: tx.proof, params, noteData: tx.noteData, proof: made.proof }, accepted));
    if (s.status === "mined") this.track(t);
    return {
      ...MurkFunAgent.orderResult({ ...s, submitDelayMs: delay }), ...head, changeNoteBnb: fmt(change.value), ...(warnings.length ? { privacy: warnings } : {}),
      ...(await this.buyOutcome(t, s, value - relay.fee)),
    };
  }

  /** Dev: pay out post-graduation fees via locker.collect (Infinity: the hook's BNB fees; v3 / V2: LP fees) and claim accrued curve fees. */
  async claimLpFees(o: { token: string }) {
    const t = asAddress(o.token, "token");
    const st = await this.tokenState(t);
    const out: Record<string, unknown> = { devFeeRecipient: st.devFeeRecipient };
    // the market's pause stops the curve fee claim; LP fee collection (MurkFunLocker) is outside the market
    const paused = st.devFees > 0n && await this.isPaused(await this.marketOf(t));
    // the relayer sponsors only a claim whose BNB payout covers its gas
    const notYet = (e: unknown) => { if (/nothing_to_claim/.test(String((e as Error).message))) return { nothingToCollect: true }; throw e; };
    if (st.graduated) {
      out.lockerCollect = await this.submit("collectLpFees", t, { action: "collectLpFees", token: t }).then((s) => MurkFunAgent.orderResult(s), notYet);
    }
    if (paused) {
      out.curveFees = { amountBnb: fmt(st.devFees), marketPaused: true,
        note: "MARKET_PAUSED: the curve fees stay accrued for the recipient; claim them again after the guardian unpauses" };
    } else if (st.devFees > 0n) {
      out.curveFees = { amountBnb: fmt(st.devFees), ...await this.submit("claimDevFees", t, { action: "claimDevFees", token: t }).then((s) => MurkFunAgent.orderResult(s), notYet) };
    }
    if (!st.graduated && st.devFees === 0n) out.note = "nothing to claim yet";
    return out;
  }

  async setFeeRecipient(o: { token: string; recipient: string; confirmContract?: boolean }) {
    const t = asAddress(o.token, "token"), recipient = asAddress(o.recipient, "recipient");
    const st = await this.tokenState(t);
    if (st.devPseudonym !== this.pseudonym(t)) throw new ToolError("only the dev pseudonym of this token can change the fee recipient");
    const dest = await this.checkRecipient(recipient, { what: "set_fee_recipient recipient", token: t, confirmContract: o.confirmContract });
    await this.notPaused("changing the fee recipient", await this.marketOf(t));
    const { relay } = await this.relayQuote("setDevRecipient");
    const bal = await this.tread<bigint>(t, "bnbBalance", [t, this.pseudonym(t)]);
    if (bal < relay.fee) throw new ToolError(`internal BNB balance ${fmt(bal)} < relayer fee ${fmt(relay.fee)} (sell a few tokens first)`);
    const made = await this.makeOrder({ action: zk.ACTION.SetDevRecipient, token: t, amount: 0n, minOut: 0n, to: recipient, relay });
    const s = await this.submitOrder("setDevRecipient", t, made);
    return { ...MurkFunAgent.orderResult(s), recipient, destination: MurkFunAgent.destinationInfo(dest) };
  }

  /** A withdrawal / fee-recipient destination, checked before anything is signed: the allowlist (checkDestination),
   *  then recipients.ts: MurkFun's own contracts, MurkFun tokens, WBNB, burn addresses and whatever the contracts' own
   *  rule refuses (MurkFunFactory.isBlockedRecipient, read on chain; the market reverts with BadRecipient) are refused
   *  (`bad_recipient`); any other contract needs `confirmContract` (`recipient_is_contract`). */
  private async checkRecipient(to: Address, o: { what: string; token?: Address; confirmContract?: boolean }): Promise<RecipientCheck> {
    const allow = this.cfg.withdrawAllowlist;
    checkDestination(to, allow, o.what, allow ? undefined : this.walletAddress);
    try {
      const c = await recipientRules(this.pub as never, this.D, to, o);
      return getAddress(to) === getAddress(this.walletAddress) ? { ...c, privacy: OWN_WALLET_PRIVACY } : c;
    } catch (e) {
      throw e instanceof RecipientError ? new ToolError(e.message) : e;
    }
  }

  static destinationInfo(c: RecipientCheck) {
    return { kind: c.kind, ...(c.note ? { note: c.note } : {}), ...(c.privacy ? { privacy: c.privacy } : {}) };
  }

  /** Retry only: the buy that sells out the curve graduates the token itself; this is for when that failed. */
  async graduate(o: { token: string }) {
    const t = asAddress(o.token, "token");
    await this.notPaused("graduation", await this.marketOf(t));
    const s = await this.submit("graduate", t, { action: "graduate", token: t });
    const st = await this.tokenState(t);
    return { ...MurkFunAgent.orderResult(s), graduated: st.graduated, venue: st.venue };
  }

  /** Relay a Railgun-paid order (buy / fund_pseudonym / create_token source=railgun, `relay`) once its Railgun
   *  transactions exist: they are parsed (JSON objects or calldata), checked against the order (adapt contract, adapt
   *  params, WBNB, the adapter as recipient, the gross amount), then the order is posted to the MurkFun relayer and
   *  waited for like any order (the identical order is resubmitted when nothing was sent). `id`: the relay's id (default:
   *  the newest one not yet sent). The relayer sends MurkFunRailgunAdapter's call: the sender on chain is the relayer. */
  async submitRailgun(o: { id?: string; transactions?: unknown; transactionsFile?: string }) {
    const list = this.data.railgunRelays ?? [];
    const rec = o.id ? list.find((r) => r.id === o.id) : [...list].reverse().find((r) => r.status === "pending");
    if (!rec) {
      throw new ToolError(o.id
        ? `RAILGUN_RELAY_UNKNOWN: no Railgun order ${o.id} in this vault (relay.id of buy / fund_pseudonym / create_token with source=railgun)`
        : "RAILGUN_RELAY_NONE: no Railgun order is waiting: call buy, fund_pseudonym or create_token with source=railgun first, build its Railgun transaction, then submit_railgun");
    }
    if (rec.status === "submitted" && rec.orderId) {
      // the last wait ended while the order was pending: what became of it decides whether it may be sent again
      const s = await this.relayer.status(rec.orderId).catch(() => undefined);
      if (s) this.noteOrderStatus(rec.orderId, s.status);
    }
    if (!RAILGUN_RESUBMITTABLE.has(rec.status)) {
      throw new ToolError(rec.status === "mined"
        ? `RAILGUN_RELAY_SENT: this Railgun order was already executed (order ${rec.orderId}, mined); a new buy needs a new order`
        : `RAILGUN_RELAY_SENT: this Railgun order was accepted by the relayer and its outcome is not known yet (order ${rec.orderId}, ${rec.status}): check order_status {id: "${rec.orderId}"}. ` +
          "Once it reports dropped or reverted (not executed: the Railgun notes are unspent), submit_railgun takes the same order and transactions again; mined means done");
    }
    if (BigInt(rec.deadline) <= await this.chainNow()) {
      throw new ToolError("RAILGUN_ORDER_EXPIRED: this Railgun order's deadline has passed; nothing was sent and the Railgun notes are unspent. Call the tool again for a new order (and a new Railgun transaction: the adapt params change with the order)");
    }
    if ((o.transactions === undefined) === (o.transactionsFile === undefined)) throw new ToolError("give transactions (JSON or calldata) or transactionsFile (a file holding them), not both");
    let txs;
    try {
      txs = parseRailgunTxs(o.transactionsFile !== undefined ? readRailgunTxFile(o.transactionsFile) : o.transactions);
      checkRailgunTxs(txs, { adapter: rec.adapter, adaptParams: rec.adaptParams, wbnb: rec.wbnb, grossWei: BigInt(rec.grossWei) });
    } catch (e) {
      if (e instanceof RailgunTxError) throw new ToolError(`RAILGUN_TX_INVALID: ${e.message}; nothing was sent`);
      throw e;
    }
    const t = getAddress(rec.token);
    const s = await this.submit(rec.action, t, { ...rec.body, transactions: txs }, (id) => {
      rec.orderId = id;
      rec.status = "submitted";
    });
    rec.status = s.status;
    this.vault.save();
    if (s.status === "mined") this.track(t);
    return {
      ...MurkFunAgent.orderResult(s), action: rec.action, token: t, sender: "the MurkFun relayer (the transaction's sender is the shared relayer, not a wallet of yours)",
      ...(rec.action === "railgunBuy" ? await this.buyOutcome(t, s, BigInt(rec.offeredWei)) : {}),
      ...(s.status === "mined" && rec.action !== "railgunLaunch" ? { balance: await this.position(t) } : {}),
    };
  }

  async orderStatus(o: { id: string }) {
    const s = await this.relayer.status(o.id);
    this.noteOrderStatus(o.id, s.status);
    if (this.data.notes.some((n) => n.spend?.orderId === o.id)) await this.settlePendingNotes();
    return s;
  }

  /** A relayer order's status as the relayer reports it, kept in the vault: the order record and the Railgun relay
   *  record it was sent for (a submission whose wait ran out must not stay `submitted` there: a later `dropped`
   *  lets submit_railgun send it again). */
  private noteOrderStatus(id: string, status: string) {
    let changed = false;
    for (const r of [...this.data.orders.filter((x) => x.id === id), ...(this.data.railgunRelays ?? []).filter((x) => x.orderId === id)]) {
      if (r.status !== status) { r.status = status; changed = true; }
    }
    if (changed) this.vault.save();
  }

  async backup(o: { path: string; confirm?: boolean }) {
    this.data;
    // never over an existing file unless confirmed (a path from injected text could name ~/.bashrc)
    if (fs.existsSync(path.resolve(o.path)) && !o.confirm) throw new ToolError(`${Vault.shown(o.path)} already exists; choose a new path (or pass confirm=true to replace that file)`);
    this.vault.backup(o.path);
    return { written: Vault.shown(o.path), encrypted: true, note: "Decrypts only with the same MURKFUN_PASSPHRASE. Keep the passphrase separately." };
  }

  async restore(o: { path: string; confirm?: boolean }) {
    // a backup of another wallet would replace this one (its local key with it): only with confirm
    const walletOf = (d: VaultData) => (d.eoaKey ? privateKeyToAccount(d.eoaKey).address : d.account);
    const other = walletOf(this.vault.peek(o.path));
    // restoring into a wiped (or never set up) home: there is no current wallet to compare with
    const cur = this.vault.exists() ? walletOf(this.data) : undefined;
    if (cur && other && cur.toLowerCase() !== other.toLowerCase() && !o.confirm) {
      throw new ToolError(`the backup is of wallet ${other}, not the current ${cur}: restoring it replaces the current vault (back it up first). Pass confirm=true to restore anyway`);
    }
    this.vault.restore(o.path);
    this.forget();
    return { restored: true, wallet: this.walletAddress };
  }

  /** The wallet key written to a local file (mode 0600) for offline backup (only when the key is held here; the
   *  pseudonyms and 0xbow notes are re-derived by signing the seed message again). Not returned to the agent: tool
   *  outputs go to the model provider, the file stays on this machine. */
  async exportRecovery(o: { path: string; confirm: boolean }) {
    if (!o.confirm) throw new ToolError("pass confirm=true: the file will contain a plaintext secret (the wallet key)");
    if (this.isBaw) {
      throw new ToolError("nothing to export: your Binance Agentic Wallet IS the backup (it has no exportable key); the pseudonyms and notes come back by signing again (recover_from_wallet {signer:\"baw\"}). Keep the Binance account safe.");
    }
    const dest = path.resolve(o.path);
    // the plaintext key goes only where the user allowed it: MURKFUN_HOME, or MURKFUN_EXPORT_DIR (set by the user)
    const dirs = [this.cfg.home, this.cfg.exportDir].filter((d): d is string => !!d).map((d) => path.resolve(d));
    if (!dirs.some((d) => dest.startsWith(d + path.sep))) {
      throw new ToolError(`export_recovery writes only inside ${dirs.map((d) => Vault.shown(d)).join(" or ")} (MURKFUN_HOME${this.cfg.exportDir ? ", MURKFUN_EXPORT_DIR" : "; the user can allow one more directory, e.g. a USB stick, with MURKFUN_EXPORT_DIR"}); nothing was written`);
    }
    if (fs.existsSync(dest)) throw new ToolError(`${Vault.shown(dest)} already exists; choose a new path`);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const body = {
      format: "murkfun-recovery",
      warning: "PLAINTEXT WALLET KEY. Your MurkFun pseudonyms and 0xbow notes come from this wallet's signature, and every MurkFun order needs its signature: anyone holding this key controls your MurkFun funds and can link all your pseudonyms. Store offline (USB stick / paper / password manager) and delete this file from the computer.",
      wallet: this.walletAddress, walletKey: this.data.eoaKey,
      deposits: this.data.deposits.map((d) => ({ index: d.index, valueWei: d.value })),
      tokens: this.data.tokens,
    };
    fs.writeFileSync(dest, JSON.stringify(body, null, 1), { mode: 0o600, flag: "wx" });
    return {
      written: Vault.shown(dest), deposits: body.deposits.length,
      note: "The plaintext wallet key was written to this file only (not shown here). Ask the user to move it offline and delete it from this machine. Never read it back into the conversation, upload it or paste it anywhere. Deposits and notes are found on-chain again from the wallet alone (recover_from_wallet).",
    };
  }

  /** Tokens (newest first) where this identity's pseudonym holds tokens or BNB inside MurkFun, by checking every MurkFun
   *  token on chain (pseudonyms are derived from the seed, so no backup is needed for them). */
  private async allTokens(): Promise<Address[]> {
    const n = Number(await this.pub.readContract({ address: this.D.factory, abi: factoryAbi, functionName: "tokenCount" }));
    return Promise.all(Array.from({ length: n }, (_, i) => this.pub.readContract({ address: this.D.factory, abi: factoryAbi, functionName: "allTokens", args: [BigInt(n - 1 - i)] }).then((a) => getAddress(a as Address))));
  }

  private async discoverPositions(tokens: Address[]): Promise<Address[]> {
    const held = await Promise.all(tokens.map(async (t) => {
      const p = this.pseudonym(t);
      const [tb, bb] = await Promise.all([this.tread<bigint>(t, "tokenBalance", [t, p]), this.tread<bigint>(t, "bnbBalance", [t, p])]);
      return tb > 0n || bb > 0n ? t : undefined;
    }));
    return held.filter((t): t is Address => !!t);
  }

  /** Logs of `event` (or several events) from `from` to the head, in chain order, in MURKFUN_LOG_CHUNK windows, from the
   *  log endpoint (logClient). */
  private async logsChunked(address: Address | Address[], event: any, args: Record<string, unknown> | undefined, from: bigint) {
    const pub = await this.logClient();
    const latest = await pub.getBlockNumber();
    const out: any[] = [];
    for (let a = from; a <= latest; a += BigInt(this.cfg.logChunk)) {
      const b = a + BigInt(this.cfg.logChunk) - 1n > latest ? latest : a + BigInt(this.cfg.logChunk) - 1n;
      const sel = Array.isArray(event) ? { events: event } : { event };
      out.push(...(await pub.getLogs({ address, ...sel, ...(args ? { args } : {}), fromBlock: a, toBlock: b } as never) as any[]));
    }
    return out.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
  }

  /** This seed's 0xbow deposits, found from the pool's public Deposited events since the MurkFun deployment (a
   *  deposit made before it needs recover {deposits}) by recomputing each candidate commitment locally. */
  private async discoverDeposits() {
    const ev = vaultAbi.find((x: any) => x.name === "Deposited") as any;
    const logs = await this.logsChunked(PV, ev, { asset: getAddress(`0x${NATIVE.toString(16)}`) }, BigInt(this.D.deployBlock));
    const maxIndex = Math.max(this.cfg.maxDepositIndex, this.data.deposits.length + 1);
    let found = 0;
    for (const l of logs) {
      const c = BigInt(l.args.outputCommitment), v = BigInt(l.args.depositedValue);
      if (this.data.deposits.some((d) => BigInt(d.commitment) === c)) continue;
      const i = this.pp.matchDeposit(c, v, maxIndex);
      if (i < 0 || this.data.deposits.some((d) => d.index === i)) continue;
      const n = this.pp.depositNote(i, v);
      this.data.deposits.push({ index: i, value: v.toString(), label: n.label.toString(), commitment: n.commitment.toString(), txHash: l.transactionHash, createdAt: Date.now() });
      found++;
    }
    this.data.deposits.sort((x, y) => x.index - y.index);
    return found;
  }

  /** Amounts of this identity's 0xbow buys and creator buys (PrivacyPoolFunded of its pseudonyms, emitted by MurkFun's
   *  0xbow adapter; every privacy funder the factory ever allowlisted is scanned (PrivacyFunderSet), so an adapter
   *  added later, or removed since, is found too), oldest first: each one is a spend of some note, so the change notes
   *  can be found by trying previous value - amount. */
  private async ownPrivacySpends(tokens: Address[]): Promise<bigint[]> {
    const mine = new Set(tokens.map((t) => this.pseudonym(t)));
    const ev = (privacyPoolAdapterAbi as unknown as any[]).find((x) => x.type === "event" && x.name === "PrivacyPoolFunded");
    const setEv = (factoryAbi as unknown as any[]).find((x) => x.type === "event" && x.name === "PrivacyFunderSet");
    const [funders, everSet] = await Promise.all([
      this.pub.readContract({ address: this.D.factory, abi: factoryAbi, functionName: "privacyFunders" }) as Promise<Address[]>,
      this.logsChunked(this.D.factory, setEv, undefined, BigInt(this.D.deployBlock)),
    ]);
    const sources = [...new Set([getAddress(this.D.privacyPoolAdapter), ...funders.map((a) => getAddress(a)),
      ...everSet.filter((l) => l.args.allowed).map((l) => getAddress(l.args.funder))])];
    const logs = await this.logsChunked(sources, ev, undefined, BigInt(this.D.deployBlock));
    return logs.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1))
      .filter((l) => mine.has(BigInt(l.args.pseudonym))).map((l) => BigInt(l.args.amount));
  }

  /** Rebuild deposits and notes from the seed alone (deposits from the pool's events, change notes from this
   *  identity's buy amounts, each checked on-chain) and find the tokens where this identity has a position. */
  async recover(o: { deposits?: { index: number; valueBnb: string }[] } = {}) {
    for (const d of o.deposits ?? []) {
      if (!this.data.deposits.find((x) => x.index === d.index)) {
        const v = parseEther(d.valueBnb), n = this.pp.depositNote(d.index, v);
        this.data.deposits.push({ index: d.index, value: v.toString(), label: n.label.toString(), commitment: n.commitment.toString(), createdAt: Date.now() });
      }
    }
    const depositsFound = await this.discoverDeposits();
    const tokens = await this.allTokens();
    const spends = await this.ownPrivacySpends(tokens);
    const used = new Set<number>();
    const notes: NoteRec[] = [];
    for (const d of this.data.deposits) {
      const v0 = BigInt(d.value), n0 = this.pp.depositNote(d.index, v0);
      let ts = await this.pp.commitmentTime(n0.commitment);
      if (ts === 0n) continue;
      d.timestamp ??= ts.toString();
      let cur: NoteRec = { depositIndex: d.index, spendIndex: 0, value: v0.toString(), label: n0.label.toString(), commitment: n0.commitment.toString(), timestamp: ts.toString(), status: "unspent" };
      for (let k = 1; BigInt(cur.value) > 0n; k++) {
        let next: NoteRec | undefined;
        for (const [j, a] of spends.entries()) {
          if (used.has(j) || a > BigInt(cur.value)) continue;
          const c = this.pp.changeNote(d.index, k, BigInt(cur.value) - a, n0.label);
          ts = await this.pp.commitmentTime(c.commitment);
          if (ts === 0n) continue;
          used.add(j);
          next = { depositIndex: d.index, spendIndex: k, value: c.value.toString(), label: n0.label.toString(), commitment: c.commitment.toString(), timestamp: ts.toString(), status: "unspent" };
          break;
        }
        if (!next) break;
        cur.status = "spent";
        notes.push(cur);
        cur = next;
      }
      notes.push(cur);
    }
    this.data.notes = notes;
    const positions = await this.discoverPositions(tokens);
    for (const t of positions) if (!this.data.tokens.includes(t)) this.data.tokens.push(t);
    this.vault.save();
    return {
      depositsFound,
      notes: notes.filter((n) => n.status === "unspent").map((n) => ({ depositIndex: n.depositIndex, spendIndex: n.spendIndex, valueBnb: fmt(BigInt(n.value)) })),
      positionsFound: positions,
    };
  }

  /** Recovery on a new machine: the same wallet signs the same seed message again, which gives the same pseudonyms
   *  and 0xbow notes. Creates the vault when there is none. */
  async recoverFromWallet(o: { walletKeyFile?: string; signer?: "local" | "baw" } = {}) {
    if (!this.cfg.passphrase) throw new ToolError("set MURKFUN_PASSPHRASE (or MURKFUN_PASSPHRASE_FILE) in the MCP server environment first");
    let created = false;
    if (!this.vault.exists()) {
      if (this.cfg.passphrase.length < 12) throw new ToolError("MURKFUN_PASSPHRASE is too short: use at least 12 characters (a long random phrase)");
      const baw = (o.signer ?? (o.walletKeyFile ? "local" : this.cfg.signer)) === "baw";
      if (!o.walletKeyFile && !baw) throw new ToolError("pass walletKeyFile (a file holding the wallet's private key) or signer=\"baw\" (the Binance Agentic Wallet)");
      this.vault.create(await this.walletSource(o));
      created = true;
    } else {
      this.data;
      if (o.walletKeyFile || o.signer) throw new ToolError(`a vault already exists at ${Vault.shown(this.vault.file)}; refusing to replace its wallet (move it away first)`);
    }
    try {
      await this.ensureSeedSig();
    } catch (e) {
      if (created) { fs.rmSync(this.vault.file, { force: true }); this.vault.data = undefined as never; }
      throw e;
    }
    const r = await this.recover();
    return { created, wallet: this.walletAddress, holderSet: await this.holderStatus(), ...r, next: "Same pseudonyms as before: status shows the notes and positions." };
  }
}

export { PV, vaultAbi };
