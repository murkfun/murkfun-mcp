// The wallet's holder path from MurkFun's public holder-set API (GET /v1/holders/lookup, docs/API.md "Holder set"),
// trust-minimised: the API is only a hint. Its proof is used only if the leaf is H(this wallet), the 26 siblings lead
// from it to the proof's root (Poseidon2, the circuit's own hashing) and that root is the holder set's latest accepted
// root on chain (agent.ts compares it with MurkFunHolderRoots.acceptedRoot()). Anything else, and an API that is down
// or answers garbage, sends the MCP to the Batch-log scan (logRpc.ts). A wrong API can make the MCP fall back, never
// make it prove against a root or a leaf that is not the wallet's.
import { getAddress, type Address } from "viem";
import { DEPTH, BATCH_SIZE, FIELD, leaf, rootFromPath, type HolderPath } from "./orders.js";

/** What /v1/holders/lookup answers (only the fields used here). */
export interface HolderLookup {
  address: string | null;
  status: string;
  batch: number | null;
  accepted: boolean;
  usableFrom: number | null;
  proof: { leaf: string; leafIndex: string; siblings: string[]; root: string; rootBatch: number; batchRoot: string } | null;
}

/** GET <base>/v1/holders/lookup?q=<address>. Throws on a network error, a non-200 answer or a body that is not JSON. */
export async function fetchHolderLookup(base: string, address: Address, timeoutMs = 15_000): Promise<HolderLookup> {
  const url = `${base.replace(/\/+$/, "")}/v1/holders/lookup?q=${getAddress(address)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as HolderLookup;
}

const field = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !/^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(v)) throw new Error(`${what} is not a field element`);
  const x = BigInt(v);
  if (x >= FIELD) throw new Error(`${what} is not a field element`);
  return x;
};

/** `address`'s path from an API proof, checked locally (leaf = H(address), siblings reach the root), or throws why
 *  not. The root still has to be checked on chain by the caller. */
export function verifyHolderProof(lookup: HolderLookup, address: Address): HolderPath {
  const p = lookup?.proof;
  if (!p) throw new Error("no proof in the answer");
  if (!Array.isArray(p.siblings) || p.siblings.length !== DEPTH) throw new Error(`the proof has ${Array.isArray(p.siblings) ? p.siblings.length : "no"} siblings, not ${DEPTH}`);
  const lf = field(p.leaf, "leaf");
  if (lf !== leaf(getAddress(address))) throw new Error("the proof's leaf is not this wallet's");
  if (typeof p.leafIndex !== "string" || !/^\d{1,9}$/.test(p.leafIndex)) throw new Error("leafIndex is not an index");
  const index = BigInt(p.leafIndex);
  if (index >= 1n << BigInt(DEPTH)) throw new Error("leafIndex is outside the tree");
  const siblings = p.siblings.map((s, i) => field(s, `sibling ${i}`));
  const root = field(p.root, "root");
  if (rootFromPath(lf, index, siblings) !== root) throw new Error("the proof does not reach its root");
  return { index, siblings, root, batch: Number(index / BigInt(BATCH_SIZE)) };
}

/** The API's own reason the wallet has no usable proof (not verifiable on chain without the Batch logs), or undefined
 *  when the answer says nothing usable. */
export function lookupClaim(lookup: HolderLookup, wallet: Address): string | undefined {
  switch (lookup?.status) {
    case "included":
      if (lookup.accepted) return undefined;
      // only numbers from the API reach the text (third-party strings never do)
      return `NOT_ACCEPTED_YET: your wallet is in holder batch ${Number.isSafeInteger(lookup.batch) ? lookup.batch : "?"}, which is still in its challenge window${typeof lookup.usableFrom === "number" && Number.isFinite(lookup.usableFrom) && Math.abs(lookup.usableFrom) < 1e11 ? ` (usable from ${new Date(lookup.usableFrom * 1000).toISOString()})` : ""}: try again later`;
    case "pending":
    case "not_holder":
    case "admin_minted":
    case "challengeable":
      return `NOT_A_HOLDER_YET: ${wallet} is not in the holder set yet (holder-set API status "${lookup.status}"). New Agent ID holders are added by the holder-set operator's next batch (no transaction from you); status shows holderSet.`;
    default:
      return undefined;
  }
}
