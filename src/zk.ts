// Poseidon (circomlib) and LeanIMT for the 0xbow Privacy Pools proofs (pp.ts).
import { buildPoseidon } from "circomlibjs";
import { LeanIMT } from "@zk-kit/lean-imt";

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let pos: any;
export async function zkInit() { if (!pos) pos = await buildPoseidon(); }
export const H = (arr: (bigint | number | string)[]): bigint => pos.F.toObject(pos(arr.map((x) => BigInt(x))));
export const tree = (leaves: bigint[]) => {
  const t = new LeanIMT<bigint>((a, b) => H([a, b]));
  if (leaves.length) t.insertMany(leaves);
  return t;
};

export async function zkShutdown() { await (globalThis as any).curve_bn128?.terminate(); }
