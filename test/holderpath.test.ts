// The holder path without eth_getLogs (no chain): the holder-set API's proof (a stub API on a local port) is used only
// when it checks out locally and against the on-chain accepted root, else the Batch-log scan is the fallback; the
// log endpoint is found by a probe (MURKFUN_RPC first, then MURKFUN_LOG_RPCS) and the error names the problem when no
// endpoint serves logs. Real Poseidon2 trees (src/orders.ts); the chain is a stub.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import type { AddressInfo } from "net";
import { getAddress, toHex, type Address } from "viem";
import * as zk from "../src/orders.js";
import { verifyHolderProof, lookupClaim, type HolderLookup } from "../src/holdersApi.js";
import { LogRpc, batchProbe, batchZeroBlocks, redactUrl } from "../src/logRpc.js";
import { MurkFunAgent } from "../src/agent.js";

const addr = (i: number) => getAddress(`0x${(0xbeef0000 + i).toString(16).padStart(40, "0")}`) as Address;
const ME = addr(7);
const OTHER = addr(51);
// batch 0: ME at position 2; batch 1: OTHER and two more
const batches = [[addr(1), addr(2), ME, addr(3)], [addr(50), OTHER, addr(52)]];
const roots = batches.map((b) => zk.batchLevels(b)[zk.BATCH_LOG][0]);
const list = batches.map((a, i) => ({ addrs: a, subtreeRoot: roots[i] }));
const ACCEPTED = zk.globalTree(roots).root(); // batch 1 accepted
const OLDER = zk.globalTree(roots.slice(0, 1)).root(); // batch 0's root: known on chain (ROOT_HISTORY), not the latest
const fhex = (x: bigint) => toHex(x, { size: 32 });

/** What /v1/holders/lookup answers for `who` in the tree of `bs` (the holder-set API's format, docs/API.md). */
function lookupOf(bs: Address[][], who: Address): HolderLookup {
  const p = zk.holderPath(bs.map((a) => ({ addrs: a, subtreeRoot: zk.batchLevels(a)[zk.BATCH_LOG][0] })), who)!;
  return {
    address: who, status: "included", batch: p.batch, accepted: true, usableFrom: 1_800_000_000,
    proof: { leaf: fhex(zk.leaf(who)), leafIndex: p.index.toString(), siblings: p.siblings.map(fhex), root: fhex(p.root), rootBatch: bs.length - 1, batchRoot: fhex(roots[p.batch]) },
  };
}
const good = () => lookupOf(batches, ME);

let server: http.Server;
let base = "";
let answer: () => { status: number; body?: unknown } = () => ({ status: 200, body: good() });
const requests: string[] = [];
before(async () => {
  server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    const a = answer();
    if (a.status === 0) return void res.destroy();
    res.writeHead(a.status, { "content-type": "application/json" });
    res.end(JSON.stringify(a.body ?? { error: "x" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** An agent with a stub chain: acceptedRoot() = (ACCEPTED, 1); the Batch logs come from `logs` (scans counted). */
function agent(o: { holdersApi?: string; logs?: () => Promise<unknown> } = {}) {
  const scans: bigint[] = [];
  const pub = { getBlockNumber: async () => 400n, readContract: async () => [ACCEPTED, 1n] };
  const a = Object.create(MurkFunAgent.prototype);
  Object.defineProperty(a, "walletAddress", { get: () => ME });
  Object.assign(a, {
    cfg: { holdersApi: o.holdersApi, deployment: { deployBlock: 1 } }, chainChecked: true, holderBatchCache: new Map(), apiPaths: new Map(),
    holderRootsOf: async () => addr(99), pub,
    logClient: o.logs ?? (async () => pub),
    logsChunked: async (_a: unknown, _e: unknown, _t: unknown, from: bigint) => {
      scans.push(from);
      return list.map((b, id) => ({ eventName: "Batch", args: { id: BigInt(id), addrs: b.addrs, subtreeRoot: b.subtreeRoot } }));
    },
  });
  return { holderPath: () => a.holderPath(addr(1)) as Promise<zk.HolderPath & { source: string }>, scans };
}

test("rootFromPath rebuilds the accepted root from a holder path", () => {
  const p = zk.holderPath(list, OTHER)!;
  assert.equal(zk.rootFromPath(zk.leaf(OTHER), p.index, p.siblings), ACCEPTED);
});

test("verifyHolderProof: a good proof gives the circuit's path; a bad leaf, sibling, root or shape is refused", () => {
  const p = verifyHolderProof(good(), ME);
  assert.deepEqual(p, { ...zk.holderPath(list, ME)!, batch: 0 });
  const bad = (f: (l: HolderLookup) => void) => { const l = good(); f(l); return () => verifyHolderProof(l, ME); };
  assert.throws(bad((l) => { l.proof!.siblings[3] = fhex(BigInt(l.proof!.siblings[3]) + 1n); }), /does not reach its root/);
  assert.throws(bad((l) => { l.proof!.root = fhex(ACCEPTED + 1n); }), /does not reach its root/);
  assert.throws(bad((l) => { l.proof!.leafIndex = "3"; }), /does not reach its root/);
  assert.throws(bad((l) => { l.proof!.siblings.pop(); }), /25 siblings, not 26/);
  assert.throws(bad((l) => { l.proof!.siblings[0] = fhex(zk.FIELD); }), /not a field element/);
  assert.throws(bad((l) => { l.proof!.leafIndex = "-1"; }), /leafIndex/);
  assert.throws(bad((l) => { l.proof = null; }), /no proof/);
  // another holder's (valid) proof is not this wallet's
  assert.throws(() => verifyHolderProof(lookupOf(batches, OTHER), ME), /leaf is not this wallet's/);
});

test("holder path: the API's proof is used when it checks out against the on-chain accepted root (no eth_getLogs)", async () => {
  answer = () => ({ status: 200, body: good() });
  requests.length = 0;
  const a = agent({ holdersApi: base, logs: async () => { throw new Error("NO_LOG_RPC: test: no log endpoint"); } });
  const p = await a.holderPath();
  assert.equal(p.source, "api");
  assert.equal(p.root, ACCEPTED);
  assert.equal(p.batch, 0);
  assert.deepEqual(a.scans, [], "no log scan");
  assert.deepEqual(requests, [`/v1/holders/lookup?q=${ME}`]);
  // the next order against the same accepted root does not ask again
  assert.equal((await a.holderPath()).source, "api");
  assert.equal(requests.length, 1, "one lookup per accepted root");
});

test("holder path: a tampered, foreign, outdated or unknown API proof is ignored and the Batch logs are used", async () => {
  const cases: [string, () => HolderLookup][] = [
    ["tampered sibling", () => { const l = good(); l.proof!.siblings[12] = fhex(123n); return l; }],
    ["wrong root (the proof's own root is altered)", () => { const l = good(); l.proof!.root = fhex(OLDER); return l; }],
    ["older root (known on chain, not the latest accepted)", () => lookupOf(batches.slice(0, 1), ME)],
    ["unknown root (a tree the chain never had)", () => lookupOf([batches[0], [addr(60)]], ME)],
    ["wrong leaf (another holder's proof)", () => lookupOf(batches, OTHER)],
    ["no proof", () => ({ ...good(), proof: null })],
    ["garbage", () => ({ hello: "world" }) as never],
  ];
  for (const [what, l] of cases) {
    answer = () => ({ status: 200, body: l() });
    const a = agent({ holdersApi: base });
    const p = await a.holderPath();
    assert.equal(p.source, "logs", what);
    assert.equal(p.root, ACCEPTED, what);
    assert.deepEqual(a.scans, [1n], `${what}: fell back to the log scan`);
  }
});

test("holder path: an API that is down or errors falls back to the logs; without MURKFUN_HOLDERS_API the API is never asked", async () => {
  for (const status of [0, 500, 404]) {
    answer = () => ({ status });
    const a = agent({ holdersApi: base });
    assert.equal((await a.holderPath()).source, "logs", `status ${status}`);
  }
  const dead = agent({ holdersApi: "http://127.0.0.1:9" });
  assert.equal((await dead.holderPath()).source, "logs", "unreachable");
  requests.length = 0;
  const off = agent({});
  assert.equal((await off.holderPath()).source, "logs");
  assert.deepEqual(requests, []);
});

test("holder path: no proof and no log endpoint: the error names both (the API's own answer, marked unverified)", async () => {
  const noLogs = async () => { throw new Error("NO_LOG_RPC: no RPC serves the eth_getLogs the holder path needs. Tried https://bsc-dataseed.bnbchain.org: limit exceeded"); };
  answer = () => ({ status: 200, body: { ...good(), status: "pending", batch: null, accepted: false, proof: null } });
  await assert.rejects(agent({ holdersApi: base, logs: noLogs }).holderPath(), (e: Error) =>
    /^NOT_A_HOLDER_YET/.test(e.message) && /holder-set API's answer/.test(e.message) && /NO_LOG_RPC/.test(e.message));
  answer = () => ({ status: 200, body: { ...good(), accepted: false, proof: null, usableFrom: 1_800_000_000 } });
  await assert.rejects(agent({ holdersApi: base, logs: noLogs }).holderPath(), (e: Error) => /^NOT_ACCEPTED_YET: your wallet is in holder batch 0.*2027-01-15/.test(e.message));
  answer = () => ({ status: 200, body: (() => { const l = good(); l.proof!.siblings[0] = fhex(5n); return l; })() });
  await assert.rejects(agent({ holdersApi: base, logs: noLogs }).holderPath(), (e: Error) => /^NO_LOG_RPC.*\[holder-set API: proof rejected: the proof does not reach its root\]/.test(e.message));
  answer = () => ({ status: 500 });
  await assert.rejects(agent({ holdersApi: base, logs: noLogs }).holderPath(), (e: Error) => /^NO_LOG_RPC.*\[holder-set API: unreachable \(«HTTP 500»\)\]/.test(e.message));
  assert.equal(lookupClaim({ ...good(), status: "admin_minted", proof: null }, ME)?.startsWith("NOT_A_HOLDER_YET"), true);
  assert.equal(lookupClaim(good(), ME), undefined);
});

// ---------------------------------------------------------------- the log endpoint probe

const ROOTS = addr(99);
/** A chain of blocks 0..200 whose timestamp is floor(n / 3) (three blocks per second); batch 0 posted at second 40,
 *  i.e. in blocks 120..122. */
function chainStub(o: { batchCount?: bigint } = {}) {
  const calls = { getBlock: 0 };
  return {
    calls,
    getBlockNumber: async () => 200n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => { calls.getBlock++; return { timestamp: blockNumber / 3n }; },
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "batchCount" ? (o.batchCount ?? 2n) : [ACCEPTED, `0x${"00".repeat(32)}`, 40n, 0n, 0, 1, 3640n],
  };
}
/** An RPC: `kind` "ok" serves the Batch event in 120..122, "empty" answers [] (publicnode on old ranges), "refuse"
 *  errors (bsc-dataseed's "limit exceeded"). */
function rpcStub(kind: "ok" | "empty" | "refuse", chainId = 56) {
  const seen: [bigint, bigint][] = [];
  return {
    seen,
    getChainId: async () => chainId,
    getBlockNumber: async () => 200n,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      seen.push([fromBlock, toBlock]);
      if (kind === "refuse") throw Object.assign(new Error("limit exceeded"), { shortMessage: "limit exceeded" });
      return kind === "ok" && fromBlock <= 120n && 120n <= toBlock ? [{ eventName: "Batch" }] : [];
    },
  };
}

test("batchZeroBlocks: the blocks whose timestamp is batch 0's postedAt (on-chain storage), none before the first batch", async () => {
  const main = chainStub();
  assert.deepEqual(await batchZeroBlocks(main as never, ROOTS, 10n), { from: 120n, to: 122n });
  assert.ok(main.calls.getBlock < 20, `binary search (${main.calls.getBlock} block reads)`);
  assert.equal(await batchZeroBlocks(chainStub({ batchCount: 0n }) as never, ROOTS, 10n), undefined);
  // a dev chain (anvil) mines many blocks in one second: the whole second is covered
  const dev = { ...chainStub(), getBlock: async ({ blockNumber: n }: { blockNumber: bigint }) => ({ timestamp: n < 100n ? 30n : n <= 180n ? 40n : 50n }) };
  assert.deepEqual(await batchZeroBlocks(dev as never, ROOTS, 10n), { from: 100n, to: 180n });
});

test("log endpoint probe: MURKFUN_RPC first, then MURKFUN_LOG_RPCS; refusals, empty answers and other chains fail; once per process", async () => {
  const main = chainStub();
  const refusing = Object.assign(rpcStub("refuse"), main);
  const made: Record<string, ReturnType<typeof rpcStub>> = {
    "https://empty.example": rpcStub("empty"), "https://testnet.example": rpcStub("ok", 97), "https://logs.example": rpcStub("ok"),
  };
  const lr = new LogRpc({
    main: refusing as never, mainUrl: "https://bsc-dataseed.example", urls: Object.keys(made), chainId: 56,
    probe: batchProbe(refusing as never, async () => ROOTS, 10n), make: (u) => made[u] as never,
  });
  assert.equal(await lr.client(), made["https://logs.example"]);
  assert.equal(await lr.url(), "https://logs.example");
  assert.deepEqual(made["https://empty.example"].seen, [[120n, 122n]], "probed on batch 0's blocks; [] there = no logs");
  assert.deepEqual(made["https://testnet.example"].seen, [], "another chain is not probed");
  // cached: no second probe
  await lr.client();
  assert.equal(made["https://logs.example"].seen.length, 1);
  // the configured RPC wins when it serves logs
  const good = Object.assign(rpcStub("ok"), main);
  const first = new LogRpc({ main: good as never, mainUrl: "https://mine.example", urls: ["https://logs.example"], chainId: 56, probe: batchProbe(good as never, async () => ROOTS, 10n), make: (u) => made[u] as never });
  assert.equal(await first.client(), good);
});

test("log endpoint probe: before the first batch a 1-block eth_getLogs at the head is enough", async () => {
  const main = Object.assign(rpcStub("empty"), chainStub({ batchCount: 0n }));
  const lr = new LogRpc({ main: main as never, mainUrl: "https://mine.example", urls: [], chainId: 56, probe: batchProbe(main as never, async () => ROOTS, 10n) });
  assert.equal(await lr.client(), main);
  assert.deepEqual(main.seen, [[200n, 200n]]);
});

test("log endpoint probe: none serves logs: NO_LOG_RPC names each endpoint (scheme and host only) and why; retried later", async () => {
  const main = Object.assign(rpcStub("refuse"), chainStub());
  let ok = false;
  const later = rpcStub("ok");
  const lr = new LogRpc({
    main: main as never, mainUrl: "https://bsc.example/v3/SECRETKEY", urls: ["https://empty.example/?key=SECRET2"], chainId: 56, retryMs: 0,
    probe: batchProbe(main as never, async () => ROOTS, 10n), make: () => (ok ? later : rpcStub("empty")) as never,
  });
  await assert.rejects(lr.client(), (e: Error) =>
    /^NO_LOG_RPC/.test(e.message) && e.message.includes("https://bsc.example/…: limit exceeded")
    && e.message.includes("https://empty.example/…: empty answer for blocks 120-122") && !/SECRET/.test(e.message) && /MURKFUN_LOG_RPCS/.test(e.message));
  ok = true;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await lr.client(), later, "searched again after retryMs");
  assert.equal(redactUrl("https://rpc.example"), "https://rpc.example");
  assert.equal(redactUrl("https://u:p@rpc.example/k"), "https://rpc.example/…");
});
