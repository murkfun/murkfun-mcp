// Destinations of withdrawals, launches and fee recipients (withdraw_bnb, withdraw_token, set_fee_recipient,
// create_token devFeeRecipient), checked before the wallet signs anything. The contracts refuse what
// MurkFunFactory.isBlockedRecipient names (the zero address, WBNB, the factory, a MurkFun token, an allowlisted privacy
// funder, any MurkFun contract in the factory's registry, isMurkFunContract; BadRecipient); every other address is accepted on chain,
// including ones where the BNB or tokens are lost for good. So the MCP reads that view AND refuses every MurkFun
// contract it can name, every MurkFun token, WBNB, Railgun's RelayAdapt and burn / system addresses
// (`bad_recipient`), and asks for an explicit confirmation before sending to any other contract
// (`recipient_is_contract`): only a contract that can move BNB / tokens itself (a Safe or another smart wallet) can use
// them. MurkFun's relayer refuses the same MurkFun destinations again before it sends an order (bad_recipient,
// docs/RELAYER_API.md).
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { marketAbi, factoryAbi, ordersAbi, dexAbi } from "./abi.js";
import { WBNB } from "./murkfun.js";
import type { Deployment } from "./config.js";

/** The chain reads the check needs (a viem PublicClient). */
export interface RecipientReader {
  readContract(a: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  getCode(a: { address: Address }): Promise<Hex | undefined>;
}

/** Railgun's RelayAdapt on BSC: anyone can take what is left in it. */
export const RELAY_ADAPT: Address = "0xF82d00fC51F730F42A00F85E74895a2849ffF2Dd";
/** Burn addresses: whatever is sent there is gone. */
export const BURN_ADDRESSES: Record<string, string> = {
  "0x000000000000000000000000000000000000dEaD": "a burn address (0x…dEaD)",
};
/** Addresses up to 0xffff are precompiles and system contracts, never a wallet. */
const SYSTEM_MAX = 0xffffn;

export type RecipientKind = "wallet" | "contract";
export interface RecipientCheck { to: Address; kind: RecipientKind; note?: string; privacy?: string }

export class RecipientError extends Error {
  constructor(public code: "bad_recipient" | "recipient_is_contract", message: string) { super(`${code}: ${message}`); }
}

/** An EIP-7702 delegated account (code = 0xef0100 || delegate): a key-controlled wallet, not a contract. */
export const isDelegatedEoa = (code: Hex | undefined) => !!code && /^0xef0100[0-9a-fA-F]{40}$/.test(code);

/** Every MurkFun contract a destination must never be, with a label: the deployment's addresses, the factory's current
 *  market, the token's own market, each of these markets' WBNB, Dex, order gate and locker, each Dex's locker and
 *  Infinity hook, each gate's holder set, the token's own Dex (after graduation), every privacy funder the factory
 *  allowlists (MurkFun's 0xbow and Railgun adapters), Railgun's RelayAdapt. A getter that fails to answer is skipped: everything here
 *  is a contract, so a missed entry is still caught by the contract confirmation. */
export async function protocolSinks(pub: RecipientReader, d: Deployment, token?: Address): Promise<Map<Address, string>> {
  const sinks = new Map<Address, string>();
  const add = (a: unknown, label: string) => {
    if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a) || BigInt(a) === 0n) return;
    const k = getAddress(a);
    if (!sinks.has(k)) sinks.set(k, label);
  };
  const read = (address: Address, abi: readonly unknown[], functionName: string, args?: readonly unknown[]) =>
    pub.readContract({ address, abi, functionName, ...(args ? { args } : {}) }).catch(() => undefined);
  add(WBNB, "WBNB");
  add(d.factory, "the MurkFun factory");
  add(d.market, "a MurkFun market");
  add(d.orders, "a MurkFun order gate");
  add(d.holderRoots, "MurkFun's holder set (HolderRoots)");
  add(d.locker, "a MurkFun LP locker");
  add(d.privacyPoolAdapter, "MurkFun's 0xbow adapter");
  add(d.railgunAdapter, "MurkFun's Railgun adapter");
  add(RELAY_ADAPT, "Railgun's RelayAdapt (anyone can take what is left in it)");
  const [current, tokenMarket, funders] = await Promise.all([
    read(d.factory, factoryAbi, "market"),
    token ? read(d.factory, factoryAbi, "marketOf", [token]) : undefined,
    read(d.factory, factoryAbi, "privacyFunders"),
  ]);
  for (const f of (Array.isArray(funders) ? funders : [])) add(f, "a MurkFun privacy funder (the 0xbow / Railgun adapter)");
  const markets = [...new Set([d.market, current, tokenMarket].filter((m): m is Address => typeof m === "string" && BigInt(m) !== 0n).map((m) => getAddress(m)))];
  for (const m of markets) add(m, "a MurkFun market");
  const perMarket = await Promise.all(markets.map(async (m) => {
    const [wbnb, dex, orders, locker, tokenDex] = await Promise.all([
      read(m, marketAbi, "WBNB"), read(m, marketAbi, "dex"), read(m, marketAbi, "orders"), read(m, marketAbi, "locker"),
      token && tokenMarket && getAddress(tokenMarket as Address) === m ? read(m, marketAbi, "dexOf", [token]) : undefined,
    ]);
    add(wbnb, "WBNB");
    add(orders, "a MurkFun order gate");
    add(locker, "a MurkFun LP locker");
    return { dexes: [dex, tokenDex].filter((x): x is Address => typeof x === "string" && BigInt(x) !== 0n), orders: orders as Address | undefined };
  }));
  const dexes = [...new Set(perMarket.flatMap((x) => x.dexes).map((x) => getAddress(x)))];
  const gates = [...new Set([d.orders, ...perMarket.map((x) => x.orders)].filter((x): x is Address => typeof x === "string" && BigInt(x) !== 0n).map((x) => getAddress(x)))];
  await Promise.all([
    ...dexes.map(async (x) => {
      add(x, "a MurkFun Dex");
      const [locker, hook] = await Promise.all([read(x, dexAbi, "locker"), read(x, dexAbi, "hook")]);
      add(locker, "a MurkFun LP locker");
      add(hook, "MurkFun's Infinity hook");
    }),
    ...gates.map(async (g) => add(await read(g, ordersAbi, "HOLDER_ROOTS"), "MurkFun's holder set (HolderRoots)")),
  ]);
  return sinks;
}

/** Refuse a destination where the funds would be lost or stuck (the off-chain rules here, then the contracts' own rule
 *  MurkFunFactory.isBlockedRecipient, which must answer), and ask for `confirmContract` before any other
 *  contract. `token`: the token of the order (a withdrawal to it, or fees paid to it, are stuck in it); `launchToken`:
 *  the address a launch will create (not deployed yet, so it has no code to see). `what` names the tool argument. */
export async function checkRecipient(
  pub: RecipientReader, d: Deployment, to: Address,
  o: { what: string; token?: Address; launchToken?: Address; confirmContract?: boolean },
): Promise<RecipientCheck> {
  to = getAddress(to);
  const refuse = (label: string) => {
    throw new RecipientError("bad_recipient", `${o.what} ${to} is ${label}. BNB or tokens sent there are lost or stuck where only MurkFun's owner could sweep them (the MurkFun contracts refuse some of these with BadRecipient and accept the rest), so the MCP refuses it. Use an address you control; nothing was signed or sent`);
  };
  if (to === zeroAddress) refuse("the zero address");
  if (BURN_ADDRESSES[to]) refuse(BURN_ADDRESSES[to]);
  if (BigInt(to) <= SYSTEM_MAX) refuse("a precompile / system address");
  if (o.token && to === getAddress(o.token)) refuse("this token's own contract");
  if (o.launchToken && to === getAddress(o.launchToken)) refuse("the address of the token this launch creates");
  const [sinks, marketOfTo, blocked, code] = await Promise.all([
    protocolSinks(pub, d, o.token),
    pub.readContract({ address: d.factory, abi: factoryAbi, functionName: "marketOf", args: [to] }) as Promise<Address>,
    pub.readContract({ address: d.factory, abi: factoryAbi, functionName: "isBlockedRecipient", args: [to] }) as Promise<boolean>,
    pub.getCode({ address: to }),
  ]);
  const sink = sinks.get(to);
  if (sink) refuse(sink);
  if (BigInt(marketOfTo) !== 0n) refuse("a MurkFun token contract");
  if (blocked) refuse("a destination the MurkFun contracts refuse (MurkFunFactory.isBlockedRecipient: a MurkFun contract or token, a privacy funder or WBNB; the order would revert with BadRecipient)");
  if (!code || code === "0x") return { to, kind: "wallet" };
  if (isDelegatedEoa(code)) return { to, kind: "wallet", note: "an EIP-7702 delegated wallet (its key controls it)" };
  if (!o.confirmContract) {
    throw new RecipientError("recipient_is_contract", `${o.what} ${to} is a contract, not a plain wallet address. BNB or tokens sent to a contract can be used only if that contract can move them (a Safe or another smart wallet can; a token, a pool or a router cannot, and the MurkFun contracts do not refuse it). Ask the user whether this contract is theirs and can receive BNB / tokens (a withdrawal of BNB arrives as WBNB if the contract rejects plain BNB); if they confirm, call again with confirmContract: true; nothing was signed or sent`);
  }
  return { to, kind: "contract", note: "a contract, confirmed by confirmContract" };
}
