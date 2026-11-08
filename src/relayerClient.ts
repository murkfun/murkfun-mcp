// HTTP client for the MurkFun relayer (docs/RELAYER_API.md).
import { fence } from "./fence.js";

const J = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

/** An error from the relayer (or from reaching it). `code` is a stable local code: the relayer's own only if it is a
 *  plain identifier. `reason` is the relayer's text, fenced (an error message reaches the model like a
 *  tool result, so a hostile relayer's text is data, never instructions); `note` is MurkFun's own. */
export class RelayerError extends Error {
  readonly code: string;
  readonly reason: string;
  constructor(code: unknown, reason: unknown, note = "") {
    const c = typeof code === "string" && /^[a-z][a-z0-9_]{0,47}$/.test(code) ? code : "relayer_error";
    // a hostile relayer's `reason` may be anything: text, else its JSON
    const text = typeof reason === "string" ? reason : (JSON.stringify(reason) ?? String(reason));
    const r = fence("reason", text);
    super(`${c}: ${r}${note}`);
    this.code = c;
    this.reason = text;
  }
}

// The shapes of the relayer's answers: every field the MCP uses or shows is checked before use, and
// only those fields pass on, so no relayer text reaches the model outside a fence (the order's `error` is fenced as
// third-party text by tools.ts). A mismatch is a fixed local error that names the field, never its value.
const DEC = /^(0|[1-9][0-9]{0,77})$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ORDER_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const ORDER_STATUSES = ["submitted", "mined", "reverted", "dropped", "failed"] as const;

function badAnswer(what: string, field: string): never {
  throw new RelayerError("relayer_bad_answer", `the relayer's ${what} answer has no valid ${field}`, "; nothing was signed or sent for it");
}
function field(o: any, k: string, re: RegExp, what: string, optional = false): string | undefined {
  const v = o?.[k];
  if ((v === undefined || v === null) && optional) return undefined;
  if (typeof v !== "string" || !re.test(v)) badAnswer(what, k);
  return v;
}
function flag(o: any, k: string, what: string): boolean | undefined {
  const v = o?.[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") badAnswer(what, k);
  return v;
}

/** A quote with only the checked fields. */
export function checkedQuote(q: any, action: string): Quote {
  if (!q || typeof q !== "object") badAnswer("quote", "body");
  const gasClass = q.gasClass ?? undefined;
  if (gasClass !== undefined && !["standard", "completing-buy", "post-graduation"].includes(gasClass)) badAnswer("quote", "gasClass");
  const out: Quote = {
    action, relayer: field(q, "relayer", ADDR, "quote") as `0x${string}`, fee: field(q, "fee", DEC, "quote")!, deadline: field(q, "deadline", DEC, "quote")!,
    gasPriceWei: field(q, "gasPriceWei", DEC, "quote")!, sponsored: flag(q, "sponsored", "quote") ?? false,
  };
  const graduates = flag(q, "graduates", "quote");
  if (graduates !== undefined) out.graduates = graduates;
  if (gasClass !== undefined) out.gasClass = gasClass;
  for (const k of ["gasUnits", "quoteGasPriceWei", "validUpToGasPriceWei"] as const) {
    const v = field(q, k, DEC, "quote", true);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** An order status (GET /v1/orders/:id, and the submit answer) with only the checked fields. */
export function checkedStatus(s: any, what = "order status"): OrderStatus {
  if (!s || typeof s !== "object") badAnswer(what, "body");
  if (!ORDER_STATUSES.includes(s.status)) badAnswer(what, "status");
  const out: OrderStatus = { id: field(s, "id", ORDER_ID, what)!, status: s.status };
  const txHash = field(s, "txHash", HASH, what, true);
  if (txHash !== undefined) out.txHash = txHash as `0x${string}`;
  for (const k of ["blockNumber", "gasUsed"] as const) {
    const v = field(s, k, DEC, what, true);
    if (v !== undefined) out[k] = v;
  }
  if (s.error !== undefined && s.error !== null) out.error = typeof s.error === "string" ? s.error : (JSON.stringify(s.error) ?? "");
  return out;
}

/** GET /v1/quote. `gasClass` "completing-buy": the buy sells out the curve and graduates the token in the same
 *  transaction, so `fee` covers that gas too; "post-graduation": a trade on a graduated token, which swaps through its
 *  pool. */
export interface Quote {
  action: string; relayer: `0x${string}`; fee: string; deadline: string; gasPriceWei: string; sponsored: boolean;
  graduates?: boolean; gasClass?: "standard" | "completing-buy" | "post-graduation"; gasUnits?: string; quoteGasPriceWei?: string; validUpToGasPriceWei?: string;
}
export interface OrderStatus { id: string; status: string; txHash?: `0x${string}`; error?: string; blockNumber?: string; gasUsed?: string }

/** `token` + `amount` (BNB offered; tokens with `exactOut`): the relayer checks itself whether the buy completes the
 *  curve. `graduates`: the client already knows it does. `token` alone: the relayer checks whether the token has
 *  graduated (a trade then swaps through its pool: gas class "post-graduation"). */
export interface QuoteOptions { graduates?: boolean; token?: string; amount?: bigint; exactOut?: boolean }

/** Submit errors after which nothing was sent and the identical order may be submitted again: every private endpoint
 *  refused the transaction (the relayer released its nonce), the relayer is overloaded, or it was not reached. A proof
 *  can never execute twice (a signed order binds the pseudonym's nonce and has a single-use nullifier; a 0xbow nullifier is single-use). */
export const RETRYABLE_SUBMIT = new Set(["broadcast_failed", "overloaded", "simulation_unavailable", "relayer_unreachable"]);

/** Retry budget: `retries` resubmissions of the identical order after a retryable submit error or a final status
 *  `dropped` (not executed: the relayer cancelled its transaction), waiting backoffMs, 2 x backoffMs, ... (at most
 *  30 s) in between. */
export interface RetryPolicy { retries: number; backoffMs: number }
export const backoffDelay = (p: RetryPolicy, attempt: number) => Math.min(p.backoffMs * 2 ** (attempt - 1), 30_000);

export interface RunResult { status: OrderStatus; attempts: number; ids: string[] }

export class RelayerClient {
  constructor(readonly url: string, private sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {}

  private async req(path: string, init?: RequestInit) {
    let r: Response;
    try {
      r = await fetch(`${this.url}${path}`, { ...init, signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new RelayerError("relayer_unreachable", `${this.url}: ${(e as Error).message}`);
    }
    const body = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new RelayerError(body.error ?? `http_${r.status}`, body.reason ?? JSON.stringify(body));
    return body;
  }

  info() { return this.req("/v1/info"); }
  async quote(action: string, o: QuoteOptions = {}): Promise<Quote> {
    return checkedQuote(await this.req(`/v1/quote?${quoteQuery(action, o)}`), action);
  }
  async submit(order: unknown): Promise<{ id: string; status: string; txHash: `0x${string}` }> {
    const s = checkedStatus(await this.req("/v1/orders", { method: "POST", headers: { "content-type": "application/json" }, body: J(order) }), "submit");
    if (!s.txHash) badAnswer("submit", "txHash");
    return { id: s.id, status: s.status, txHash: s.txHash };
  }
  async status(id: string): Promise<OrderStatus> {
    if (!ORDER_ID.test(id)) throw new RelayerError("not_found", "not an order id of this relayer");
    return checkedStatus(await this.req(`/v1/orders/${id}`));
  }

  /** Poll until the order leaves `submitted` or `timeoutMs` passes. A status read the relayer does not answer is
   *  read again (the order itself is unaffected). */
  async wait(id: string, timeoutMs: number): Promise<OrderStatus> {
    const t0 = Date.now();
    for (;;) {
      let s: OrderStatus | undefined;
      try {
        s = await this.status(id);
      } catch (e) {
        if (!(e instanceof RelayerError && RETRYABLE_SUBMIT.has(e.code)) || Date.now() - t0 > timeoutMs) throw e;
      }
      if (s && s.status !== "submitted") return s;
      if (s && Date.now() - t0 > timeoutMs) return s;
      await this.sleep(1000);
    }
  }

  /** Submit `order` and wait for its outcome; resubmit the identical order (bounded by `policy`) when nothing was sent
   *  (RETRYABLE_SUBMIT) or the relayer dropped it. A stale order then fails with the relayer's own error (e.g.
   *  simulation_failed), which is thrown as is. `onAccepted` sees every accepted submission (order id, tx hash). */
  async run(order: unknown, policy: RetryPolicy, waitMs: number, onAccepted?: (r: { id: string; status: string; txHash: `0x${string}` }) => void): Promise<RunResult> {
    const ids: string[] = [];
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await this.submit(order);
      } catch (e) {
        if (e instanceof RelayerError && RETRYABLE_SUBMIT.has(e.code) && attempt < policy.retries) {
          await this.sleep(backoffDelay(policy, attempt + 1));
          continue;
        }
        if (e instanceof RelayerError && RETRYABLE_SUBMIT.has(e.code)) {
          throw new RelayerError(e.code, e.reason, ` (nothing was sent; resubmitted ${attempt} time${attempt === 1 ? "" : "s"})`);
        }
        throw e;
      }
      ids.push(r.id);
      onAccepted?.(r);
      const s = await this.wait(r.id, waitMs);
      if (s.status === "dropped" && attempt < policy.retries) {
        await this.sleep(backoffDelay(policy, attempt + 1));
        continue;
      }
      return { status: s, attempts: attempt + 1, ids };
    }
  }
}

export function quoteQuery(action: string, o: QuoteOptions = {}) {
  const q = new URLSearchParams({ action });
  if (o.graduates) q.set("graduates", "1");
  if (o.token) {
    q.set("token", o.token);
    if (o.amount !== undefined) {
      q.set("amount", o.amount.toString());
      if (o.exactOut) q.set("exactOut", "1");
    }
  }
  return q.toString();
}
