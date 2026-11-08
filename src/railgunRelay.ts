// Railgun-paid orders through the relayer (relayer orders railgunBuy / railgunFund / railgunLaunch, docs/RELAYER_API.md
// "Railgun-paid orders"): the JSON body the relayer takes once the Railgun wallet has proved the unshield, and the
// Railgun transactions as a user brings them (JSON objects as the Railgun engine builds them, or calldata) turned into
// the relayer's wire format, checked against the order they must be bound to. No chain, no vault.
import fs from "fs";
import { decodeFunctionData, getAbiItem, getAddress, isAddress, isHex, toFunctionSelector, type AbiFunction, type AbiParameter, type Address, type Hex } from "viem";
import { railgunAdapterAbi } from "./abi.js";

/** The relayer actions of a Railgun-paid order. */
export type RailgunRelayAction = "railgunBuy" | "railgunFund" | "railgunLaunch";

/** IRailgun.Transaction in the relayer's wire format (numbers as decimal strings, bytes as 0x hex). */
export interface WireRailgunTx {
  proof: { a: { x: string; y: string }; b: { x: string[]; y: string[] }; c: { x: string; y: string } };
  merkleRoot: Hex; nullifiers: Hex[]; commitments: Hex[];
  boundParams: {
    treeNumber: string; minGasPrice: string; unshield: string; chainID: string; adaptContract: Address; adaptParams: Hex;
    commitmentCiphertext: { ciphertext: Hex[]; blindedSenderViewingKey: Hex; blindedReceiverViewingKey: Hex; annotationData: Hex; memo: Hex }[];
  };
  unshieldPreimage: { npk: Hex; token: { tokenType: string; tokenAddress: Address; tokenSubID: string }; value: string };
}

/** The relayer's caps on a Railgun-paid order (the relayer's RAILGUN_LIMITS; docs/RELAYER_API.md "Railgun-paid orders"):
 *  transactions per order, nullifiers / commitments / commitment ciphertexts per transaction, and the bytes of each
 *  ciphertext's annotation data and memo. Checked here before anything is expanded. */
export const RAILGUN_LIMITS = { transactions: 8, nullifiers: 16, commitments: 16, annotationBytes: 1024, memoBytes: 2048 } as const;
/** At most this many Railgun transactions per order (the relayer's cap). */
export const MAX_RAILGUN_TXS = RAILGUN_LIMITS.transactions;
/** The most input submit_railgun reads (characters of JSON or 0x calldata, or a file's bytes): twice the relayer's
 *  default body cap (128 KiB, RELAYER_MAX_BODY_BYTES), since calldata hex takes two characters a byte. */
export const MAX_RAILGUN_INPUT = 262_144;
/** The most bytes a calldata's arrays and byte strings may decode to in total. Offsets may point several array
 *  elements at one large value, so the decoded size is counted as it is walked, not taken from the calldata length. */
const MAX_DECODED_BYTES = 1_048_576;

export class RailgunTxError extends Error {}

/** Railgun's `transact(Transaction[])`, with the adapter's own Transaction type. */
const executeItem = getAbiItem({ abi: railgunAdapterAbi, name: "execute" }) as { inputs: readonly unknown[] };
const transactAbi = [{ type: "function", name: "transact", stateMutability: "nonpayable", inputs: [executeItem.inputs[0]], outputs: [] }] as const;
const CALLDATA_ABI = [...railgunAdapterAbi, ...transactAbi] as const;

/** A number as the Railgun engine / ethers / viem may serialize it: a bigint, a JS number, a decimal or 0x string,
 *  ethers' `{ type: "BigNumber", hex }` or `{ _hex }`. */
function dec(x: unknown, field: string): string {
  if (typeof x === "bigint" && x >= 0n) return x.toString();
  if (typeof x === "number" && Number.isSafeInteger(x) && x >= 0) return String(x);
  if (typeof x === "string" && /^(0|[1-9][0-9]*)$/.test(x)) return x;
  if (typeof x === "string" && /^0x[0-9a-fA-F]+$/.test(x)) return BigInt(x).toString();
  const h = (x as { hex?: unknown; _hex?: unknown } | null)?.hex ?? (x as { _hex?: unknown } | null)?._hex;
  if (typeof h === "string" && /^0x[0-9a-fA-F]+$/.test(h)) return BigInt(h).toString();
  throw new RailgunTxError(`${field}: expected a non-negative integer`);
}
/** A bytes32 (a 0x string, or a number the engine kept as a bigint). */
function b32(x: unknown, field: string): Hex {
  if (typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x)) return x.toLowerCase() as Hex;
  if (typeof x === "string" && /^0x[0-9a-fA-F]{1,63}$/.test(x)) return `0x${x.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
  try {
    const v = BigInt(dec(x, field));
    if (v < 2n ** 256n) return `0x${v.toString(16).padStart(64, "0")}` as Hex;
  } catch { /* below */ }
  throw new RailgunTxError(`${field}: expected bytes32`);
}
function bytes(x: unknown, field: string, max: number): Hex {
  if (x === undefined || x === null || x === "") return "0x";
  if (typeof x === "string" && x.length > 2 + 2 * max) throw new RailgunTxError(`${field}: more than ${max} bytes (the relayer's limit)`);
  if (typeof x === "string" && isHex(x) && x.length % 2 === 0) return x.toLowerCase() as Hex;
  throw new RailgunTxError(`${field}: expected 0x bytes`);
}
function address(x: unknown, field: string): Address {
  if (typeof x === "string" && isAddress(x, { strict: false })) return getAddress(x);
  throw new RailgunTxError(`${field}: expected an address`);
}
/** An array of `min` - `max` elements (checked before any element is read). */
function list(x: unknown, field: string, min = 0, max = Infinity): unknown[] {
  if (!Array.isArray(x)) throw new RailgunTxError(`${field}: expected an array`);
  if (x.length < min || x.length > max) {
    throw new RailgunTxError(`${field}: expected ${min === max ? min : `${min}-${max}`} element${max === 1 ? "" : "s"}, got ${x.length}${max < Infinity ? " (the relayer's limit)" : ""}`);
  }
  return x;
}

/** One Railgun transaction (a JSON object or a decoded calldata struct) in the relayer's wire format. */
export function wireRailgunTx(x: unknown, i: number): WireRailgunTx {
  const f = `transactions[${i}]`;
  const t = (x ?? {}) as Record<string, any>;
  const p = (t.proof ?? {}) as Record<string, any>;
  const g1 = (g: any, n: string) => ({ x: dec(g?.x, `${f}.proof.${n}.x`), y: dec(g?.y, `${f}.proof.${n}.y`) });
  const g2 = (v: unknown, n: string) => list(v, `${f}.proof.b.${n}`, 2, 2).map((e, k) => dec(e, `${f}.proof.b.${n}[${k}]`));
  const b = (t.boundParams ?? {}) as Record<string, any>;
  const u = (t.unshieldPreimage ?? {}) as Record<string, any>;
  return {
    proof: { a: g1(p.a, "a"), b: { x: g2(p.b?.x, "x"), y: g2(p.b?.y, "y") }, c: g1(p.c, "c") },
    merkleRoot: b32(t.merkleRoot, `${f}.merkleRoot`),
    nullifiers: list(t.nullifiers, `${f}.nullifiers`, 1, RAILGUN_LIMITS.nullifiers).map((n, k) => b32(n, `${f}.nullifiers[${k}]`)),
    commitments: list(t.commitments, `${f}.commitments`, 1, RAILGUN_LIMITS.commitments).map((n, k) => b32(n, `${f}.commitments[${k}]`)),
    boundParams: {
      treeNumber: dec(b.treeNumber, `${f}.boundParams.treeNumber`), minGasPrice: dec(b.minGasPrice, `${f}.boundParams.minGasPrice`),
      unshield: dec(b.unshield, `${f}.boundParams.unshield`), chainID: dec(b.chainID, `${f}.boundParams.chainID`),
      adaptContract: address(b.adaptContract, `${f}.boundParams.adaptContract`), adaptParams: b32(b.adaptParams, `${f}.boundParams.adaptParams`),
      commitmentCiphertext: list(b.commitmentCiphertext ?? [], `${f}.boundParams.commitmentCiphertext`, 0, RAILGUN_LIMITS.commitments).map((c: any, k) => {
        const cf = `${f}.boundParams.commitmentCiphertext[${k}]`;
        return {
          ciphertext: list(c?.ciphertext, `${cf}.ciphertext`, 4, 4).map((v, j) => b32(v, `${cf}.ciphertext[${j}]`)),
          blindedSenderViewingKey: b32(c?.blindedSenderViewingKey, `${cf}.blindedSenderViewingKey`),
          blindedReceiverViewingKey: b32(c?.blindedReceiverViewingKey, `${cf}.blindedReceiverViewingKey`),
          annotationData: bytes(c?.annotationData, `${cf}.annotationData`, RAILGUN_LIMITS.annotationBytes),
          memo: bytes(c?.memo, `${cf}.memo`, RAILGUN_LIMITS.memoBytes),
        };
      }),
    },
    unshieldPreimage: {
      npk: b32(u.npk, `${f}.unshieldPreimage.npk`),
      token: {
        tokenType: dec(u.token?.tokenType, `${f}.unshieldPreimage.token.tokenType`), tokenAddress: address(u.token?.tokenAddress, `${f}.unshieldPreimage.token.tokenAddress`),
        tokenSubID: dec(u.token?.tokenSubID ?? 0, `${f}.unshieldPreimage.token.tokenSubID`),
      },
      value: dec(u.value, `${f}.unshieldPreimage.value`),
    },
  };
}

/** The Railgun transactions as the user has them: a JSON array (or a JSON string of one) of Railgun Transaction
 *  objects, `{ transactions: [...] }`, or 0x calldata of Railgun's `transact(Transaction[])` or of the adapter's
 *  `execute` / `launch` (the transactions are taken from it). */
export function parseRailgunTxs(input: unknown): WireRailgunTx[] {
  let x = input;
  if (typeof x === "string") {
    if (x.length > MAX_RAILGUN_INPUT) throw new RailgunTxError(`transactions: more than ${MAX_RAILGUN_INPUT} characters (a Railgun-paid order is far smaller; the relayer takes at most ~128 KiB)`);
    const s = x.trim();
    if (s.startsWith("0x")) {
      if (!isHex(s) || s.length % 2 !== 0) throw new RailgunTxError("transactions: 0x calldata that is not even-length hex");
      preflightCalldata(s as Hex);
      let d;
      try { d = decodeFunctionData({ abi: CALLDATA_ABI, data: s as Hex }); } catch {
        throw new RailgunTxError("transactions: 0x calldata that is not Railgun's transact(...) nor MurkFun's Railgun adapter execute(...) / launch(...)");
      }
      x = d.functionName === "launch" ? (d.args as readonly unknown[])[1] : (d.args as readonly unknown[])[0];
    } else {
      try { x = JSON.parse(s); } catch { throw new RailgunTxError("transactions: neither JSON nor 0x calldata"); }
    }
  }
  if (x && typeof x === "object" && !Array.isArray(x) && Array.isArray((x as { transactions?: unknown }).transactions)) x = (x as { transactions: unknown }).transactions;
  if (x && typeof x === "object" && !Array.isArray(x)) x = [x];
  if (!Array.isArray(x)) throw new RailgunTxError("transactions: expected an array");
  if (x.length === 0 || x.length > MAX_RAILGUN_TXS) throw new RailgunTxError(`transactions: expected 1-${MAX_RAILGUN_TXS} Railgun transactions`);
  return x.map((t, i) => wireRailgunTx(t, i));
}

/** Per array / byte-string parameter name: the relayer's bounds (RAILGUN_LIMITS). Other byte strings (the order proof,
 *  the token spec's strings) are bounded by the calldata itself and by the decoded-size budget. */
const ARRAY_BOUNDS: Record<string, [number, number]> = {
  transactions: [1, RAILGUN_LIMITS.transactions], nullifiers: [1, RAILGUN_LIMITS.nullifiers], commitments: [1, RAILGUN_LIMITS.commitments],
  commitmentCiphertext: [0, RAILGUN_LIMITS.commitments],
};
const BYTES_BOUNDS: Record<string, number> = { annotationData: RAILGUN_LIMITS.annotationBytes, memo: RAILGUN_LIMITS.memoBytes };
const isDynamic = (p: AbiParameter): boolean => {
  if (p.type === "bytes" || p.type === "string" || p.type.endsWith("[]")) return true;
  const fixed = p.type.match(/^(.*)\[(\d+)\]$/);
  if (fixed) return isDynamic({ ...p, type: fixed[1] } as AbiParameter);
  return p.type === "tuple" && ((p as { components?: readonly AbiParameter[] }).components ?? []).some(isDynamic);
};
/** Words a static parameter takes in its head. */
const staticWords = (p: AbiParameter): number => {
  const fixed = p.type.match(/^(.*)\[(\d+)\]$/);
  if (fixed) return Number(fixed[2]) * staticWords({ ...p, type: fixed[1] } as AbiParameter);
  if (p.type === "tuple") return ((p as { components?: readonly AbiParameter[] }).components ?? []).reduce((a, c) => a + staticWords(c), 0);
  return 1;
};

/** Walks calldata of Railgun's transact or the adapter's execute / launch as the ABI decoder would, before it does:
 *  every offset and length must lie inside the calldata, each array and byte string named in ARRAY_BOUNDS /
 *  BYTES_BOUNDS within the relayer's limits, and everything the decoder would build at most MAX_DECODED_BYTES in total
 *  (aliased offsets count once per use). Only then is the calldata decoded (a few hundred KB of calldata with aliased
 *  offsets could otherwise expand into many megabytes). */
export function preflightCalldata(data: Hex) {
  const buf = Buffer.from(data.slice(2), "hex");
  const fn = (CALLDATA_ABI as readonly { type: string }[]).find(
    (x) => x.type === "function" && buf.length >= 4 && toFunctionSelector(x as AbiFunction) === `0x${buf.subarray(0, 4).toString("hex")}`,
  ) as AbiFunction | undefined;
  if (!fn) throw new RailgunTxError("transactions: 0x calldata that is not Railgun's transact(...) nor MurkFun's Railgun adapter execute(...) / launch(...)");
  const body = buf.subarray(4);
  let budget = MAX_DECODED_BYTES;
  const spend = (n: number, field: string) => {
    budget -= n;
    if (budget < 0) throw new RailgunTxError(`transactions: the calldata decodes to more than ${MAX_DECODED_BYTES} bytes (at ${field}); a Railgun-paid order is far smaller`);
  };
  const word = (at: number, field: string): number => {
    if (at < 0 || at + 32 > body.length) throw new RailgunTxError(`transactions: truncated calldata (${field})`);
    const w = body.subarray(at, at + 32);
    // offsets and lengths: at most the calldata's own size, so 4 bytes are plenty
    if (w.subarray(0, 28).some((b) => b !== 0)) throw new RailgunTxError(`transactions: an offset or length out of range (${field})`);
    return w.readUInt32BE(28);
  };
  const walk = (p: AbiParameter, at: number, field: string, depth: number): void => {
    if (depth > 8) throw new RailgunTxError(`transactions: calldata nested too deep (${field})`);
    const name = p.name ?? "";
    if (p.type === "bytes" || p.type === "string") {
      const len = word(at, field);
      const max = BYTES_BOUNDS[name];
      if (max !== undefined && len > max) throw new RailgunTxError(`${field}: more than ${max} bytes (the relayer's limit)`);
      if (at + 32 + len > body.length) throw new RailgunTxError(`transactions: truncated calldata (${field})`);
      spend(len, field);
      return;
    }
    const dyn = p.type.match(/^(.*)\[\]$/), fixed = p.type.match(/^(.*)\[(\d+)\]$/);
    if (dyn || fixed) {
      const el = { ...p, type: (dyn ?? fixed)![1] } as AbiParameter;
      const n = dyn ? word(at, field) : Number(fixed![2]);
      const [min, max] = dyn ? ARRAY_BOUNDS[name] ?? [0, Infinity] : [n, n];
      if (n < min || n > max) throw new RailgunTxError(`${field}: expected ${min}-${max} elements, got ${n} (the relayer's limit)`);
      const start = dyn ? at + 32 : at;
      const head = isDynamic(el) ? 1 : staticWords(el);
      if (start + n * head * 32 > body.length) throw new RailgunTxError(`transactions: truncated calldata (${field})`);
      spend(32 * n * head, field);
      for (let i = 0; i < n; i++) {
        const h = start + i * head * 32;
        walk(el, isDynamic(el) ? start + word(h, `${field}[${i}]`) : h, `${field}[${i}]`, depth + 1);
      }
      return;
    }
    if (p.type === "tuple") {
      let h = at;
      for (const c of (p as { components: readonly AbiParameter[] }).components) {
        const f = `${field}.${c.name ?? "?"}`;
        if (isDynamic(c)) {
          walk(c, at + word(h, f), f, depth + 1);
          h += 32;
        } else {
          walk(c, h, f, depth + 1);
          h += 32 * staticWords(c);
        }
      }
      return;
    }
    if (at + 32 > body.length) throw new RailgunTxError(`transactions: truncated calldata (${field})`);
  };
  walk({ type: "tuple", name: "", components: fn.inputs } as AbiParameter, 0, fn.name, 0);
}

/** submit_railgun's transactionsFile: a regular file of at most MAX_RAILGUN_INPUT bytes, its size checked before it is
 *  read. */
export function readRailgunTxFile(file: string): string {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch (e) { throw new RailgunTxError(`transactionsFile: ${(e as NodeJS.ErrnoException).code ?? "unreadable"}`); }
  if (!st.isFile()) throw new RailgunTxError("transactionsFile: not a regular file");
  if (st.size > MAX_RAILGUN_INPUT) throw new RailgunTxError(`transactionsFile: ${st.size} bytes, more than ${MAX_RAILGUN_INPUT} (a Railgun-paid order is far smaller)`);
  return fs.readFileSync(file, "utf8");
}

/** The binding the relayer and the adapter require, checked here first for a clear answer: each transaction names the
 *  adapter (`adaptContract`) and this order (`adaptParams`), unshields WBNB (NORMAL) to the adapter, and the gross
 *  values add up to what the order was built for (`grossWei`, at the unshield fee read then). */
export function checkRailgunTxs(txs: WireRailgunTx[], want: { adapter: Address; adaptParams: Hex; wbnb: Address; grossWei?: bigint }) {
  const npk = `0x${want.adapter.slice(2).toLowerCase().padStart(64, "0")}`;
  txs.forEach((t, i) => {
    const bad = (why: string) => new RailgunTxError(`transactions[${i}]: ${why}`);
    if (getAddress(t.boundParams.adaptContract) !== getAddress(want.adapter)) throw bad(`adaptContract ${t.boundParams.adaptContract} is not MurkFun's Railgun adapter ${want.adapter} (set the Railgun transaction's adapt ID contract to railgun.adaptContract)`);
    if (t.boundParams.adaptParams !== want.adaptParams.toLowerCase()) throw bad(`adaptParams is not this order's ${want.adaptParams} (set the adapt ID parameters to railgun.adaptParams; another order's Railgun transaction can not pay this one)`);
    if (t.boundParams.unshield !== "1") throw bad("not a NORMAL unshield (unshield type 1)");
    if (getAddress(t.unshieldPreimage.token.tokenAddress) !== getAddress(want.wbnb)) throw bad(`unshields ${t.unshieldPreimage.token.tokenAddress}, not WBNB (${want.wbnb})`);
    if (t.unshieldPreimage.npk !== npk) throw bad(`the unshield goes to ${t.unshieldPreimage.npk}, not to MurkFun's Railgun adapter`);
  });
  // one transaction: its gross is exactly what the order was built for (several: Railgun's fee rounds per transaction,
  // the relayer checks their net sum)
  if (want.grossWei !== undefined && txs.length === 1) {
    const sum = txs.reduce((a, t) => a + BigInt(t.unshieldPreimage.value), 0n);
    if (sum !== want.grossWei) throw new RailgunTxError(`the transactions unshield ${sum} wei in total, not railgun.unshield.amountWei ${want.grossWei}`);
  }
}
