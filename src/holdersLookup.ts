// holders_lookup: one entry of MurkFun's holder set (an address, an Agent ID name or name.ai), read-only, no wallet and
// no vault. The holder-set API (MURKFUN_HOLDERS_API) is only a hint; every fact is checked before it is reported as
// verified:
//   - owner / handle / holds an Agent ID: the SPACE ID registry on chain (ownerOf, handleOf, balanceOf);
//   - origin (register = in the set, adminRegister = never in it): the registry's event in the mint transaction's
//     receipt the API names;
//   - batch / position / accepted / usableFrom: the holder set's Batch events (an RPC that serves eth_getLogs) rebuilt
//     into the tree, whose accepted root must equal MurkFunHolderRoots.acceptedRoot(); without such an RPC the API's
//     answer is returned with verified.membership false;
//   - the path: leaf = H(address), the siblings reach acceptedRoot() (the root orders prove against).
// The same checks as `murkfun-holders lookup` (github.com/murkfun/holder-roots).
import { decodeEventLog, getAddress, keccak256, parseAbiItem, toBytes, toHex, type Address, type Hex } from "viem";
import { holderPath, leaf, rootFromPath, globalTree, DEPTH, BATCH_SIZE, FIELD } from "./orders.js";
import type { HolderLookup } from "./holdersApi.js";

export type HolderQuery = { kind: "address"; address: Address } | { kind: "name"; name: string };

/** `q`: 0x + 40 hex digits, or an Agent ID name with or without `.ai`. */
export function parseHolderQuery(q: string): HolderQuery {
  const s = String(q ?? "").trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { kind: "address", address: getAddress(s) };
  if (/^0x[0-9a-fA-F]{36,}$/.test(s)) throw new Error(`BAD_QUERY: not an address (0x and 40 hex digits): ${s}`);
  const name = s.toLowerCase().replace(/\.ai$/, "");
  if (/^[a-z0-9]{1,64}$/.test(name)) return { kind: "name", name };
  throw new Error("BAD_QUERY: query must be a 0x address, an Agent ID name or name.ai");
}

export const REGISTERED = parseAbiItem("event Registered(bytes32 indexed labelhash, address indexed owner, string handle)");
export const ADMIN_REGISTERED = parseAbiItem("event AdminRegistered(bytes32 indexed labelhash, address indexed owner, string handle)");

/** What the lookup reads; injected so it can be checked without a chain. */
export interface LookupDeps {
  /** SPACE ID registry views. */
  ownerOfName(name: string): Promise<Address | null>;
  handleOf(a: Address): Promise<string>;
  balanceOf(a: Address): Promise<bigint>;
  /** MurkFunHolderRoots.acceptedRoot() (root 0: none accepted yet) and batch views. */
  acceptedRoot(): Promise<readonly [bigint, bigint]>;
  batchInfo(id: number): Promise<{ postedAt: number; usableFrom: number }>;
  /** Every live batch from the Batch events; throws without an RPC that serves eth_getLogs. */
  batches(): Promise<{ addrs: Address[]; subtreeRoot: bigint }[]>;
  /** The holder-set API's answer, or undefined (off, down, garbage). */
  api(a: Address): Promise<(HolderLookup & { mint?: { tx?: string } | null; position?: number | null }) | undefined>;
  /** Logs of a mint transaction's receipt (the registry's events among them). */
  receiptLogs(tx: Hex): Promise<{ address: Address; data: Hex; topics: readonly Hex[] }[]>;
  registry: Address;
}

const fhex = (x: bigint) => toHex(x, { size: 32 });

export async function lookupHolder(query: string, d: LookupDeps) {
  const q = parseHolderQuery(query);
  const out = {
    query: String(query).trim(), address: null as Address | null, handle: null as string | null, holdsAgentId: false,
    origin: null as "register" | "admin" | null, mintTx: null as string | null,
    member: false, batch: null as number | null, position: null as number | null, accepted: false, usableFrom: null as number | null,
    acceptedBatch: null as number | null, acceptedRoot: null as string | null,
    path: null as { leaf: string; leafIndex: string; siblings: string[]; root: string } | null,
    source: "chain" as "chain" | "api",
    verified: { registry: false, origin: false, membership: false, path: false },
    notes: [] as string[],
  };
  if (q.kind === "name") {
    const owner = await d.ownerOfName(q.name);
    out.verified.registry = true;
    if (!owner) {
      out.notes.push(`no Agent ID named ${q.name}.ai`);
      return out;
    }
    out.address = owner;
    out.handle = `${q.name}.ai`;
    out.holdsAgentId = true;
  } else {
    out.address = q.address;
    const [h, bal] = await Promise.all([d.handleOf(q.address).catch(() => ""), d.balanceOf(q.address).catch(() => 0n)]);
    out.handle = h ? `${h}.ai` : null;
    out.holdsAgentId = bal > 0n;
    out.verified.registry = true;
  }
  const a = out.address!;
  const [accRoot, accId] = await d.acceptedRoot();
  const acceptedBatch = accRoot === 0n ? null : Number(accId);
  out.acceptedBatch = acceptedBatch;
  out.acceptedRoot = acceptedBatch === null ? null : fhex(accRoot);

  const hint = await d.api(a).catch(() => undefined);
  if (hint) out.source = "api";

  // origin: the mint transaction's receipt
  const tx = hint?.mint?.tx;
  if (typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx)) {
    const logs = await d.receiptLogs(tx as Hex).catch(() => []);
    for (const l of logs) {
      if (getAddress(l.address) !== d.registry) continue;
      try {
        const ev = decodeEventLog({ abi: [REGISTERED, ADMIN_REGISTERED], data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        if (getAddress((ev.args as { owner: Address }).owner) !== a) continue;
        out.origin = ev.eventName === "Registered" ? "register" : "admin";
        out.mintTx = tx;
        out.verified.origin = true;
        break;
      } catch {
        // another event of the registry
      }
    }
    if (!out.verified.origin) out.notes.push("the API's mint transaction holds no registration of this address: origin unknown");
  }

  // membership and path: the Batch events, rebuilt and checked against acceptedRoot()
  let list: { addrs: Address[]; subtreeRoot: bigint }[] | undefined;
  try {
    list = await d.batches();
  } catch (e) {
    out.notes.push(`Batch events not readable (${(e as Error).message.split("\n")[0].slice(0, 160)}): membership from the holder-set API, unverified`);
  }
  if (list) {
    if (acceptedBatch !== null && (list.length <= acceptedBatch || globalTree(list.slice(0, acceptedBatch + 1).map((b) => b.subtreeRoot)).root() !== accRoot)) {
      out.notes.push("the Batch events from the RPC do not rebuild acceptedRoot() (RPC lagging or missing logs?): membership unverified");
      list = undefined;
    }
  }
  if (list) {
    out.verified.membership = true;
    const p = holderPath(list, a);
    if (p) {
      out.member = true;
      out.batch = p.batch;
      out.position = Number(p.index - BigInt(p.batch) * BigInt(BATCH_SIZE));
      out.accepted = acceptedBatch !== null && p.batch <= acceptedBatch;
      if (out.accepted) {
        const q2 = holderPath(list.slice(0, acceptedBatch! + 1), a)!;
        if (q2.root === accRoot && rootFromPath(leaf(a), q2.index, q2.siblings) === accRoot) {
          out.path = { leaf: fhex(leaf(a)), leafIndex: q2.index.toString(), siblings: q2.siblings.map(fhex), root: fhex(accRoot) };
          out.verified.path = true;
        }
      }
    }
  } else if (hint && typeof hint.batch === "number") {
    out.member = true;
    out.batch = hint.batch;
    out.position = typeof hint.position === "number" ? hint.position : null;
    out.accepted = acceptedBatch !== null && hint.batch <= acceptedBatch;
    const pr = hint.proof;
    if (out.accepted && pr) {
      try {
        const siblings = pr.siblings.map((s) => BigInt(s));
        const index = BigInt(pr.leafIndex);
        if (siblings.length === DEPTH && siblings.every((s) => s >= 0n && s < FIELD) && BigInt(pr.leaf) === leaf(a) && rootFromPath(leaf(a), index, siblings) === accRoot) {
          // the path reaches the on-chain accepted root: membership is proven by it, whatever the RPC could not scan
          out.path = { leaf: fhex(leaf(a)), leafIndex: index.toString(), siblings: siblings.map(fhex), root: fhex(accRoot) };
          out.verified.path = true;
          out.verified.membership = true;
          out.batch = Number(index / BigInt(BATCH_SIZE));
          out.position = Number(index % BigInt(BATCH_SIZE));
        } else out.notes.push("the API's proof does not reach acceptedRoot(): ignored");
      } catch {
        out.notes.push("the API's proof is malformed: ignored");
      }
    }
  }
  if (out.batch !== null) out.usableFrom = (await d.batchInfo(out.batch).catch(() => undefined))?.usableFrom ?? null;
  if (!out.member && out.origin === "admin") out.notes.push("minted with adminRegister: never part of the holder set");
  else if (!out.member && out.holdsAgentId) out.notes.push("not in the holder set yet: the operator adds new Agent ID holders in batches (usable 1 h after posting)");
  else if (out.member && !out.accepted) out.notes.push(`in batch ${out.batch}, still in its challenge window${out.usableFrom ? ` (usable from ${new Date(out.usableFrom * 1000).toISOString()})` : ""}`);
  return out;
}

/** The SPACE ID token id of a name (the part before ".ai"). */
export const agentIdOfName = (name: string) => BigInt(keccak256(toBytes(name)));
