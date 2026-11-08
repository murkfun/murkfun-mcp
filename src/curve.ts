// MurkFunCurve.buy (the curve math of the MurkFun market contract) ported to bigint: constant product on virtual
// reserves, every amount rounded in the curve's favour exactly as the contract rounds it. Used where no chain quote
// exists yet: the creator buy, the first trade on a fresh curve, is computed from MurkFunFactory.currentTerms() before
// the token exists.

const BPS = 10_000n;

/** floor(a * b / d), or rounded up (OpenZeppelin Math.mulDiv with Rounding.Ceil). */
export function mulDiv(a: bigint, b: bigint, d: bigint, ceil = false): bigint {
  if (d === 0n) throw new Error("mulDiv: division by zero");
  const p = a * b;
  const q = p / d;
  return ceil && q * d !== p ? q + 1n : q;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

export interface CurveBuy { tokensOut: bigint; bnbUsed: bigint; fee: bigint }

/** A buy on the curve (MurkFunCurve.buy). Exact in (`exactOut` false): spend `amount` BNB gross (fee included). Exact
 *  out: buy `amount` tokens. A buy for more than `remaining` fills exactly `remaining` (the completing buy), charged
 *  the fee on the BNB it actually needs.
 *  @param x virtualBnb + bnbReserve
 *  @param y virtualTokens - tokensSold
 *  @param remaining curveSupply - tokensSold */
export function curveBuy(x: bigint, y: bigint, remaining: bigint, feeBps: bigint, amount: bigint, exactOut: boolean): CurveBuy {
  let tokensOut: bigint;
  let fee: bigint;
  if (!exactOut) {
    fee = (amount * feeBps) / BPS;
    tokensOut = y - mulDiv(x, y, x + amount - fee, true);
    if (tokensOut < remaining) return { tokensOut, bnbUsed: amount, fee };
    tokensOut = remaining;
  } else {
    tokensOut = min(amount, remaining);
  }
  // the net BNB that moves the curve by tokensOut, and the fee on top so that net = gross - fee
  const net = mulDiv(x, y, y - tokensOut, true) - x;
  fee = mulDiv(net, feeBps, BPS - feeBps, true);
  if (!exactOut) fee = min(fee, amount - net);
  return { tokensOut, bnbUsed: net + fee, fee };
}

/** The fields of MurkFunMarket.Terms the curve needs (MurkFunFactory.currentTerms / MurkFunMarket.termsOf). */
export interface CurveTerms { totalSupply: bigint; curveSupply: bigint; virtualBnb: bigint; virtualTokens: bigint; tradeFeeBps: number | bigint }

/** A buy on a fresh curve (nothing sold yet): the creator buy of a Launch order, which is the first trade and atomic
 *  with the creation, so this is its exact outcome. */
export const freshCurveBuy = (t: CurveTerms, amount: bigint, exactOut: boolean) =>
  curveBuy(t.virtualBnb, t.virtualTokens, t.curveSupply, BigInt(t.tradeFeeBps), amount, exactOut);

/** Tokens a `tokens: "cap"` buy asks for: the room left under the holding cap (never negative). */
export const capRoom = (cap: bigint, held: bigint) => (cap > held ? cap - held : 0n);

/** Whether a curve buy completes the curve, from its quote (MurkFunMarket.quoteBuy / quoteBuyExactOut): it fills
 *  exactly the `rest` (curveSupply - tokensSold), or less than asked: exact in spends less than `amount` BNB, exact out
 *  fills fewer than `amount` tokens. */
export function completesCurve(rest: bigint, amount: bigint, exactOut: boolean, tokensOut: bigint, bnbUsed: bigint): boolean {
  return tokensOut === rest || (exactOut ? tokensOut < amount : bnbUsed < amount);
}

/** `x` raised by `slippageBps` (rounded up): the most an exact-out buy may spend for a quoted cost `x`. */
export const withSlippage = (x: bigint, slippageBps: bigint) => (x * (BPS + slippageBps) + BPS - 1n) / BPS;

export const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
