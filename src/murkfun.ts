// MurkFun order encoding and chain constants (mirrors MurkFunOrders.Order and MurkFunFactory.launchDigest).
import { encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from "viem";

/** Relay terms of an order: the relayer, its fee (BNB wei, from the pseudonym's balance) and the deadline. */
export interface Relay { relayer: Address; fee: bigint; deadline: bigint }

/** MurkFunOrders.Order. */
export interface Order {
  action: number; token: Address; amount: bigint; minOut: bigint; to: Address; nonce: bigint; relayer: Address; fee: bigint;
  deadline: bigint; holderRoot: bigint; pseudonym: bigint; nullifier: bigint;
}
export const ORDER_TUPLE = { type: "tuple", components: [
  { type: "uint8", name: "action" }, { type: "address", name: "token" }, { type: "uint256", name: "amount" }, { type: "uint256", name: "minOut" },
  { type: "address", name: "to" }, { type: "uint256", name: "nonce" }, { type: "address", name: "relayer" }, { type: "uint256", name: "fee" },
  { type: "uint256", name: "deadline" }, { type: "uint256", name: "holderRoot" }, { type: "uint256", name: "pseudonym" }, { type: "uint256", name: "nullifier" },
] } as const;

/** MurkFunFactory.TokenSpec (a launch's token), for MurkFunRailgunAdapter.launch. */
export const TOKEN_SPEC_TUPLE = { type: "tuple", components: [
  { type: "string", name: "name" }, { type: "string", name: "symbol" }, { type: "string", name: "metadataURI" },
  { type: "address", name: "devFeeRecipient" }, { type: "bytes32", name: "devSalt" }, { type: "bytes", name: "launchSig" },
] } as const;

/** TransactParams.data of a 0xbow-paid order (processor = MurkFunPrivacyPoolAdapter): abi.encode(order). */
export function orderData(o: Order): Hex {
  return encodeAbiParameters([ORDER_TUPLE], [o]);
}

/** The order as the relayer's wire format takes it (decimal strings). */
export function wireOrder(o: Order) {
  return {
    action: String(o.action), token: o.token, amount: o.amount.toString(), minOut: o.minOut.toString(), to: o.to, nonce: o.nonce.toString(),
    relayer: o.relayer, fee: o.fee.toString(), deadline: o.deadline.toString(), holderRoot: o.holderRoot.toString(),
    pseudonym: o.pseudonym.toString(), nullifier: o.nullifier.toString(),
  };
}

/** MurkFunFactory.launchDigest: what the launch key signs (raw digest) to bind the dev pseudonym to the launch. */
export function launchDigest(chainId: number, factory: Address, token: Address, devPseudonym: bigint): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }],
    [BigInt(chainId), factory, keccak256(new TextEncoder().encode("murkfun.launch")), token, devPseudonym]));
}

/** Railgun's smart wallet (the proxy MurkFunRailgunAdapter.railgun() names): its unshield fee, in bps, inclusive. */
export const railgunAbi = parseAbi(["function unshieldFee() view returns (uint120)"]);

/** The WBNB a Railgun wallet must unshield to MurkFunRailgunAdapter so that exactly `net` arrives: Railgun keeps
 *  floor(gross x feeBps / 10^4) of an unshield of `gross`. The smallest such gross (one always exists: each extra wei
 *  of gross adds 0 or 1 wei of net). */
export function railgunGross(net: bigint, feeBps: bigint): bigint {
  const f = (g: bigint) => g - (g * feeBps) / 10_000n;
  let g = feeBps >= 10_000n ? net : (net * 10_000n + (10_000n - feeBps) - 1n) / (10_000n - feeBps);
  while (g > 0n && f(g - 1n) >= net) g--;
  while (f(g) < net) g++;
  return g;
}
export const WBNB: Address = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
export const QUOTER_V2: Address = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997"; // PancakeSwap v3 QuoterV2 (BSC)
export const quoterAbi = parseAbi([
  "struct Q { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(Q params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
