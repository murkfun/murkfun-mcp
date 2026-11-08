// The RPC that eth_getLogs scans go to (the holder set's Batch events when the holder-set API gives no usable proof,
// the 0xbow leaves after the snapshot, recovery). Many free BSC endpoints do not serve logs: bsc-dataseed refuses every
// eth_getLogs ("limit exceeded"), publicnode answers [] for older ranges without an error. So the endpoint is probed
// once per process: MURKFUN_RPC first, then MURKFUN_LOG_RPCS (default: the network file's logRpcs). The probe reads the
// Batch event of the holder set's live batch 0 from the blocks whose timestamp is that batch's postedAt (on-chain
// storage, so the range is known to hold the event without trusting anyone): an error or an empty answer fails the
// endpoint. Before the first batch it only needs a 1-block eth_getLogs at the head to succeed. What a log endpoint
// answers is never trusted on its own either: the batches must rebuild the on-chain accepted root (agent.ts).
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { holderRootsAbi } from "./abi.js";

export const BATCH_EVENT = (holderRootsAbi as unknown as any[]).find((x) => x.type === "event" && x.name === "Batch");

/** An RPC URL fit for an error message: scheme and host only (a path or query can hold an API key). */
export function redactUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname.length > 1 || x.search ? "/…" : ""}`;
  } catch {
    return "<invalid url>";
  }
}

const brief = (e: unknown) => ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e)).split("\n")[0].slice(0, 120);

/** Blocks [from, to] that hold the Batch event of the holder set's live batch 0: those whose timestamp is its
 *  postedAt (BSC puts several blocks in one second). undefined before the first batch. */
export async function batchZeroBlocks(pub: PublicClient, roots: Address, fromBlock: bigint): Promise<{ from: bigint; to: bigint } | undefined> {
  const count = await pub.readContract({ address: roots, abi: holderRootsAbi, functionName: "batchCount" }) as bigint;
  if (count === 0n) return undefined;
  const b = await pub.readContract({ address: roots, abi: holderRootsAbi, functionName: "batches", args: [0n] }) as readonly unknown[];
  const ts = BigInt(b[2] as bigint);
  const latest = await pub.getBlockNumber();
  const time = async (n: bigint) => (await pub.getBlock({ blockNumber: n })).timestamp;
  /** First block in [lo, hi] with timestamp > t (hi + 1 if none). */
  const after = async (t: bigint, lo: bigint, hi: bigint) => {
    let end = hi + 1n;
    while (lo < end) {
      const mid = (lo + end) / 2n;
      if ((await time(mid)) > t) end = mid;
      else lo = mid + 1n;
    }
    return lo;
  };
  const from = await after(ts - 1n, fromBlock, latest);
  // the blocks of that second: usually 1-3 on BSC (galloping from `from`), any number on a dev chain
  let step = 1n;
  while (from + step <= latest && (await time(from + step)) === ts) step *= 2n;
  const to = (await after(ts, from, from + step > latest ? latest : from + step)) - 1n;
  return { from, to: to < from ? from : to };
}

export interface LogRpcOptions {
  main: PublicClient; mainUrl: string;
  /** Other endpoints, tried in order after mainUrl. */
  urls: string[];
  chainId: number;
  /** Resolves when `c` serves the logs the MCP needs; throws why not. */
  probe: (c: PublicClient) => Promise<void>;
  make?: (url: string) => PublicClient;
  /** A failed search is answered from memory for this long, then searched again. */
  retryMs?: number;
}

export class LogRpc {
  private found?: Promise<{ client: PublicClient; url: string }>;
  private failedAt = 0;
  constructor(private o: LogRpcOptions) {}

  /** The first endpoint that passes the probe (searched once per process; a failure is retried after retryMs). */
  async client(): Promise<PublicClient> {
    return (await this.pick()).client;
  }
  async url(): Promise<string> {
    return (await this.pick()).url;
  }

  private pick() {
    if (this.found && this.failedAt && Date.now() - this.failedAt > (this.o.retryMs ?? 60_000)) this.found = undefined;
    if (!this.found) {
      this.failedAt = 0;
      this.found = this.search();
      this.found.catch(() => { this.failedAt = Date.now(); });
    }
    return this.found;
  }

  private async search() {
    const make = this.o.make ?? ((u: string) => createPublicClient({ cacheTime: 0, transport: http(u, { timeout: 120_000, retryCount: 2 }) }) as PublicClient);
    const tried: string[] = [];
    for (const url of [...new Set([this.o.mainUrl, ...this.o.urls])]) {
      const client = url === this.o.mainUrl ? this.o.main : make(url);
      try {
        if (url !== this.o.mainUrl) {
          const id = await client.getChainId();
          if (id !== this.o.chainId) throw new Error(`chain id ${id}, not ${this.o.chainId}`);
        }
        await this.o.probe(client);
        return { client, url };
      } catch (e) {
        tried.push(`${redactUrl(url)}: ${brief(e)}`);
      }
    }
    throw new Error(`NO_LOG_RPC: no RPC serves the eth_getLogs the holder path needs (the holder-set API gave no usable proof, so the holder batches are read from the chain). Tried ${tried.join("; ")}. Set MURKFUN_RPC (or MURKFUN_LOG_RPCS, comma-separated) to a BSC endpoint that serves eth_getLogs over old blocks, or retry when the holder-set API (MURKFUN_HOLDERS_API) answers; nothing was signed or sent`);
  }
}

/** The probe the MCP uses: the holder set's batch 0 Batch event must come back from `c` (see the file comment). */
export function batchProbe(main: PublicClient, roots: () => Promise<Address>, fromBlock: bigint) {
  let range: Promise<{ roots: Address; r?: { from: bigint; to: bigint } }> | undefined;
  return async (c: PublicClient) => {
    range ??= (async () => { const a = await roots(); return { roots: a, r: await batchZeroBlocks(main, a, fromBlock) }; })();
    range.catch(() => { range = undefined; });
    const { roots: a, r } = await range;
    if (!r) {
      const head = await c.getBlockNumber();
      await c.getLogs({ address: a, event: BATCH_EVENT, fromBlock: head, toBlock: head } as never);
      return;
    }
    const logs = await c.getLogs({ address: a, event: BATCH_EVENT, fromBlock: r.from, toBlock: r.to } as never) as unknown[];
    if (!logs.length) throw new Error(`empty answer for blocks ${r.from}-${r.to}, which hold the holder set's batch 0`);
  };
}
