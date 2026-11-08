// Revert decoding and agent-facing hints for MurkFun errors (contract custom errors and relayer error codes).
import { decodeErrorResult, toFunctionSelector, type Hex } from "viem";
import { marketAbi, factoryAbi, privacyPoolAdapterAbi, railgunAdapterAbi, ordersAbi, dexAbi } from "./abi.js";
import { fence } from "./fence.js";

/** Every MurkFun custom error an order can revert with: the market's, the factory's (a launch), the 0xbow and Railgun
 *  adapters' (privacy-pool orders), the order gate's (proof, root, nullifier) and the Dex's (a GraduationFailed
 *  reason). One entry per signature. */
export const ERRORS_ABI = (() => {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const abi of [marketAbi, factoryAbi, privacyPoolAdapterAbi, railgunAdapterAbi, ordersAbi, dexAbi] as unknown as any[][]) {
    for (const x of abi) {
      if (x.type !== "error") continue;
      const sig = toFunctionSelector(`${x.name}(${x.inputs.map((i: any) => i.type).join(",")})`);
      if (!seen.has(sig)) { seen.add(sig); out.push(x); }
    }
  }
  return out;
})();

/** Name of a contract revert (e.g. "Slippage()") found anywhere in a viem error chain. */
export function revertName(e: unknown): string {
  let cur: unknown = e;
  for (let i = 0; i < 10 && cur; i++) {
    const d = (cur as { data?: unknown }).data;
    const data = typeof d === "string" ? d : (d as { data?: unknown })?.data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) return decodeRevert(data as Hex);
    if ((cur as { errorName?: string }).errorName) return `${(cur as { errorName: string }).errorName}()`;
    cur = (cur as { cause?: unknown }).cause;
  }
  // no revert data: the RPC's own text, fenced (third-party text, never instructions)
  return fence("error", ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e)).split("\n")[0]);
}

/** "Name(args)" of MurkFun revert data, or "revert 0x12345678" if it is not a MurkFun error. */
export function decodeRevert(data: Hex): string {
  try {
    const r = decodeErrorResult({ abi: ERRORS_ABI as never, data });
    return `${r.errorName}(${(r.args ?? []).map(String).join(",")})`;
  } catch {
    return `revert ${data.slice(0, 10)}`;
  }
}

const HINTS: [RegExp, string][] = [
  [/MarketPaused|MARKET_PAUSED/, "MurkFun is paused by its guardian (emergency): every MurkFun action waits (launches, buys, sells, funding, graduation, withdraw_bnb, withdraw_tokens, fee claims); balances and holdings stay where they are. Tell the user; retry after the guardian unpauses (the pause has no expiry; status shows marketPaused). LP fee collection on graduated pools is not paused"],
  [/PrivacyPoolRequired|PRIVACY_POOL_REQUIRED/, "during the curve, MurkFun only accepts BNB from privacy pools through its own adapters: 0xbow (MurkFun's 0xbow adapter) or Railgun (MurkFun's Railgun adapter, the unshield's adapt contract); Railgun's RelayAdapt and plain wallets are refused: buy / fund_pseudonym / create_token from Railgun (the default source) or buy source=note (0xbow); a plain wallet can fund only after graduation (or if MurkFun turns the rule off; status shows privacyFunding)"],
  [/NotBoundToOrder/, "a Railgun transaction does not name MurkFun's Railgun adapter (adaptContract) and this order's adaptParams: build the Railgun transaction with exactly the railgun.adaptContract / railgun.adaptParams the tool returned; nothing was spent"],
  [/NotAWbnbUnshield/, "a Railgun transaction is not a plain unshield of WBNB to MurkFun's Railgun adapter (another token or recipient, a redirect, or no unshield): build it with exactly the returned `railgun` values; nothing was spent, the Railgun notes are unspent"],
  [/WrongUnshieldAmount/, "the Railgun unshield did not deliver exactly the order's amount to MurkFun's Railgun adapter (Railgun's unshield fee changed, or another amount / recipient / token was unshielded): call the tool again for fresh amounts; nothing was spent, the Railgun notes are unspent"],
  [/NoUnshield/, "a Railgun-paid order needs at least one Railgun transaction that unshields its amount to MurkFun's Railgun adapter; nothing was spent"],
  [/NotWbnb/, "MurkFun's Railgun adapter takes BNB only from WBNB's unwrap of a Railgun unshield; nothing was spent"],
  [/bad_unshield|RAILGUN_TX_INVALID/, "the Railgun transaction is not a NORMAL WBNB unshield to MurkFun's Railgun adapter bound to this order (railgun.adaptContract, railgun.adaptParams), or does not deliver exactly the order's amount: build it again with exactly the returned railgun values (if Railgun's unshield fee changed, call the tool again for a new order); nothing was sent, the Railgun notes are unspent"],
  [/bad_target/, "the relayer refused MurkFun's Railgun adapter: it is not on MurkFun's privacy-funder allowlist right now (or not this deployment's); pay from 0xbow (source=note) instead; nothing was sent"],
  [/RAILGUN_RELAY_SENT: .*not known yet/, "the relayer accepted this Railgun order and it may still be mined: poll order_status with its order id; submit_railgun sends it again only once that reports dropped or reverted (the Railgun notes are then unspent); do not build a new Railgun transaction meanwhile"],
  [/RAILGUN_ORDER_EXPIRED/, "call buy / fund_pseudonym / create_token (source railgun, the default) again: a new order needs a new Railgun transaction (the adapt params change with the order)"],
  [/NO_RAILGUN_ADAPTER/, "this MurkFun deployment has no Railgun adapter: use source=note (0xbow) for buy and create_token"],
  [/WAITING_FOR_ASP/, "Notice (Nov 8, 2026): 0xbow's ASP on BNB Chain is currently not approving new deposits; use Railgun, and the user can take BNB already in 0xbow back to their wallet any time with 0xbow's ragequit. The 0xbow note is waiting for 0xbow's ASP, which can take hours or much longer and may not approve it at all; nothing was spent. Poll status every 5-10 min, or pay from Railgun instead (buy / create_token without source: the default, it does not wait for 0xbow's ASP). After 24 h tell the user they can exit the deposit through 0xbow's own app (ragequit)"],
  [/PrivacyPoolPaidLess/, "0xbow paid MurkFun less than the proof's amount (a 0xbow withdrawal fee?); nothing was spent, the note is unspent. Tell the user; 0xbow buys stop until MurkFun supports it (buy source=railgun still works)"],
  [/WrongPrivacyPoolAsset/, "the 0xbow note is not native BNB; MurkFun buys only with BNB notes"],
  [/WrongPrivacyPoolAmount/, "the 0xbow proof's amount does not match the order; retry (a new proof is built)"],
  [/NotProcessor/, "the 0xbow order does not name MurkFun's 0xbow adapter as its processor (wrong deployment's privacyPoolAdapter?); nothing was spent"],
  [/NotPoolVault/, "only the 0xbow PoolVault may pay the 0xbow adapter; nothing was spent"],
  [/WrongAction/, "the order's action does not fit the call (a bug in the client); nothing was spent"],
  [/WrongToken/, "the created token is not the address the Launch order commits to (the platform terms changed since the quote?): call create_token again"],
  [/WrongRecipient/, "the launch's dev fee recipient is not the one the Launch order names; call create_token again"],
  [/NotLaunchKey/, "the launch key's signature does not cover this dev pseudonym (a copied launch?); call create_token again"],
  [/UnknownRoot/, "the holder root of the order is no longer (or not yet) accepted; retry (a new order is signed against the latest accepted root)"],
  [/NullifierUsed/, "this signed order was already used; retry (a new order is signed)"],
  [/WrongNonce/, "the pseudonym's nonce changed (another action landed first); retry (a new order is signed)"],
  [/Slippage/, "price moved beyond slippageBps; re-quote and retry (raise slippage only with the user's consent)"],
  [/CapExceeded/, "over the curve-phase holding cap for this pseudonym (1% of supply, dev: own cap); buy less (tokens:\"cap\" buys exactly up to it) or wait for graduation"],
  [/InsufficientBalance/, "not enough internal BNB/tokens for this token's pseudonym (relayer fee included); check token_info"],
  [/CurveSoldOut/, "curve sold out and its automatic graduation failed: no buys until graduate (retry) succeeds; sells to the curve still work while the market is not paused. Then trade on the DEX pool"],
  [/OutOfGas/, "not enough gas for the graduation this buy triggers (it completes the curve): resend with more gas (the relayer's completing-buy quote includes it)"],
  [/NotGraduated/, "only possible after graduation"],
  [/AlreadyGraduated/, "already graduated"],
  [/PriceNotReached/, "curve not sold out yet: graduation is not possible"],
  [/GraduationBlocked/, "every DEX venue is blocked right now; retry later and tell the user"],
  [/BadRecipient/, "that destination is a MurkFun contract, a MurkFun token, a privacy-pool adapter or WBNB, where the funds would be lost: use an address you control (an ordinary wallet)"],
  [/PausedSinceProposal/, "a MurkFun re-point can not be proposed or executed while the market is paused, nor executed after a pause since its proposal: propose it again after the unpause"],
  [/DexNotWired/, "the MurkFun Dex is being replaced (its re-points are not all executed yet): graduation waits; retry graduate later and tell the user"],
  [/Expired/, "the order's deadline passed before it executed; nothing was spent and the pseudonym's nonce did not move. The MCP sets every deadline from the chain's latest block time, not this machine's clock: retry (a new order gets a fresh deadline); if it keeps happening, MURKFUN_RPC may serve a stale chain head: use another RPC"],
  [/deadline_too_soon/, "the order reached the relayer too close to its deadline; nothing was sent: retry (a new order gets a fresh deadline)"],
  [/NotDev/, "only the dev pseudonym of this token may do this"],
  [/ZeroAmount/, "amount is zero / below the minimum"],
  [/BelowMinimum/, "the amount is not more than the relayer fee: raise the amount"],
  [/InvalidProof/, "the order proof was rejected (a changed order, or a stale bundled circuit: reinstall murkfun-mcp); nothing was spent"],
  [/NOT_A_HOLDER_YET|NOT_ACCEPTED_YET|NO_ACCEPTED_ROOT/, "the wallet is not in an accepted root of MurkFun's holder set yet: the holder-set operator adds new Agent ID holders in batches, and a batch is usable 1 h after it is posted. Nothing was signed or sent; retry later (status shows holderSet)"],
  [/PROVER_MISSING|CIRCUIT_MISSING|PROVER_FAILED|WITNESS_FAILED/, "the local prover (Barretenberg bb 6.0.0, downloaded once into ~/.murkfun/bin, or MURKFUN_BB) could not prove the order; nothing was sent. Check the message; reinstall murkfun-mcp or set MURKFUN_BB"],
  [/fee_too_low/, "the order's relayer fee no longer covers its gas: the gas price rose since the quote, or the buy now completes the curve (another buy landed first) and pays the graduation gas, quoted in the completing-buy gas class; nothing was sent: call the tool again to re-quote, and tell the user the fee if dryRun shows completesCurve"],
  [/reverted_before/, "an earlier order of this pseudonym/note reverted on chain; read its error with order_status, fix the cause and retry after the time the relayer names"],
  [/busy/, "a previous order for this pseudonym/note is still pending; check order_status and retry after it is mined"],
  [/relayer_fee_too_high/, "the relayer's quote is above MURKFUN_MAX_RELAYER_FEE_BNB; nothing was signed or sent. Tell the user; retry later"],
  [/broadcast_failed|overloaded|simulation_unavailable|relayer_unreachable/, "nothing was sent (no nonce, note or balance was used); the MCP already resubmitted the identical order MURKFUN_ORDER_RETRIES times: retry later"],
  [/rate_limited/, "too many requests or orders from this IP address; retry in a minute"],
  [/^(relayer_underfunded|unavailable|misconfigured|internal): /, "a problem on the relayer's side; retry later, and tell the user if it persists"],
  [/^unknown_token: /, "not a MurkFun token: check the address"],
];

/** The error code of a failed simulation: `order_expired` for an `Expired()` revert (the order's deadline is behind the
 *  chain's time), else `simulation_failed`. */
export function simulationCode(name: string): "order_expired" | "simulation_failed" {
  return /^Expired\b/.test(name) ? "order_expired" : "simulation_failed";
}

export function hintFor(msg: string): string {
  const h = HINTS.find(([re]) => re.test(msg));
  return h ? ` (${h[1]})` : "";
}
