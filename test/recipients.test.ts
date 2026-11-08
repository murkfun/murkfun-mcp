// Destination checks of withdraw_bnb / withdraw_token / set_fee_recipient / create_token (src/recipients.ts) against a
// fake chain: every MurkFun contract, every MurkFun token, WBNB, Railgun's RelayAdapt, burn addresses and what
// MurkFunFactory.isBlockedRecipient names are refused
// before anything is signed; any other contract needs confirmContract; a plain wallet (or an EIP-7702 delegated one)
// passes. The tools run the check before the wallet signs (no signer is set up here: a refusal that came later would
// fail differently).
import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, type Address, type Hex } from "viem";
import { checkRecipient, protocolSinks, isDelegatedEoa, RELAY_ADAPT, type RecipientReader } from "../src/recipients.js";
import { MurkFunAgent } from "../src/agent.js";
import { WBNB } from "../src/murkfun.js";

/** A fake contract / wallet address (well above the precompile range); `Z(n)` = the plain number as an address. */
const A = (n: number) => getAddress(`0x77${n.toString(16).padStart(38, "0")}`) as Address;
const Z = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const D = {
  market: A(0xa001), factory: A(0xf001), orders: A(0xa002), holderRoots: A(0xa003), locker: A(0xa004),
  privacyPoolAdapter: A(0xa005), railgunAdapter: A(0xa006), deployBlock: 1,
};
// the chain: a re-pointed current market with its own gate / Dex; the token's Dex, locker and hook; a second token
const CUR = A(0xb001), CUR_ORDERS = A(0xb002), CUR_DEX = A(0xb003), CUR_LOCKER = A(0xb004), CUR_HOOK = A(0xb005), CUR_ROOTS = A(0xb006);
const OLD_DEX = A(0xc001), OLD_LOCKER = A(0xc002), OLD_HOOK = A(0xc003), TOKEN_DEX = A(0xc004), TOKEN_DEX_LOCKER = A(0xc005);
const TOKEN = A(0xd001), OTHER_TOKEN = A(0xd002), FUNDER = A(0xe001);
const SAFE = A(0x5afe0001), WALLET = A(0x1234567), DELEGATED = A(0x7702);
// a contract only the factory's own rule names (its FACTORY() is the factory): no getter here reaches it
const ONCHAIN_BLOCKED = A(0xe002);
const view: Record<string, unknown> = {
  [`${D.factory}.market`]: CUR, [`${D.factory}.privacyFunders`]: [D.privacyPoolAdapter, FUNDER],
  [`${D.factory}.marketOf.${TOKEN}`]: D.market, [`${D.factory}.marketOf.${OTHER_TOKEN}`]: CUR,
  [`${D.market}.WBNB`]: WBNB, [`${D.market}.dex`]: OLD_DEX, [`${D.market}.orders`]: D.orders, [`${D.market}.locker`]: OLD_LOCKER,
  [`${D.market}.dexOf.${TOKEN}`]: TOKEN_DEX,
  [`${CUR}.WBNB`]: WBNB, [`${CUR}.dex`]: CUR_DEX, [`${CUR}.orders`]: CUR_ORDERS, [`${CUR}.locker`]: CUR_LOCKER,
  [`${OLD_DEX}.locker`]: OLD_LOCKER, [`${OLD_DEX}.hook`]: OLD_HOOK, [`${CUR_DEX}.locker`]: CUR_LOCKER, [`${CUR_DEX}.hook`]: CUR_HOOK,
  [`${TOKEN_DEX}.locker`]: TOKEN_DEX_LOCKER, [`${TOKEN_DEX}.hook`]: OLD_HOOK,
  [`${D.orders}.HOLDER_ROOTS`]: D.holderRoots, [`${CUR_ORDERS}.HOLDER_ROOTS`]: CUR_ROOTS,
  [`${D.factory}.isBlockedRecipient.${ONCHAIN_BLOCKED}`]: true,
};
const CONTRACTS = new Set<string>([...Object.values(D).filter((x) => typeof x === "string"), CUR, CUR_ORDERS, CUR_DEX, CUR_LOCKER, CUR_HOOK, CUR_ROOTS,
  OLD_DEX, OLD_LOCKER, OLD_HOOK, TOKEN_DEX, TOKEN_DEX_LOCKER, TOKEN, OTHER_TOKEN, FUNDER, SAFE, WBNB, RELAY_ADAPT, ONCHAIN_BLOCKED] as string[]);
const reader = (over: Partial<RecipientReader> = {}): RecipientReader => ({
  readContract: async ({ address, functionName, args }) => {
    const k = [getAddress(address), functionName, ...(args ?? []).map((a) => getAddress(a as Address))].join(".");
    if (k in view) return view[k];
    if (functionName === "marketOf" || functionName === "dexOf") return Z(0);
    if (functionName === "isBlockedRecipient") return false;
    throw new Error(`execution reverted (${k})`);
  },
  getCode: async ({ address }) => (getAddress(address) === DELEGATED ? `0xef0100${"11".repeat(20)}` as Hex : CONTRACTS.has(getAddress(address)) ? "0x6080" as Hex : undefined),
  ...over,
});

test("recipients: every MurkFun contract the chain names is a sink, the re-pointed ones and the token's own Dex included", async () => {
  const sinks = await protocolSinks(reader(), D, TOKEN);
  for (const a of [D.market, D.factory, D.orders, D.holderRoots, D.locker, D.privacyPoolAdapter, D.railgunAdapter, RELAY_ADAPT, WBNB, FUNDER,
    CUR, CUR_ORDERS, CUR_DEX, CUR_LOCKER, CUR_HOOK, CUR_ROOTS, OLD_DEX, OLD_LOCKER, OLD_HOOK, TOKEN_DEX, TOKEN_DEX_LOCKER]) {
    assert.ok(sinks.has(a), `${a} is a sink`);
  }
  assert.ok(!sinks.has(SAFE) && !sinks.has(WALLET));
  // a getter that fails is skipped, the rest still counts
  const partial = await protocolSinks(reader({ readContract: async ({ address, functionName }) => {
    if (functionName === "market") throw new Error("rpc down");
    return reader().readContract({ address, abi: [], functionName });
  } }), D);
  assert.ok(partial.has(D.market) && partial.has(OLD_DEX) && !partial.has(CUR));
});

test("recipients: MurkFun contracts, MurkFun tokens, WBNB, RelayAdapt, the token itself, burn and system addresses are refused (bad_recipient)", async () => {
  const pub = reader();
  const refused = async (to: Address, o: { token?: Address; launchToken?: Address } = {}, re = /bad_recipient/) =>
    assert.rejects(checkRecipient(pub, D, to, { what: "withdraw_bnb to", confirmContract: true, ...o }), re, to);
  for (const to of [D.market, D.factory, D.orders, D.holderRoots, D.locker, D.privacyPoolAdapter, D.railgunAdapter, WBNB, RELAY_ADAPT, CUR, CUR_ORDERS,
    CUR_DEX, CUR_LOCKER, CUR_HOOK, CUR_ROOTS, OLD_HOOK, FUNDER]) await refused(to);
  await refused(TOKEN_DEX, { token: TOKEN });
  await refused(TOKEN, { token: TOKEN }, /this token's own contract/);
  await refused(OTHER_TOKEN, { token: TOKEN }, /a MurkFun token contract/);
  await refused(TOKEN, {}, /a MurkFun token contract/);
  await refused(A(0xd0d0), { launchToken: A(0xd0d0) }, /the token this launch creates/);
  await refused(getAddress("0x000000000000000000000000000000000000dead"), {}, /burn address/);
  await refused(Z(0), {}, /zero address/);
  await refused(Z(1), {}, /precompile/);
  await refused(Z(0xffff), {}, /precompile/);
  await refused(ONCHAIN_BLOCKED, {}, /isBlockedRecipient/);
  // confirmContract never overrides a refusal
  await assert.rejects(checkRecipient(pub, D, WBNB, { what: "x", confirmContract: true }), /bad_recipient: x 0xbb4C.* is WBNB/);
});

test("recipients: another contract needs confirmContract; a plain or EIP-7702 delegated wallet passes", async () => {
  const pub = reader();
  await assert.rejects(checkRecipient(pub, D, SAFE, { what: "set_fee_recipient recipient", token: TOKEN }), /recipient_is_contract: .*confirmContract: true; nothing was signed or sent/);
  assert.deepEqual(await checkRecipient(pub, D, SAFE, { what: "x", token: TOKEN, confirmContract: true }), { to: SAFE, kind: "contract", note: "a contract, confirmed by confirmContract" });
  assert.deepEqual(await checkRecipient(pub, D, WALLET, { what: "x", token: TOKEN }), { to: WALLET, kind: "wallet" });
  assert.equal((await checkRecipient(pub, D, DELEGATED, { what: "x" })).kind, "wallet");
  assert.ok(isDelegatedEoa(`0xef0100${"ab".repeat(20)}`) && !isDelegatedEoa("0x6080") && !isDelegatedEoa(undefined));
  // the MurkFun-token check must answer: an RPC failure there refuses the call instead of skipping the check
  await assert.rejects(checkRecipient(reader({ readContract: async () => { throw new Error("rpc down"); } }), D, WALLET, { what: "x" }), /rpc down/);
});

/** An agent on the fake chain with every step after the destination check failing loudly, so a passing check is
 *  visible as that failure and nothing could be signed. */
function agentOn(pub: RecipientReader) {
  const agent = Object.create(MurkFunAgent.prototype);
  const later = () => { throw new Error("REACHED_SIGNING"); };
  Object.assign(agent, {
    pub, cfg: { deployment: D, chainId: 56, withdrawAllowlist: "any" },
    tokenState: async () => ({ graduated: true, devPseudonym: 7n }), pseudonym: () => 7n,
    notPaused: later, relayQuote: later, makeOrder: later, currentMarket: later, marketOf: async () => D.market,
  });
  // the agent's own wallet (a getter over the vault, which this stub does not have)
  Object.defineProperty(agent, "walletAddress", { value: A(0x0e0a) });
  return agent;
}

test("tools: withdraw_bnb, withdraw_token, set_fee_recipient and create_token refuse a sink before any quote or signature; a contract needs confirmContract", async () => {
  const agent = agentOn(reader());
  await assert.rejects(agent.withdrawBnb({ token: TOKEN, to: TOKEN }), /bad_recipient: withdraw_bnb to .* this token's own contract/);
  await assert.rejects(agent.withdrawBnb({ token: TOKEN, to: D.locker }), /bad_recipient/);
  await assert.rejects(agent.withdrawToken({ token: TOKEN, to: OTHER_TOKEN }), /bad_recipient: withdraw_token to .*MurkFun token/);
  await assert.rejects(agent.withdrawToken({ token: TOKEN, to: TOKEN_DEX_LOCKER }), /bad_recipient/);
  await assert.rejects(agent.setFeeRecipient({ token: TOKEN, recipient: TOKEN }), /bad_recipient: set_fee_recipient recipient/);
  await assert.rejects(agent.setFeeRecipient({ token: TOKEN, recipient: CUR_HOOK }), /bad_recipient/);
  await assert.rejects(agent.createToken({ name: "n", symbol: "s", metadataURI: "", devFeeRecipient: CUR }), /bad_recipient: create_token devFeeRecipient/);
  await assert.rejects(agent.createToken({ name: "n", symbol: "s", metadataURI: "", devFeeRecipient: WBNB, confirmContract: true }), /bad_recipient/);
  for (const call of [
    (c?: boolean) => agent.withdrawBnb({ token: TOKEN, to: SAFE, confirmContract: c }),
    (c?: boolean) => agent.withdrawToken({ token: TOKEN, to: SAFE, confirmContract: c }),
    (c?: boolean) => agent.setFeeRecipient({ token: TOKEN, recipient: SAFE, confirmContract: c }),
    (c?: boolean) => agent.createToken({ name: "n", symbol: "s", metadataURI: "", devFeeRecipient: SAFE, confirmContract: c }),
  ]) {
    await assert.rejects(call(), /recipient_is_contract/);
    await assert.rejects(call(true), /REACHED_SIGNING/, "confirmed: the call goes on");
  }
  await assert.rejects(agent.withdrawBnb({ token: TOKEN, to: WALLET }), /REACHED_SIGNING/, "a plain wallet goes on");
});
