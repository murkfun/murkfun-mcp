// Read-only client for the MurkFun indexer API (docs/API.md), used for public market data in list_launches and
// token_info. Never used for the user's own balances, nonces or anything a proof depends on: those stay on-chain.
// Every failure (unreachable, timeout, HTTP error, unexpected shape, wrong deployment) returns undefined so the caller
// falls back to the chain; the reason is kept in lastError for the tool output.
import { z } from "zod";
import type { Address } from "viem";

const num = z.number();
// Every string field the MCP shows has a fixed format here, so an indexer's own text never reaches the model outside a
// fence: addresses, pool ids and enums are checked; name / symbol / metadataUri are fenced as third-party text
// (tools.ts UNTRUSTED_KEYS).
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const venue = z.object({
  kind: z.enum(["pancake-infinity", "pancake-v3", "pancake-v2"]), pool: addr.nullable().optional(),
  poolId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable().optional(), feeTier: num.nullable().optional(),
}).nullable();
export const Launch = z.object({
  // name / symbol / metadataUri are null when MurkFun's moderation withholds them (docs/API.md "Moderation"); trading data never is
  address: addr, name: z.string().nullable(), symbol: z.string().nullable(), metadataUri: z.string().nullable().optional(),
  moderation: z.enum(["ok", "unscanned", "flagged", "hidden"]).nullable().optional().catch(null),
  createdAt: num, status: z.enum(["curve", "sold_out", "graduated"]), progress: num,
  curve: z.object({ tokensSold: num, curveSupply: num, bnbReserve: num, graduationRaiseBnb: num }),
  priceBnb: num, marketCapBnb: num, change24h: num, volumeBnb: num, volume24hBnb: num, trades: num, trades24h: num,
  holders: num, lastTradeAt: num.nullable(), venue: venue.optional(), devCapBps: num.nullable().optional(),
});
export type Launch = z.infer<typeof Launch>;
const Launches = z.object({ total: num, items: z.array(Launch) });
const Params = z.object({ chainId: num, market: addr, factory: addr.optional() });

export class IndexerClient {
  lastError?: string;
  private checked?: Promise<boolean>;

  /** `expect.factory` identifies the deployment when the indexer reports its factory (the market can be re-pointed;
   *  the factory cannot); otherwise the market is compared. */
  constructor(readonly base: string, private expect: { chainId: number; market: Address; factory?: Address }, private timeoutMs = 5000) {}

  private async get<T>(p: string, schema: z.ZodType<T>): Promise<T> {
    const r = await fetch(`${this.base}${p}`, { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(r.status === 404 ? `${p} not indexed yet` : `HTTP ${r.status} for ${p}`);
    const parsed = schema.safeParse(await r.json());
    if (!parsed.success) throw new Error(`unexpected response for ${p}: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  }

  /** Once per process: the indexer must serve this chain and this market, else it is never used. Retried after a
   *  network failure (the indexer may come up later), not after a mismatch. */
  private ready(): Promise<boolean> {
    return (this.checked ??= this.get("/params", Params).then(
      (p) => {
        const same = p.factory && this.expect.factory
          ? p.factory.toLowerCase() === this.expect.factory.toLowerCase()
          : p.market.toLowerCase() === this.expect.market.toLowerCase();
        if (p.chainId !== this.expect.chainId || !same) {
          this.lastError = `indexer serves chain ${p.chainId} ${p.factory && this.expect.factory ? `factory ${p.factory}` : `market ${p.market}`}, not this deployment; ignoring it`;
          return false;
        }
        return true;
      },
      (e) => { this.checked = undefined; throw e; },
    ));
  }

  private async attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      if (!(await this.ready())) return undefined;
      const out = await fn();
      this.lastError = undefined;
      return out;
    } catch (e) {
      this.lastError = `indexer unavailable (${(e as Error).message}); read from the chain`;
      return undefined;
    }
  }

  launches(limit: number, offset: number) {
    return this.attempt(() => this.get(`/launches?sort=new&limit=${limit}&offset=${offset}`, Launches));
  }

  /** undefined also when the indexer does not know the token yet (404, e.g. created a few blocks ago). */
  token(address: Address) {
    return this.attempt(() => this.get(`/tokens/${address.toLowerCase()}`, Launch));
  }
}
