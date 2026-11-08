// Signed-order unit tests (no chain): OrderAuth / seed signing through the Binance Agentic Wallet CLI wrapper (test/fake-baw.mjs),
// a real local proof from the bundled circuit (noir_js + bb), and the config knobs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { getAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as zk from "../src/orders.js";
import { BawSigner } from "../src/baw.js";
import { delayRange as delayFrom } from "../src/config.js";

const KEY = keccak256(toBytes("murkfun.zk.test-key.mcp")); // throwaway test key
const ME = privateKeyToAccount(KEY).address;
const addr = (i: number) => getAddress(`0x${(0xc0de0000 + i).toString(16).padStart(40, "0")}`) as Address;

function fakeBaw(extra: Record<string, string> = {}) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "fake-baw-"));
  Object.assign(process.env, { FAKE_BAW_KEY: KEY, FAKE_BAW_STATE: state, FAKE_BAW_LOG: path.join(state, "log.jsonl"), ...extra });
  return { signer: new BawSigner({ bin: path.join(import.meta.dirname, "fake-baw.mjs"), chainId: 56 }), log: () => fs.readFileSync(path.join(state, "log.jsonl"), "utf8") };
}

const batchRoot = (addrs: Address[]) => zk.batchLevels(addrs)[zk.BATCH_LOG][0];

const order = (o: Partial<zk.OrderFields> = {}): zk.OrderFields => ({
  chainId: 56n, market: addr(1), action: zk.ACTION.Buy, token: addr(2), amount: 10n ** 16n, minOut: 5n, to: "0x0000000000000000000000000000000000000000",
  nonce: 3n, relayer: addr(3), fee: 7n, deadline: 1_900_000_000n, ...o,
});

test("baw signs the seed (deterministically) and OrderAuth; the signatures build a witness", async () => {
  const { signer, log } = fakeBaw();
  const seed = await signer.signTypedDataTwice(ME, zk.typedDataJson(zk.seedTypedData()));
  assert.equal(await zk.seedSigner(seed), ME);
  const o = order();
  const salt = zk.randomSalt();
  const s2 = await signer.signTypedData(ME, zk.typedDataJson(zk.orderAuthTypedData(zk.orderHashOf(o, salt))));
  const batches = [{ addrs: [addr(1), ME], subtreeRoot: batchRoot([addr(1), ME]) }];
  const w = await zk.orderWitness({ seedSig: seed, orderSig: s2, path: zk.holderPath(batches, ME)!, order: o, salt });
  const secret = zk.secretOf(seed);
  assert.equal(w.pseudonym, zk.pseudonymOf(secret, o.token));
  assert.equal(w.nullifier, zk.nullifierOf(secret, o.token, o.nonce));
  // what the signer saw: an opaque bytes32, no token, no amount
  const signed = log().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(signed.every((l) => !String(JSON.stringify(l)).includes(o.token.slice(2).toLowerCase())), "the token never reaches baw");
  assert.ok(signed.some((l) => l.cmd === "sign-message preview"));
  assert.ok(!signed.some((l) => l.cmd.startsWith("contract-call")), "an order never sends a wallet transaction");
  // S2 of another order does not fit
  const other = await signer.signTypedData(ME, zk.typedDataJson(zk.orderAuthTypedData(zk.orderHashOf(order({ amount: 1n }), salt))));
  await assert.rejects(zk.orderWitness({ seedSig: seed, orderSig: other, path: zk.holderPath(batches, ME)!, order: o, salt }), /SIGNER_MISMATCH/);
});

test("a high-s baw answer is folded to low s, so the identity stays the same", async () => {
  const { signer } = fakeBaw({ FAKE_BAW_HIGH_S: "1" });
  const seed = await signer.signTypedData(ME, zk.typedDataJson(zk.seedTypedData()));
  delete process.env.FAKE_BAW_HIGH_S;
  const { signer: normal } = fakeBaw();
  const seed2 = await normal.signTypedData(ME, zk.typedDataJson(zk.seedTypedData()));
  assert.equal(seed.toLowerCase(), seed2.toLowerCase());
  assert.equal(zk.secretOf(seed), zk.secretOf(seed2));
});

test("a nondeterministic signer is refused at setup", async () => {
  const { signer } = fakeBaw({ FAKE_BAW_NONDETERMINISTIC: "1" });
  await assert.rejects(signer.signTypedDataTwice(ME, zk.typedDataJson(zk.seedTypedData())), /BAW_NONDETERMINISTIC/);
  delete process.env.FAKE_BAW_NONDETERMINISTIC;
});

test("local proof from the bundled circuit (noir_js witness + bb 6.0.0)", { timeout: 300_000 }, async () => {
  const { signer } = fakeBaw();
  const seed = await signer.signTypedData(ME, zk.typedDataJson(zk.seedTypedData()));
  const o = order({ chainId: 31337n });
  const salt = 5n;
  const s2 = await signer.signTypedData(ME, zk.typedDataJson(zk.orderAuthTypedData(zk.orderHashOf(o, salt))));
  const batches = [{ addrs: [ME], subtreeRoot: batchRoot([ME]) }];
  const w = await zk.orderWitness({ seedSig: seed, orderSig: s2, path: zk.holderPath(batches, ME)!, order: o, salt });
  const bb = await zk.ensureBb({ bb: process.env.MURKFUN_BB, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "murk-bb-")) });
  // a private temp dir: the shared one may hold another process's proof in progress
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "murk-prove-"));
  const r = await zk.proveOrder(w.inputs, { bb, tmpDir });
  assert.equal((r.proof.length - 2) / 2, 9536);
  // the witness never stays on disk
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // a tampered witness does not satisfy the circuit
  await assert.rejects(zk.proveOrder({ ...w.inputs, amount: "0x1" }, { bb }), /WITNESS_FAILED/);
  await assert.rejects(zk.proveOrder(w.inputs, { bb, circuitDir: "/nonexistent" }), /CIRCUIT_MISSING/);
  await assert.rejects(zk.proveOrder(w.inputs, { bb: "/nonexistent/bb" }), /PROVER_MISSING/);
});

test("bb: MURKFUN_BB first; downloads are pinned per platform (sha256)", async () => {
  for (const k of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) assert.match(zk.BB_RELEASES[k].sha256, /^[0-9a-f]{64}$/);
  assert.equal(zk.BB_VERSION, "6.0.0");
  assert.equal(await zk.ensureBb({ bb: "/opt/bb", cacheDir: "/nonexistent" }), "/opt/bb", "MURKFUN_BB wins");
});

test("the random signing-to-submit delay and its config", () => {
  assert.deepEqual(delayFrom("30000-180000"), [30000, 180000]);
  assert.deepEqual(delayFrom("500"), [500, 500]);
  assert.throws(() => delayFrom("5-1"), /max below min/);
  assert.throws(() => delayFrom("soon"), /MURKFUN_ORDER_DELAY_MS/);
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) {
    const d = zk.randomDelayMs(1000, 1010);
    assert.ok(d >= 1000 && d <= 1010);
    seen.add(d);
  }
  assert.ok(seen.size > 5, "spread over the range");
  assert.equal(zk.randomDelayMs(7, 7), 7);
});

test("order values outside the field are refused before signing", () => {
  assert.throws(() => zk.orderHashOf(order({ amount: zk.FIELD }), 1n), /ORDER_OUT_OF_FIELD/);
  assert.throws(() => zk.secretOf(`0x${"11".repeat(32)}${"ff".repeat(32)}1b` as Hex), /high-s/);
});

test("cached holder batches that do not rebuild the accepted root are dropped and rescanned before the wallet is looked up (a missed Batch event never reads as not a holder for good)", async () => {
  const { MurkFunAgent } = await import("../src/agent.js");
  const batches = [Array.from({ length: 3 }, (_, i) => addr(40 + i)), [addr(50), ME]];
  const roots = batches.map((b) => batchRoot(b));
  const accepted = zk.globalTree(roots).root();
  const log = (id: number) => ({ eventName: "Batch", args: { id: BigInt(id), addrs: batches[id], subtreeRoot: roots[id] } });
  let omitWallet = true;
  const scans: bigint[] = [];
  const agent = Object.create(MurkFunAgent.prototype);
  Object.defineProperty(agent, "walletAddress", { get: () => ME });
  Object.assign(agent, {
    cfg: { deployment: { deployBlock: 1 } }, chainChecked: true, holderBatchCache: new Map(),
    holderRootsOf: async () => addr(99),
    pub: { getBlockNumber: async () => 400n, readContract: async () => [accepted, 1n] },
    logClient: async function (this: { pub: unknown }) { return this.pub; },
    // an RPC that leaves the wallet's own Batch event out of its answer
    logsChunked: async (_a: unknown, _e: unknown, _t: unknown, from: bigint) => { scans.push(from); return omitWallet ? [log(0)] : [log(0), log(1)]; },
  });
  const holderPath = () => (agent as any).holderPath(addr(1));
  // still missing after the rebuild: ROOT_MISMATCH (retry), never NOT_A_HOLDER_YET, and nothing incomplete is kept
  await assert.rejects(holderPath(), /ROOT_MISMATCH/);
  assert.deepEqual(scans, [1n, 1n], "rescanned from the deployment block");
  await assert.rejects(holderPath(), /ROOT_MISMATCH/);
  assert.deepEqual(scans.slice(2), [381n, 1n], "every call that finds a mismatch rescans from the deployment block (was: only from the cursor past the missed block)");
  // the RPC answers in full again: the path is found
  omitWallet = false;
  const p = await holderPath();
  assert.equal(p.root, accepted);
  assert.equal(p.batch, 1);
});
