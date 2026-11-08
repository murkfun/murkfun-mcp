// holders_lookup (src/holdersLookup.ts) on synthetic data: what is reported as verified, and what is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toBytes, toHex, type Address, type Hex } from "viem";
import { ADMIN_REGISTERED, REGISTERED, agentIdOfName, lookupHolder, parseHolderQuery, type LookupDeps } from "../src/holdersLookup.js";
import { batchLevels, globalTree, holderPath, leaf, rootFromPath, BATCH_LOG } from "../src/orders.js";

const addr = (i: number) => getAddress(`0x${(0xa11ce00 + i).toString(16).padStart(40, "0")}`) as Address;
const REGISTRY = addr(500);
const LISTS = [[addr(1), addr(2), addr(3)], [addr(4), addr(5)], [addr(6)]];
const BATCHES = LISTS.map((l) => ({ addrs: l, subtreeRoot: batchLevels(l)[BATCH_LOG][0] }));
const rootAt = (n: number) => globalTree(BATCHES.slice(0, n + 1).map((b) => b.subtreeRoot)).root();
const TX = `0x${"ab".repeat(32)}` as Hex;

function mintLog(a: Address, admin = false) {
  const ev = admin ? ADMIN_REGISTERED : REGISTERED;
  return { address: REGISTRY, topics: encodeEventTopics({ abi: [ev], eventName: ev.name, args: { labelhash: keccak256(toBytes("x")), owner: a } } as never) as Hex[], data: encodeAbiParameters([{ type: "string" }], ["x"]) };
}

function deps(accepted: number | null, o: { api?: boolean; logs?: boolean; admin?: boolean; tamper?: boolean } = {}): LookupDeps {
  return {
    registry: REGISTRY,
    ownerOfName: async (n) => (n === "alice" ? addr(5) : null),
    handleOf: async (a) => (a === addr(5) ? "alice" : ""),
    balanceOf: async () => 1n,
    acceptedRoot: async () => (accepted === null ? [0n, 0n] as const : [rootAt(accepted), BigInt(accepted)] as const),
    batchInfo: async (id) => ({ postedAt: 1_000 + id, usableFrom: 4_600 + id }),
    batches: async () => {
      if (o.logs === false) throw new Error("NO_LOG_RPC: none of the endpoints serves eth_getLogs");
      return BATCHES;
    },
    api: async (a) => {
      if (!o.api) return undefined;
      const b = LISTS.findIndex((l) => l.includes(a));
      const acc = accepted !== null && b >= 0 && b <= accepted;
      const p = acc ? holderPath(BATCHES.slice(0, accepted! + 1), a)! : undefined;
      const sib = p?.siblings.map((s) => toHex(s, { size: 32 })) ?? [];
      if (o.tamper && sib.length) sib[2] = toHex(7n, { size: 32 });
      return {
        address: a, status: b >= 0 ? "included" : "pending", batch: b >= 0 ? b : null, position: b >= 0 ? LISTS[b].indexOf(a) : null, accepted: acc, usableFrom: null,
        proof: p ? { leaf: toHex(leaf(a), { size: 32 }), leafIndex: p.index.toString(), siblings: sib, root: toHex(p.root, { size: 32 }), rootBatch: accepted!, batchRoot: "0x0" } : null,
        mint: { tx: TX },
      };
    },
    receiptLogs: async () => [mintLog(addr(5), o.admin), mintLog(addr(77), o.admin)],
  };
}

test("holders_lookup queries: address, name, name.ai; anything else refused", () => {
  assert.deepEqual(parseHolderQuery(" alice.AI "), { kind: "name", name: "alice" });
  assert.equal(parseHolderQuery(addr(1).toLowerCase()).kind, "address");
  assert.throws(() => parseHolderQuery(`0x${"a".repeat(39)}`), /BAD_QUERY/);
  assert.throws(() => parseHolderQuery("a b"), /BAD_QUERY/);
  assert.equal(agentIdOfName("alice"), BigInt(keccak256(toBytes("alice"))));
});

test("holders_lookup: an accepted holder by name, everything verified, path reaches acceptedRoot", async () => {
  const r = await lookupHolder("alice.ai", deps(1, { api: true }));
  assert.deepEqual([r.address, r.handle, r.origin, r.member, r.batch, r.position, r.accepted, r.usableFrom], [addr(5), "alice.ai", "register", true, 1, 1, true, 4_601]);
  assert.deepEqual(r.verified, { registry: true, origin: true, membership: true, path: true });
  assert.equal(rootFromPath(leaf(addr(5)), BigInt(r.path!.leafIndex), r.path!.siblings.map(BigInt)), rootAt(1));
});

test("holders_lookup: a batch in its challenge window is a member, not accepted, no path", async () => {
  const r = await lookupHolder(addr(6), deps(1, { api: true }));
  assert.deepEqual([r.member, r.batch, r.accepted, r.path], [true, 2, false, null]);
  assert.match(r.notes.join(";"), /challenge window/);
});

test("holders_lookup without a log RPC: the API's proof counts only if it reaches acceptedRoot", async () => {
  const ok = await lookupHolder(addr(2), deps(1, { api: true, logs: false }));
  assert.deepEqual([ok.member, ok.verified.membership, ok.verified.path], [true, true, true]);
  const bad = await lookupHolder(addr(2), deps(1, { api: true, logs: false, tamper: true }));
  assert.deepEqual([bad.member, bad.verified.membership, bad.verified.path, bad.path], [true, false, false, null]);
  assert.match(bad.notes.join(";"), /does not reach acceptedRoot/);
});

test("holders_lookup: admin-minted, unknown names, no API", async () => {
  const adm = await lookupHolder(addr(5), deps(1, { api: true, admin: true }));
  assert.equal(adm.origin, "admin");
  const none = await lookupHolder("bob", deps(1, { api: true }));
  assert.equal(none.address, null);
  assert.match(none.notes.join(";"), /no Agent ID named bob\.ai/);
  const chainOnly = await lookupHolder(addr(3), deps(2));
  assert.deepEqual([chainOnly.source, chainOnly.member, chainOnly.accepted, chainOnly.verified.path, chainOnly.origin], ["chain", true, true, true, null]);
});
