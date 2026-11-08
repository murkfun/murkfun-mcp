// What a mined buy did, read from its receipt: the market's Bought (what was bought and paid), CurveCompleted (it
// sold out the curve) and Graduated / GraduationFailed (the automatic graduation in the same transaction).
import { decodeEventLog, getAddress, type Address, type Hex } from "viem";
import { marketAbi } from "./abi.js";

export interface BoughtEvent {
  token: Address; pseudonym: bigint; bnbIn: bigint; tokensOut: bigint; fee: bigint; venueFee: bigint;
  bnbReserve: bigint; tokensSold: bigint; price: bigint;
}
export interface SoldEvent {
  token: Address; pseudonym: bigint; tokensIn: bigint; bnbOut: bigint; fee: bigint; venueFee: bigint;
  bnbReserve: bigint; tokensSold: bigint; price: bigint;
}
export interface TradeReceipt {
  bought?: BoughtEvent;
  sold?: SoldEvent;
  curveCompleted?: { bnbReserve: bigint; tokensSold: bigint; price: bigint };
  graduated?: { venue: number; pool: Address; poolId: Hex; fee: number; bnb: bigint; tokens: bigint; repaired: boolean };
  graduationFailed?: { reason: Hex };
}

export interface RawLog { address: Address; topics: readonly Hex[] | Hex[]; data: Hex }

const NAMES = new Set(["Bought", "Sold", "CurveCompleted", "Graduated", "GraduationFailed"]);

/** The market events of `token` (and of `pseudonym`, for Bought / Sold) in `logs`, emitted by `market`. Other logs
 *  (the adapter, 0xbow, the Dex, the pool) are skipped. */
export function decodeTradeReceipt(logs: readonly RawLog[], market: Address, token: Address, pseudonym?: bigint): TradeReceipt {
  const out: TradeReceipt = {};
  const m = getAddress(market), t = getAddress(token);
  for (const l of logs) {
    if (getAddress(l.address) !== m) continue;
    let ev: { eventName: string; args: any };
    try {
      ev = decodeEventLog({ abi: marketAbi as never, topics: l.topics as never, data: l.data }) as never;
    } catch {
      continue;
    }
    if (!NAMES.has(ev.eventName) || getAddress(ev.args.token) !== t) continue;
    const a = ev.args;
    const mine = pseudonym === undefined || a.pseudonym === pseudonym;
    if (ev.eventName === "Bought" && mine) out.bought = { ...a, token: t };
    else if (ev.eventName === "Sold" && mine) out.sold = { ...a, token: t };
    else if (ev.eventName === "CurveCompleted") out.curveCompleted = { bnbReserve: a.bnbReserve, tokensSold: a.tokensSold, price: a.price };
    else if (ev.eventName === "Graduated") {
      out.graduated = { venue: Number(a.venue), pool: a.pool, poolId: a.poolId, fee: Number(a.fee), bnb: a.bnb, tokens: a.tokens, repaired: a.repaired };
    } else if (ev.eventName === "GraduationFailed") out.graduationFailed = { reason: a.reason };
  }
  return out;
}
