#!/usr/bin/env node
// Fill the bundled network file (networks/<network>.json) from a deployment, or check that it is filled.
//   node scripts/set-network.mjs --deployment <deployment.json> --relayer https://relayer.example \
//        [--indexer https://api.example/v1] [--holders-api https://murk.fun] [--network bsc] [--rpc https://bsc-dataseed.bnbchain.org]
//        (--artifact <OrderVerifier.json> | --verifier-code-hash 0x..)
//   node scripts/set-network.mjs --check [--network bsc]     # exit 1 while placeholders remain (run before a release)
// <deployment.json>: the deployment's addresses (market, factory, orders, holderRoots, locker, privacyPoolAdapter,
// railgunAdapter), deployBlock, optional holderRootsDeployBlock and chainId.
// With --rpc every contract address must have code on that chain and the RPC's chain id must match.
// orderVerifierCodeHash: keccak256 of OrderVerifier's runtime code, from the forge artifact of a build of the MurkFun
// contracts (--artifact out/OrderVerifier.sol/OrderVerifier.json) or given (--verifier-code-hash): the build the bundled circuits/order.vk belongs to; with --rpc the order gate's VERIFIER() must have exactly that code. The
// MCP refuses a gate with another verifier (every proof would revert), and --check requires it. The deployed code may
// come from another machine's build of the same source, which differs only in solc's CBOR metadata tail: --rpc compares
// the code without it and then records the deployed code's own hash (the one the MCP sees on chain).
// deployment.holderRootsDeployBlock: the holder set's own deploy block (the deployment file's; a reused live holder set
// is older than the rest), where the MCP starts reading its Batch events; the deployBlock when the file has none.
// holdersApi: the public holder-set API's base (the MCP asks <holdersApi>/v1/holders/lookup for the wallet's holder
// path and checks the proof itself); --holders-api sets it, else the file's value is kept. The file's rpc and logRpcs
// (endpoints that serve eth_getLogs, the fallback for the holder path) are kept as they are.
// Only public values go here: addresses, block numbers, URLs, code hashes. Never keys.
import fs from "node:fs";
import path from "node:path";
import { keccak256 } from "viem";

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const network = opt("network") ?? "bsc";
const file = path.join(import.meta.dirname, "..", "networks", `${network}.json`);
const net = JSON.parse(fs.readFileSync(file, "utf8"));
const isPlaceholder = (v) => typeof v === "string" && /^<.*>$/.test(v.trim());
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const ADDRS = ["market", "factory", "orders", "holderRoots", "locker", "privacyPoolAdapter", "railgunAdapter"];

function placeholders(n) {
  const out = isPlaceholder(n.relayerUrl) ? ["relayerUrl"] : [];
  if (isPlaceholder(n.holdersApi)) out.push("holdersApi");
  if (!/^0x[0-9a-fA-F]{64}$/.test(n.orderVerifierCodeHash ?? "")) out.push("orderVerifierCodeHash");
  for (const [k, v] of Object.entries(n.deployment)) if (isPlaceholder(v) || (["deployBlock", "holderRootsDeployBlock"].includes(k) && !v)) out.push(`deployment.${k}`);
  return out;
}

/** Runtime code (0x hex) without solc's CBOR metadata tail (its length: the last 2 bytes), lowercase; whole when the
 *  tail is not well formed. */
function withoutMetadata(hex) {
  const h = hex.toLowerCase().replace(/^0x/, "");
  const n = h.length / 2;
  if (n < 2) return h;
  const m = parseInt(h.slice(-4), 16);
  const start = n - 2 - m;
  if (m === 0 || start < 0 || (parseInt(h.slice(start * 2, start * 2 + 2), 16) & 0xe0) !== 0xa0) return h;
  return h.slice(0, start * 2);
}

if (args.includes("--check")) {
  const left = placeholders(net);
  if (left.length) {
    console.error(`networks/${network}.json still has placeholders: ${left.join(", ")}`);
    process.exit(1);
  }
  console.log(`networks/${network}.json is filled (market ${net.deployment.market}, relayer ${net.relayerUrl})`);
  process.exit(0);
}

const depFile = opt("deployment"), relayer = opt("relayer"), indexer = opt("indexer"), holdersApi = opt("holders-api"), rpc = opt("rpc");
if (!depFile || !relayer) {
  console.error("usage: set-network.mjs --deployment <deployment.json> --relayer <https url> (--artifact <OrderVerifier.json> | --verifier-code-hash 0x..) [--indexer <https url>/v1] [--holders-api <https url>] [--network bsc] [--rpc <url>]");
  process.exit(2);
}
const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));
const fail = (m) => {
  console.error(m);
  process.exit(1);
};
for (const k of ADDRS) if (!isAddr(dep[k])) fail(`${depFile}: ${k} is not an address (${JSON.stringify(dep[k])})`);
if (!Number.isInteger(Number(dep.deployBlock)) || Number(dep.deployBlock) <= 0) fail(`${depFile}: deployBlock must be > 0`);
const holderRootsDeployBlock = Number(dep.holderRootsDeployBlock ?? dep.deployBlock);
if (!Number.isInteger(holderRootsDeployBlock) || holderRootsDeployBlock <= 0 || holderRootsDeployBlock > Number(dep.deployBlock)) {
  fail(`${depFile}: holderRootsDeployBlock must be > 0 and at most deployBlock (got ${JSON.stringify(dep.holderRootsDeployBlock)})`);
}
if (dep.chainId !== undefined && Number(dep.chainId) !== net.chainId) fail(`${depFile}: chainId ${dep.chainId} != ${net.chainId}`);
for (const [name, u] of [["relayer", relayer], ["indexer", indexer], ["holders-api", holdersApi]]) {
  if (u === undefined) continue;
  let url;
  try {
    url = new URL(u);
  } catch {
    fail(`--${name} is not a URL`);
  }
  if (url.protocol !== "https:") fail(`--${name} must be https (got ${url.protocol})`);
}

// the build's OrderVerifier (--artifact: forge's artifact of it), or --verifier-code-hash 0x.. as given
const artifact = opt("artifact");
let orderVerifierCodeHash = opt("verifier-code-hash");
const given = orderVerifierCodeHash !== undefined;
let localCode;
if (!given) {
  if (!artifact) fail("pass --artifact <OrderVerifier.json> (forge's artifact of the build) or --verifier-code-hash 0x..");
  if (!fs.existsSync(artifact)) fail(`${artifact} not found (forge build the MurkFun contracts first, or pass --verifier-code-hash)`);
  localCode = JSON.parse(fs.readFileSync(artifact, "utf8")).deployedBytecode.object;
  orderVerifierCodeHash = keccak256(localCode);
}
if (!/^0x[0-9a-fA-F]{64}$/.test(orderVerifierCodeHash)) fail("--verifier-code-hash must be 0x + 64 hex");
orderVerifierCodeHash = orderVerifierCodeHash.toLowerCase();

if (rpc) {
  const call = async (method, params) => {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
  const id = Number(await call("eth_chainId", []));
  if (id !== net.chainId) fail(`--rpc is chain ${id}, ${network} is ${net.chainId}`);
  for (const k of ADDRS) if ((await call("eth_getCode", [dep[k], "latest"])) === "0x") fail(`${k} ${dep[k]} has no code on chain ${id}`);
  // MurkFunOrders.VERIFIER() (selector 0x08c84e70 = keccak("VERIFIER()")[:4])
  const verifier = `0x${(await call("eth_call", [{ to: dep.orders, data: "0x08c84e70" }, "latest"])).slice(-40)}`;
  const code = await call("eth_getCode", [verifier, "latest"]);
  if (given ? keccak256(code) !== orderVerifierCodeHash : withoutMetadata(code) !== withoutMetadata(localCode)) {
    fail(`the order gate's verifier ${verifier} is not ${given ? "--verifier-code-hash" : "--artifact"} (this build's circuit): deploy and bundle the same build`);
  }
  orderVerifierCodeHash = keccak256(code);
}

const out = {
  ...net,
  relayerUrl: relayer.replace(/\/+$/, ""),
  indexerUrl: indexer ? indexer.replace(/\/+$/, "") : net.indexerUrl,
  holdersApi: holdersApi ? holdersApi.replace(/\/+$/, "") : net.holdersApi,
  orderVerifierCodeHash,
  deployment: {
    ...Object.fromEntries(ADDRS.map((k) => [k, dep[k]])),
    deployBlock: Number(dep.deployBlock),
    holderRootsDeployBlock,
  },
};
fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${file}${placeholders(out).length ? ` (placeholders left: ${placeholders(out).join(", ")})` : ""}`);
