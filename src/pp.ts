// 0xbow Privacy Pools v2 client for the user's agent.
// Secrets are derived from the vault seed, so notes can be recovered from the seed + deposit amounts.
import fs from "fs";
import path from "path";
import * as snarkjs from "snarkjs";
import {
  parseAbi, keccak256, encodeAbiParameters, toHex, hexToBigInt, type Address, type Hex, type PublicClient,
} from "viem";
import { H, tree, FIELD } from "./zk.js";
import { ensureCircuits } from "./circuits.js";

export const PV: Address = "0x0Eb42804BF897662aF851370eaeAdcDBEC1b97ed"; // PoolVault (BSC)
export const EP: Address = "0xca1e072236D231130059eeA6Bfceb7F4e9a1F0C3"; // Entrypoint
export const KS: Address = "0x6E463391c79b7e1A88eF26E0B023f9A6C9938a71"; // Keystore
export const AR: Address = "0x259C0BEa1d783c202509BD3b2688d23b8AEf58B0"; // ASP registry
export const NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeEn;
export const MIN_DEPOSIT = 20_000_000_000_000_000n; // 0.02 BNB
const COMMITMENT_LEAF_TAG = 3791694183000795315792098099581407680958131641292811872617553086713867485913n;
// re-scan the last blocks on every refresh: some RPCs report a block before its logs are queryable (duplicates are
// checked by leaf index, so overlap is harmless)
const RESCAN = 20n;
const KS_LEAF_TOPIC = "0xcb249c8292372bd11f567786635483fca9e635030baafca55ff1a8940141d221"; // (leaf, root, index)

export const vaultAbi = parseAbi([
  "struct TransactParams { address processor; bytes data; }",
  "struct NoteData { bytes32 hint; bytes data; }",
  "struct TransactProof { uint256[2] pA; uint256[2][2] pB; uint256[2] pC; uint256[][] pubSignals; }",
  "function transact(TransactProof proof, TransactParams params, NoteData[] noteData)",
  "function isKnownRoot(uint256) view returns (bool)",
  "function commitments(uint256) view returns (uint256)",
  "function spentNullifiers(uint256) view returns (uint256)",
  "event LeavesInserted(uint256[] _newLeaves, uint256 _root, uint256 _startIndex)",
  "event Deposited(uint256 outputCommitment, address indexed asset, uint256 depositedValue, address indexed caller)",
]);
export const epAbi = parseAbi([
  "struct NoteData { bytes32 hint; bytes data; }",
  "struct DepositProof { uint256[2] pA; uint256[2][2] pB; uint256[2] pC; uint256[4] pubSignals; }",
  "function deposit(DepositProof proof, NoteData noteData, bytes aspCiphertext) payable",
]);
export const ksAbi = parseAbi(["function setAuthPolicy(uint256,uint256)", "function currentRoot() view returns (uint256)"]);
export const arAbi = parseAbi(["function latestASPRoot() view returns (uint256)"]);

export interface Note { value: bigint; noteSecret: bigint; label: bigint; commitment: bigint; timestamp?: bigint }

const rnd = () => hexToBigInt(toHex(crypto.getRandomValues(new Uint8Array(32)))) % FIELD;
const pad = (arr: bigint[], n: number) => [...arr, ...Array(n - arr.length).fill(0n)];
const solProof = (p: any) => ({
  pA: [BigInt(p.pi_a[0]), BigInt(p.pi_a[1])],
  pB: [[BigInt(p.pi_b[0][1]), BigInt(p.pi_b[0][0])], [BigInt(p.pi_b[1][1]), BigInt(p.pi_b[1][0])]],
  pC: [BigInt(p.pi_c[0]), BigInt(p.pi_c[1])],
});

async function loadJson(url: string): Promise<any> {
  if (url.startsWith("file://")) return JSON.parse(fs.readFileSync(new URL(url), "utf8"));
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`);
  return r.json();
}

export class PrivacyPools {
  readonly seedF: bigint;
  readonly owner: bigint;
  readonly nullifyingKey: bigint;
  readonly revocableKey: bigint;

  constructor(private pub: PublicClient, seed: Hex, owner: Address, private opts: { snapshotUrl: string; aspLeavesUrl: string; circuitsDir: string; logChunk: number; scanFrom?: number; logs?: () => Promise<PublicClient> }) {
    this.seedF = hexToBigInt(seed) % FIELD;
    this.owner = BigInt(owner);
    this.nullifyingKey = H([this.seedF, 1n]);
    this.revocableKey = H([this.seedF, 2n]);
  }

  get authDigest() { return H([0n, this.revocableKey]); }
  get nkHash() { return H([this.nullifyingKey]); }
  get keystoreLeaf() { return H([this.owner, this.nkHash, this.authDigest]); }

  // ------------------------------------------------------------ deterministic note secrets
  depositNote(index: number, value: bigint): Note & { depositSecret: bigint } {
    const noteSecret = H([this.seedF, 10n, BigInt(index)]);
    const depositSecret = H([this.seedF, 11n, BigInt(index)]);
    const precommitment = H([H([this.owner, noteSecret]), NATIVE, value, 0n]);
    const label = H([precommitment, depositSecret]);
    return { value, noteSecret, depositSecret, label, commitment: H([precommitment, label]) };
  }

  /** Index of the deposit whose commitment is `commitment` for `value`, among indices < maxIndex (-1 if none).
   *  Used to find this seed's deposits from the pool's public Deposited events (recovery from the seed alone). */
  matchDeposit(commitment: bigint, value: bigint, maxIndex: number): number {
    this.depositKeys ??= [];
    for (let i = 0; i < maxIndex; i++) {
      const k = (this.depositKeys[i] ??= { nah: H([this.owner, H([this.seedF, 10n, BigInt(i)])]), ds: H([this.seedF, 11n, BigInt(i)]) });
      const pre = H([k.nah, NATIVE, value, 0n]);
      if (H([pre, H([pre, k.ds])]) === commitment) return i;
    }
    return -1;
  }
  private depositKeys?: { nah: bigint; ds: bigint }[];

  /** The k-th change note of deposit `index` (k >= 1). Its secret depends only on (seed, index, k); its value is
   *  whatever the previous note held minus that spend's amountOut (any amount). */
  changeNote(index: number, k: number, value: bigint, label: bigint): Note {
    const noteSecret = H([this.seedF, 12n, BigInt(index), BigInt(k)]);
    return { value, noteSecret, label, commitment: H([H([H([this.owner, noteSecret]), NATIVE, value, 0n]), label]) };
  }

  // ------------------------------------------------------------ trees
  private snap?: any;
  private async snapshot() { return (this.snap ??= await loadJson(this.opts.snapshotUrl)); }

  /** The endpoint of the leaf scans: one that serves eth_getLogs (the agent's probed log RPC), else the reads' RPC. */
  private async logPub(): Promise<PublicClient> { return this.opts.logs ? this.opts.logs() : this.pub; }

  private async logsChunked(params: { address: Address; topics?: Hex[]; event?: any }, from: bigint, latest: bigint) {
    const pub = await this.logPub();
    const out: any[] = [];
    for (let a = from; a <= latest; a += BigInt(this.opts.logChunk)) {
      const b = a + BigInt(this.opts.logChunk) - 1n > latest ? latest : a + BigInt(this.opts.logChunk) - 1n;
      if (params.event) out.push(...(await pub.getLogs({ address: params.address, event: params.event, fromBlock: a, toBlock: b })));
      else out.push(...(await pub.request({ method: "eth_getLogs", params: [{ address: params.address, topics: params.topics, fromBlock: toHex(a), toBlock: toHex(b) }] }) as any[]));
    }
    return out;
  }

  private static sorted(xs: any[]) { return xs.slice().sort((a, b) => Number(a.leafIndex) - Number(b.leafIndex)).map((l) => BigInt(l.leaf)); }
  private static lastBlock(xs: any[]) { return xs.reduce((m, l) => (BigInt(l.blockNumber) > m ? BigInt(l.blockNumber) : m), 0n); }

  /** Last block already covered by the snapshot: its snapshotBlockNumber if the chain has reached it (normal case),
   *  else the last leaf's block (e.g. a fork older than the snapshot). MURKFUN_PP_SCAN_FROM overrides (tests). */
  private async scanStart(s: any, leaves: any[]): Promise<bigint> {
    if (this.opts.scanFrom !== undefined) return BigInt(this.opts.scanFrom) - 1n;
    const snap = s.snapshotBlockNumber !== undefined ? BigInt(s.snapshotBlockNumber) : 0n;
    return snap > 0n && snap <= (await this.pub.getBlockNumber()) ? snap : PrivacyPools.lastBlock(leaves);
  }

  // leaves are cached per process and extended incrementally (only new blocks are scanned)
  private stateCache?: { leaves: bigint[]; to: bigint };
  private ksCache?: { leaves: bigint[]; to: bigint };

  async stateLeaves(): Promise<bigint[]> {
    if (!this.stateCache) {
      const s = await this.snapshot();
      this.stateCache = { leaves: PrivacyPools.sorted(s.leaves), to: await this.scanStart(s, s.leaves) };
    }
    const c = this.stateCache, latest = await (await this.logPub()).getBlockNumber();
    const leaves = c.leaves.slice();
    const logs = await this.logsChunked({ address: PV, event: vaultAbi.find((x: any) => x.name === "LeavesInserted") }, c.to + 1n, latest);
    for (const l of logs) {
      const start = Number(l.args._startIndex);
      const add: bigint[] = l.args._newLeaves;
      for (let i = 0; i < add.length; i++) {
        if (start + i < leaves.length) {
          if (leaves[start + i] !== add[i]) {
            this.stateCache = undefined; // a reorg replaced a cached leaf: rebuild from the snapshot next time
            throw new Error("state leaf mismatch (reorg?): cache dropped; retry");
          }
        }
        else if (start + i === leaves.length) leaves.push(add[i]);
        else throw new Error("state leaf index gap (snapshot too old for this RPC?)");
      }
    }
    this.stateCache = { leaves, to: latest - RESCAN > c.to ? latest - RESCAN : c.to };
    return leaves;
  }

  async keystoreLeaves(): Promise<bigint[]> {
    if (!this.ksCache) {
      const s = await this.snapshot();
      this.ksCache = { leaves: PrivacyPools.sorted(s.keystoreLeaves), to: await this.scanStart(s, s.keystoreLeaves) };
    }
    const c = this.ksCache, latest = await (await this.logPub()).getBlockNumber();
    const leaves = c.leaves.slice();
    const logs = await this.logsChunked({ address: KS, topics: [KS_LEAF_TOPIC as Hex] }, c.to + 1n, latest);
    for (const l of logs) {
      const leaf = hexToBigInt(`0x${l.data.slice(2, 66)}`), index = Number(hexToBigInt(`0x${l.data.slice(130, 194)}`));
      if (index < leaves.length) {
        if (leaves[index] !== leaf) {
          this.ksCache = undefined; // a reorg replaced a cached leaf: rebuild from the snapshot next time
          throw new Error("keystore leaf mismatch (reorg?): cache dropped; retry");
        }
      }
      else if (index === leaves.length) leaves.push(leaf);
      else throw new Error("keystore leaf index gap");
    }
    this.ksCache = { leaves, to: latest - RESCAN > c.to ? latest - RESCAN : c.to };
    return leaves;
  }

  async aspLeaves(): Promise<bigint[]> {
    const j = await loadJson(this.opts.aspLeavesUrl);
    return (j.leaves as string[]).map(BigInt);
  }

  /** ASP status of a deposit label: approved only if the published leaves contain it AND match the on-chain root. */
  async aspStatus(label: bigint): Promise<{ approved: boolean; reason?: string }> {
    const leaves = await this.aspLeaves();
    if (!leaves.includes(H([label]))) return { approved: false, reason: "pending: label not yet in the ASP association set" };
    const onchain = await this.pub.readContract({ address: AR, abi: arAbi, functionName: "latestASPRoot" });
    if (tree(leaves).root !== onchain) return { approved: false, reason: "ASP leaves do not match the latest on-chain root yet; retry in a few minutes" };
    return { approved: true };
  }

  /** Keystore leaves checked against the on-chain root (full rescans with a short backoff if they disagree). */
  async verifiedKeystoreLeaves(): Promise<bigint[]> {
    for (let i = 0; ; i++) {
      const leaves = await this.keystoreLeaves();
      const onchain = await this.pub.readContract({ address: KS, abi: ksAbi, functionName: "currentRoot" });
      if (tree(leaves).root === onchain) return leaves;
      console.error(`murkfun: keystore tree mismatch (try ${i}): ${leaves.length} leaves, local root ${tree(leaves).root}, chain ${onchain}`);
      this.ksCache = undefined;
      if (i >= 3) throw new Error("local 0xbow keystore tree does not match the chain (RPC lagging?); retry");
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }

  async isKeystoreRegistered() { return (await this.verifiedKeystoreLeaves()).includes(this.keystoreLeaf); }

  // ------------------------------------------------------------ proofs
  private async prove(circuit: string, input: any) {
    await ensureCircuits(this.opts.circuitsDir, circuit);
    const dir = path.join(this.opts.circuitsDir, circuit);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, path.join(dir, `${circuit}_js/${circuit}.wasm`), path.join(dir, "groth16_pkey.zkey"));
    return { proof, publicSignals: publicSignals.map(BigInt) as bigint[] };
  }

  async depositProof(index: number, value: bigint) {
    const n = this.depositNote(index, value);
    const noteData = { hint: toHex(rnd(), { size: 32 }), data: "0x" as Hex };
    const context = hexToBigInt(keccak256(encodeAbiParameters([{ type: "tuple", components: [{ type: "bytes32", name: "hint" }, { type: "bytes", name: "data" }] }], [noteData]))) % FIELD;
    const { proof, publicSignals } = await this.prove("deposit", { tokenId: NATIVE, value, context, noteAddressHash: H([this.owner, n.noteSecret]), depositSecret: n.depositSecret });
    if (publicSignals[0] !== n.commitment) throw new Error("deposit commitment mismatch");
    return { sol: { ...solProof(proof), pubSignals: publicSignals }, noteData, note: n };
  }

  static transactContext(params: { processor: Address; data: Hex }, noteData: { hint: Hex; data: Hex }[]) {
    return hexToBigInt(keccak256(encodeAbiParameters([
      { type: "tuple", components: [{ type: "address", name: "processor" }, { type: "bytes", name: "data" }] },
      { type: "tuple[]", components: [{ type: "bytes32", name: "hint" }, { type: "bytes", name: "data" }] },
    ], [params, noteData]))) % FIELD;
  }

  /** 1-in/1-out transact spending `note` (must have its timestamp), `amountOut` to the processor; the change
   *  note (deterministic secret) stays in the pool with the same label. */
  async transact(note: Note, change: Note, amountOut: bigint, params: { processor: Address; data: Hex }) {
    if (!note.timestamp) throw new Error("note has no on-chain timestamp yet");
    const noteData = [{ hint: toHex(rnd(), { size: 32 }), data: "0x" as Hex }];
    const context = PrivacyPools.transactContext(params, noteData);
    const [sl, kl, al] = await Promise.all([this.stateLeaves(), this.keystoreLeaves(), this.aspLeaves()]);
    const st = tree(sl), ks = tree(kl), at = tree(al);
    const leaf = H([COMMITMENT_LEAF_TAG, note.commitment, note.timestamp]);
    const si = st.indexOf(leaf), ki = ks.indexOf(this.keystoreLeaf), ai = at.indexOf(H([note.label]));
    if (si < 0) throw new Error("note not found in the 0xbow state tree");
    if (ki < 0) throw new Error("0xbow keystore not registered (the first deposit registers it)");
    if (ai < 0) throw new Error("WAITING_FOR_ASP: deposit not approved by the ASP yet");
    if (!(await this.pub.readContract({ address: PV, abi: vaultAbi, functionName: "isKnownRoot", args: [st.root] }))) {
      this.stateCache = undefined;
      throw new Error("local 0xbow state tree does not match the chain (RPC lagging or snapshot issue); retry");
    }
    if (ks.root !== (await this.pub.readContract({ address: KS, abi: ksAbi, functionName: "currentRoot" }))) {
      this.ksCache = undefined;
      throw new Error("local 0xbow keystore tree does not match the chain (RPC lagging?); retry");
    }
    const onchainAsp = await this.pub.readContract({ address: AR, abi: arAbi, functionName: "latestASPRoot" });
    if (at.root !== onchainAsp) throw new Error("ASP leaves do not match the latest on-chain ASP root yet; retry later");
    const sp = st.generateProof(si), kp = ks.generateProof(ki), ap = at.generateProof(ai);
    const changeNah = H([this.owner, change.noteSecret]);
    const input = {
      stateRoot: st.root, keystoreRoot: ks.root, associationSetRoot: at.root, amountOut, tokenIdOut: amountOut > 0n ? NATIVE : 0n, context,
      ownerAddress: this.owner, privateNullifyingKey: this.nullifyingKey, privateRevocableKey: this.revocableKey,
      keystoreLeafIndex: BigInt(kp.index), keystoreSiblings: pad(kp.siblings, 18), keystoreTreeDepth: BigInt(kp.siblings.length),
      noteSecret: [note.noteSecret], value: [note.value], tokenId: NATIVE, label: [note.label],
      stateLeafIndex: [BigInt(sp.index)], stateSiblings: [pad(sp.siblings, 22)], stateTreeDepth: [BigInt(sp.siblings.length)],
      associationSetLeafIndex: [BigInt(ap.index)], associationSetSiblings: [pad(ap.siblings, 18)], associationSetTreeDepth: [BigInt(ap.siblings.length)],
      timestamp: [note.timestamp],
      outputNoteAddressHash: [changeNah], outputValue: [change.value], outputLabel: [note.label],
    };
    const { proof, publicSignals: s } = await this.prove("transact_1x1", input);
    if (s[1] !== change.commitment) throw new Error("change commitment mismatch");
    return { proof: { ...solProof(proof), pubSignals: [[s[0]], [s[1]], [s[2]], [s[3]], [s[4]], [s[5]], [s[6]], [s[7]]] }, noteData, nullifier: s[0] };
  }

  /** On-chain timestamp of a commitment (0 if it does not exist). */
  commitmentTime(commitment: bigint) {
    return this.pub.readContract({ address: PV, abi: vaultAbi, functionName: "commitments", args: [commitment] });
  }
}
