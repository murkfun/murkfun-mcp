// Signed orders (docs/SIGNED_ORDERS.md): the hashes, typed data, holder tree and order witness of the order circuit
// (compiled in circuits/order.json), and the local prover. The holder tree is the same as the murkfun-holders package's
// (github.com/murkfun/holder-roots, src/tree.mjs); test/orders.test.ts proves a real order with the bundled circuit.
//
// Two wallet signatures make an order:
//   S1 over the fixed MurkFunSeed message (signed once at setup; deterministic; kept encrypted in the vault): the
//      identity secret, so the pseudonym of a token is H(secret, token). S1 alone can not trade: every order needs S2.
//   S2 over OrderAuth{orderHash} (per order): orderHash = H(order fields, salt). The signer (Binance) sees only that
//      opaque hash; the random salt keeps it unlinkable to the public order.
// The proof shows S1 and S2 are by one Agent ID holder in an accepted MurkFunHolderRoots root, without saying which.
//
// Proving needs no Noir install: the compiled circuit ships in this package (circuits/order.json, its verification
// key circuits/order.vk); noir_js computes the witness and Barretenberg's `bb` (6.0.0, the version the on-chain
// verifier was generated with) proves it. `bb` is MURKFUN_BB, or a `bb` on the PATH (or ~/.bb/bb) that reports 6.0.0,
// trusted as is (it sees the witness, which holds S1), or downloaded once from Aztec's GitHub release into
// ~/.murkfun/bin (only a download is checked against a pinned sha256).
import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { getAddress, hashDomain, hashTypedData, hexToBytes, keccak256, recoverPublicKey, toBytes, toHex, type Address, type Hex } from "viem";
import { publicKeyToAddress } from "viem/utils";

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const BATCH_LOG = 10;
export const GLOBAL_LOG = 16;
export const DEPTH = BATCH_LOG + GLOBAL_LOG;
export const BATCH_SIZE = 1 << BATCH_LOG;

/** MurkFunOrders.Action */
export const ACTION = {
  Buy: 1, BuyExactOut: 2, BuyDirect: 3, BuyDirectExactOut: 4, Sell: 5, WithdrawBnb: 6, WithdrawTokens: 7, Fund: 8,
  SetDevRecipient: 9, Launch: 10, LaunchExactOut: 11,
} as const;

const tag = (s: string) => BigInt(toHex(toBytes(s)));
export const TAG = { SECRET: tag("murk.secret"), PSEUDONYM: tag("murk.pseudonym"), NULLIFIER: tag("murk.nullifier"), ORDER: tag("murk.order") };

export const H = (xs: (bigint | number | string)[]) => poseidon2Hash(xs.map((x) => BigInt(x)));
const node = (l: bigint, r: bigint) => H([l, r]);
export const leaf = (a: Address) => H([BigInt(getAddress(a))]);
export const ZEROS: bigint[] = (() => {
  const z = [0n];
  for (let i = 0; i < DEPTH; i++) z.push(node(z[i], z[i]));
  return z;
})();

// ---------------------------------------------------------------- typed data (BSC, chainId 56: the circuit's constant)

export const DOMAIN = { name: "MurkFun Order", version: "1", chainId: 56 } as const;
export const SEED_PURPOSE = "MurkFun seed: only sign this on MurkFun";
const DOMAIN_FIELDS = [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }];

export const seedTypedData = () => ({ domain: DOMAIN, types: { MurkFunSeed: [{ name: "purpose", type: "string" }] }, primaryType: "MurkFunSeed" as const, message: { purpose: SEED_PURPOSE } });
export const orderAuthTypedData = (orderHash: bigint) => ({ domain: DOMAIN, types: { OrderAuth: [{ name: "orderHash", type: "bytes32" }] }, primaryType: "OrderAuth" as const, message: { orderHash: toHex(orderHash, { size: 32 }) } });
/** eth_signTypedData_v4 JSON (what `baw sign-message` takes). */
export function typedDataJson(td: { domain: object; types: Record<string, unknown>; primaryType: string; message: object }) {
  return { types: { EIP712Domain: DOMAIN_FIELDS, ...td.types }, primaryType: td.primaryType, domain: td.domain, message: td.message };
}
export const DOMAIN_SEPARATOR = hashDomain({ domain: DOMAIN, types: { EIP712Domain: DOMAIN_FIELDS } } as never);
export const ORDER_AUTH_TYPEHASH = keccak256(toBytes("OrderAuth(bytes32 orderHash)"));
export const SEED_DIGEST = hashTypedData(seedTypedData());
export const orderAuthDigest = (orderHash: bigint) => hashTypedData(orderAuthTypedData(orderHash));

// ---------------------------------------------------------------- identity

function rs(sig: Hex) {
  const b = hexToBytes(sig);
  if (b.length !== 65) throw new Error("BAD_SIGNATURE: expected 65 bytes");
  const r = BigInt(toHex(b.slice(0, 32)));
  const s = BigInt(toHex(b.slice(32, 64)));
  if (s === 0n || s > SECP_N / 2n) throw new Error("BAD_SIGNATURE: high-s signature");
  return { r, s, bytes: b.slice(0, 64) };
}
const limbs = (x: bigint) => [x >> 128n, x & ((1n << 128n) - 1n)];
export function secretOf(seedSig: Hex) {
  const { r, s } = rs(seedSig);
  return H([TAG.SECRET, ...limbs(r), ...limbs(s)]);
}
export const pseudonymOf = (secret: bigint, token: Address) => H([TAG.PSEUDONYM, secret, BigInt(token)]);
export const nullifierOf = (secret: bigint, token: Address, nonce: bigint) => H([TAG.NULLIFIER, secret, BigInt(token), nonce]);

/** The 0xbow seed (keystore and note secrets) from S1: a separate key from the order secret, so neither reveals the
 *  other. Re-signing S1 with the same wallet gives it back (the wallet is the backup). */
export function privacySeedOf(seedSig: Hex): Hex {
  rs(seedSig); // canonical only
  return toHex(new Uint8Array(crypto.hkdfSync("sha256", hexToBytes(seedSig).slice(0, 64), Buffer.from("murkfun"), Buffer.from("murkfun.0xbow-seed"), 32)));
}

/** The order's public fields, in circuit order (after holderRoot). */
export interface OrderFields {
  chainId: bigint; market: Address; action: number; token: Address; amount: bigint; minOut: bigint; to: Address;
  nonce: bigint; relayer: Address; fee: bigint; deadline: bigint;
}
const fieldList = (o: OrderFields) => [o.chainId, BigInt(o.market), BigInt(o.action), BigInt(o.token), o.amount, o.minOut, BigInt(o.to), o.nonce, BigInt(o.relayer), o.fee, o.deadline];
export function orderHashOf(o: OrderFields, salt: bigint) {
  const f = fieldList(o);
  for (const x of f) if (x < 0n || x >= FIELD) throw new Error("ORDER_OUT_OF_FIELD: an order value is too large");
  return H([TAG.ORDER, ...f, salt]);
}
export const randomSalt = () => BigInt(toHex(crypto.randomBytes(32))) % FIELD;

async function pubKey(digest: Hex, sig: Hex) {
  const pub = await recoverPublicKey({ hash: digest, signature: sig });
  const p = hexToBytes(pub);
  return { x: p.slice(1, 33), y: p.slice(33, 65), address: publicKeyToAddress(pub) };
}

/** The wallet that made `seedSig`. */
export async function seedSigner(seedSig: Hex) {
  return (await pubKey(SEED_DIGEST, seedSig)).address;
}

// ---------------------------------------------------------------- holder tree (MurkFunHolderRoots batches)

export function batchLevels(addrs: Address[]) {
  let layer = Array.from({ length: BATCH_SIZE }, (_, i) => (i < addrs.length ? leaf(addrs[i]) : 0n));
  const levels = [layer];
  for (let l = 0; l < BATCH_LOG; l++) {
    const next: bigint[] = [];
    for (let i = 0; i < layer.length; i += 2) next.push(node(layer[i], layer[i + 1]));
    levels.push((layer = next));
  }
  return levels;
}

/** Sparse tree over the batch subtree roots (slot i = batch i; empty slot = ZEROS[BATCH_LOG]). */
export function globalTree(roots: bigint[]) {
  const levels: Map<number, bigint>[] = [new Map(roots.map((r, i) => [i, r]))];
  const get = (l: number, i: number) => levels[l].get(i) ?? ZEROS[BATCH_LOG + l];
  for (let l = 0; l < GLOBAL_LOG; l++) {
    const next = new Map<number, bigint>();
    for (const i of levels[l].keys()) {
      const p = i >> 1;
      if (!next.has(p)) next.set(p, node(get(l, p * 2), get(l, p * 2 + 1)));
    }
    levels.push(next);
  }
  return {
    root: () => get(GLOBAL_LOG, 0),
    siblings: (index: number) => {
      const out: bigint[] = [];
      for (let l = 0, i = index; l < GLOBAL_LOG; l++, i >>= 1) out.push(get(l, i ^ 1));
      return out;
    },
  };
}

export interface HolderPath { index: bigint; siblings: bigint[]; root: bigint; batch: number }

/** The root `leafValue` at `index` reaches with `siblings` (leaf level first): the circuit's membership check. */
export function rootFromPath(leafValue: bigint, index: bigint, siblings: bigint[]): bigint {
  let h = leafValue;
  for (let l = 0; l < siblings.length; l++) h = (index >> BigInt(l)) & 1n ? node(siblings[l], h) : node(h, siblings[l]);
  return h;
}

/** `addr`'s path in the tree of `batches` (their address lists and subtree roots, from the Batch events). Hashes
 *  only `addr`'s own batch; the subtree root of that batch is checked against its event. */
export function holderPath(batches: { addrs: Address[]; subtreeRoot: bigint }[], addr: Address): HolderPath | undefined {
  const a = getAddress(addr);
  for (let b = 0; b < batches.length; b++) {
    const j = batches[b].addrs.findIndex((x) => getAddress(x) === a);
    if (j < 0) continue;
    const levels = batchLevels(batches[b].addrs);
    if (levels[BATCH_LOG][0] !== batches[b].subtreeRoot) throw new Error(`BAD_BATCH: batch ${b}'s list does not hash to its subtree root`);
    const inner: bigint[] = [];
    for (let l = 0, i = j; l < BATCH_LOG; l++, i >>= 1) inner.push(levels[l][i ^ 1]);
    const t = globalTree(batches.map((x) => x.subtreeRoot));
    return { index: BigInt(b) * BigInt(BATCH_SIZE) + BigInt(j), siblings: [...inner, ...t.siblings(b)], root: t.root(), batch: b };
  }
  return undefined;
}

// ---------------------------------------------------------------- witness + prover

const fx = (x: bigint | number) => toHex(BigInt(x));

/** The order circuit's inputs from the two signatures, the holder path and the order (checked locally). */
export async function orderWitness(a: { seedSig: Hex; orderSig: Hex; path: HolderPath; order: OrderFields; salt: bigint }) {
  const oh = orderHashOf(a.order, a.salt);
  const k1 = await pubKey(SEED_DIGEST, a.seedSig);
  const k2 = await pubKey(orderAuthDigest(oh), a.orderSig);
  if (k1.address !== k2.address) throw new Error("SIGNER_MISMATCH: the order was signed by another wallet than the seed");
  const secret = secretOf(a.seedSig);
  const pseudonym = pseudonymOf(secret, a.order.token);
  const nullifier = nullifierOf(secret, a.order.token, a.order.nonce);
  const names = ["chain_id", "market", "action", "token", "amount", "min_out", "to", "nonce", "relayer", "fee", "deadline"];
  const vals = fieldList(a.order);
  const inputs: Record<string, unknown> = {
    pub_key_x: Array.from(k1.x), pub_key_y: Array.from(k1.y),
    seed_sig: Array.from(rs(a.seedSig).bytes), order_sig: Array.from(rs(a.orderSig).bytes),
    leaf_index: fx(a.path.index), siblings: a.path.siblings.map(fx), salt: fx(a.salt), holder_root: fx(a.path.root),
    pseudonym: fx(pseudonym), order_nullifier: fx(nullifier),
  };
  names.forEach((n, i) => { inputs[n] = fx(vals[i]); });
  return { inputs, pseudonym, nullifier, orderHash: oh };
}

/** The compiled order circuit and its verification key, shipped with the package (circuits/). */
export const CIRCUIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../circuits");

/** Barretenberg 6.0.0 release tarballs (Aztec's GitHub release), by platform, with their sha256. */
export const BB_VERSION = "6.0.0";
export const BB_RELEASES: Record<string, { file: string; sha256: string }> = {
  "linux-x64": { file: "barretenberg-amd64-linux.tar.gz", sha256: "6a310ede6457cf47e6dcf11f8d6b59dd709328c272a70c03afb1417c5a798b67" },
  "linux-arm64": { file: "barretenberg-arm64-linux.tar.gz", sha256: "cbdf8cb01b80cca089b63834c543e49e65d1e4e0b969844ce7f302c3de30b432" },
  "darwin-x64": { file: "barretenberg-amd64-darwin.tar.gz", sha256: "b0f872ad96ba35a57a3b8b91a7e1b8baf39dbe6e33a8a5b969e5d110638f1161" },
  "darwin-arm64": { file: "barretenberg-arm64-darwin.tar.gz", sha256: "48bd18a7d53781a2820e7538dfd89584ca5b4d76c7908e8be4910ce994e7c35e" },
};

const run = (bin: string, args: string[], timeoutMs: number) =>
  new Promise<string>((resolve, reject) =>
    execFile(bin, args, { maxBuffer: 64 << 20, timeout: timeoutMs }, (err, out, stderr) => {
      if (!err) return resolve(String(out));
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error(`PROVER_MISSING: ${bin} not found`));
      // the witness / proof are secrets: only the tool's last error lines, never its input
      reject(new Error(`PROVER_FAILED: ${path.basename(bin)} ${args[0]}: ${String(stderr || err.message).trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`));
    }),
  );

/** `bb` 6.0.0: MURKFUN_BB, a `bb` on the PATH that reports 6.0.0 (trusted as installed: it is not hash-checked), a
 *  cached download, or a fresh download (pinned sha256) into `cacheDir`. */
export async function ensureBb(o: { bb?: string; cacheDir: string; download?: boolean }): Promise<string> {
  if (o.bb) return o.bb;
  for (const cand of ["bb", path.join(os.homedir(), ".bb", "bb")]) {
    try {
      if ((await run(cand, ["--version"], 20_000)).trim().replace(/^v/, "") === BB_VERSION) return cand;
    } catch { /* not there */ }
  }
  const dir = path.join(o.cacheDir, `bb-${BB_VERSION}`);
  const bin = path.join(dir, "bb");
  if (fs.existsSync(bin)) return bin;
  const rel = BB_RELEASES[`${process.platform}-${process.arch}`];
  if (!rel) throw new Error(`PROVER_MISSING: no pinned bb ${BB_VERSION} build for ${process.platform}-${process.arch}; install bb ${BB_VERSION} and set MURKFUN_BB`);
  if (o.download === false) throw new Error(`PROVER_MISSING: bb ${BB_VERSION} is not installed (MURKFUN_BB) and downloads are off (MURKFUN_BB_DOWNLOAD=0)`);
  const url = `https://github.com/AztecProtocol/barretenberg/releases/download/v${BB_VERSION}/${rel.file}`;
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  } catch (e) {
    throw new Error(`PROVER_MISSING: downloading bb ${BB_VERSION} failed (${(e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message}); install it and set MURKFUN_BB`);
  }
  if (!res.ok) throw new Error(`PROVER_MISSING: downloading bb ${BB_VERSION} failed (HTTP ${res.status}); install it and set MURKFUN_BB`);
  const tgz = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash("sha256").update(tgz).digest("hex");
  if (got !== rel.sha256) throw new Error(`PROVER_MISSING: the bb ${BB_VERSION} download does not match its pinned sha256 (${got}); not used`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(o.cacheDir, "bb-dl-"));
  try {
    fs.writeFileSync(path.join(tmp, rel.file), tgz);
    await run("tar", ["-xzf", path.join(tmp, rel.file), "-C", tmp], 120_000);
    fs.copyFileSync(path.join(tmp, "bb"), bin);
    fs.chmodSync(bin, 0o755);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return bin;
}

export interface ProverOptions { bb: string; circuitDir?: string; timeoutMs?: number; /** default os.tmpdir() */ tmpDir?: string }

/** Prove circuits/order locally: noir_js computes the witness from the bundled circuit, `bb` proves it. The witness
 *  (it holds S1) only ever exists in memory and in a private temp dir that is removed afterwards. */
export async function proveOrder(inputs: Record<string, unknown>, o: ProverOptions): Promise<{ proof: Hex; ms: number }> {
  const dirC = o.circuitDir ?? CIRCUIT_DIR;
  const bytecode = path.join(dirC, "order.json");
  const vk = path.join(dirC, "order.vk");
  for (const p of [bytecode, vk]) if (!fs.existsSync(p)) throw new Error(`CIRCUIT_MISSING: ${p} not found (a broken install: reinstall murkfun-mcp)`);
  const { Noir } = await import("@noir-lang/noir_js");
  const t0 = Date.now();
  const noir = new Noir(JSON.parse(fs.readFileSync(bytecode, "utf8")));
  let witness: Uint8Array;
  try {
    ({ witness } = await noir.execute(inputs as never));
  } catch (e) {
    throw new Error(`WITNESS_FAILED: the order does not satisfy the circuit (${String((e as Error).message).split("\n")[0].slice(0, 200)})`);
  }
  const tmp = o.tmpDir ?? os.tmpdir();
  sweepStaleWitnesses(tmp);
  const dir = fs.mkdtempSync(path.join(tmp, "murk-order-"));
  fs.chmodSync(dir, 0o700);
  try {
    fs.writeFileSync(path.join(dir, "w.gz"), witness, { mode: 0o600 });
    await run(o.bb, ["prove", "-b", bytecode, "-w", path.join(dir, "w.gz"), "-k", vk, "-o", dir, "-t", "evm"], o.timeoutMs ?? 300_000);
    return { proof: toHex(fs.readFileSync(path.join(dir, "proof"))), ms: Date.now() - t0 };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A delay in [min, max] ms (uniform): Binance sees when each S2 is signed, so the order should not land right after. */
export function randomDelayMs(min: number, max: number) {
  if (max <= min) return min;
  return min + (crypto.randomInt(0, 2 ** 31 - 1) % (max - min + 1));
}

/** Witness directories an earlier process left behind (killed while proving): they hold the order witness, which
 *  contains the seed signature. Removed once older than ten minutes (a running proof is never that old). */
export function sweepStaleWitnesses(dir = os.tmpdir(), now = Date.now()) {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!n.startsWith("murk-order-")) continue;
    const p = path.join(dir, n);
    try {
      if (now - fs.statSync(p).mtimeMs > 10 * 60_000) fs.rmSync(p, { recursive: true, force: true });
    } catch { /* not ours, or gone */ }
  }
}
