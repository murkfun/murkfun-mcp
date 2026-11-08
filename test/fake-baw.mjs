#!/usr/bin/env node
// TEST STAND-IN for the Binance Agentic Wallet CLI (`baw`, npm @binance/agentic-wallet). Never a real wallet: it signs
// with a local test key (FAKE_BAW_KEY) and sends to a local anvil fork (FAKE_BAW_RPC). It implements only what the
// MurkFun MCP uses, with the shapes of baw 1.12.0 / the binance-agentic-wallet skill (references/external-sign.md):
//   wallet address | sign-message preview|execute | contract-call preview|execute   (all with --json)
// Output: {"success":true,"data":...} or {"success":false,"error":{code,name,message}} + exit 1, on stdout.
// Knobs (env): FAKE_BAW_STATE dir for previewed requests (required), FAKE_BAW_LOG file (one JSON line per command, no
// signatures), FAKE_BAW_REQUIRE_CONFIRMATION = sign | tx | all, FAKE_BAW_NONDETERMINISTIC=1 (each signature from a
// fresh random key), FAKE_BAW_HIGH_S=1 (return the high-s twin), FAKE_BAW_EXTRA_ADDRESS (a second BSC address),
// FAKE_BAW_SIM_CODE (a failing simulationCode in a successful preview). Without FAKE_BAW_RPC the simulation is skipped.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createPublicClient, createWalletClient, http, getAddress, hashTypedData } from "viem";
import { privateKeyToAccount, generatePrivateKey, sign } from "viem/accounts";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const argv = process.argv.slice(2);
const json = argv.includes("--json");
const [group, cmd] = argv.filter((a) => !a.startsWith("--"));
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const env = process.env;
const out = (data) => { console.log(JSON.stringify({ success: true, data }, null, 2)); process.exit(0); };
const fail = (code, name, message) => { console.log(JSON.stringify({ success: false, error: { code, name, message } }, null, 2)); process.exit(1); };
if (!json) fail(1, "TEST_ONLY", "the fake baw only speaks --json");
if (!env.FAKE_BAW_KEY || !env.FAKE_BAW_STATE) fail(1, "TEST_ONLY", "FAKE_BAW_KEY and FAKE_BAW_STATE are required");
const me = privateKeyToAccount(env.FAKE_BAW_KEY);
fs.mkdirSync(env.FAKE_BAW_STATE, { recursive: true });
const log = (o) => env.FAKE_BAW_LOG && fs.appendFileSync(env.FAKE_BAW_LOG, `${JSON.stringify({ cmd: `${group} ${cmd}`, ...o })}\n`);
const save = (o) => { const id = crypto.randomBytes(16).toString("hex"); fs.writeFileSync(path.join(env.FAKE_BAW_STATE, `${id}.json`), JSON.stringify(o)); return id; };
const load = (id) => {
  const f = path.join(env.FAKE_BAW_STATE, `${String(id).replace(/[^0-9a-f]/g, "")}.json`);
  if (!id || !fs.existsSync(f)) fail(351806, "AGENT_PREVIEW_EXPIRED", "preview expired or unknown requestId");
  const o = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.rmSync(f);
  return o;
};
const confirm = (what) => env.FAKE_BAW_REQUIRE_CONFIRMATION === what || env.FAKE_BAW_REQUIRE_CONFIRMATION === "all";
const chain = { id: 56, name: "bsc-fork", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [env.FAKE_BAW_RPC ?? ""] } } };
const noRisks = { riskDetails: [], addresses: {}, riskBehaviors: [] };

/** uint / int fields of the typed data as bigint (eth_signTypedData_v4 JSON carries them as strings). */
function typed(td) {
  const { EIP712Domain: _d, ...types } = td.types;
  const conv = (type, v) => {
    if (types[type]) return Object.fromEntries(types[type].map((f) => [f.name, conv(f.type, v[f.name])]));
    if (type.endsWith("[]")) return v.map((x) => conv(type.slice(0, -2), x));
    return /^u?int\d*$/.test(type) ? BigInt(v) : v;
  };
  return { domain: td.domain, types, primaryType: td.primaryType, message: conv(td.primaryType, td.message) };
}

log({ requestId: opt("requestId") });
if (group === "wallet" && cmd === "address") {
  out({ addresses: [
    { binanceChainId: "56", chainName: "BSC", address: me.address },
    ...(env.FAKE_BAW_EXTRA_ADDRESS ? [{ binanceChainId: "56", chainName: "BSC", address: env.FAKE_BAW_EXTRA_ADDRESS }] : []),
    { binanceChainId: "1", chainName: "Ethereum", address: me.address },
    { binanceChainId: "CT_501", chainName: "Solana", address: "So11111111111111111111111111111111111111112" },
  ] });
}
if (group === "sign-message" && cmd === "preview") {
  if (opt("signType") !== "EIP712") fail(351821, "INVALID_PARAMS", "signType must be EIP712");
  let rpc;
  try { rpc = JSON.parse(opt("message")); } catch { fail(351821, "INVALID_PARAMS", "message is not JSON"); }
  if (rpc.method !== "eth_signTypedData_v4" || !Array.isArray(rpc.params)) fail(351821, "INVALID_PARAMS", "not an eth_signTypedData_v4 request");
  if (getAddress(rpc.params[0]) !== me.address) fail(351807, "ADDRESS_NOT_OWNED", "params[0] is not this agent wallet");
  const td = JSON.parse(rpc.params[1]);
  if (String(td.domain?.chainId) !== String(opt("binanceChainId"))) fail(351821, "INVALID_PARAMS", "domain.chainId != binanceChainId");
  const requestId = save({ kind: "sign", td });
  out({ requestId, parsedMessage: { messageType: "SignTypedData", preCheckCode: "", version: "V4", message: JSON.stringify(td.message) }, risks: noRisks, requireConfirmation: confirm("sign"), expiresAt: Date.now() + 600_000 });
}
if (group === "sign-message" && cmd === "execute") {
  const r = load(opt("requestId"));
  if (r.kind !== "sign") fail(351806, "AGENT_PREVIEW_EXPIRED", "not a sign-message request");
  if (confirm("sign")) out({ orderId: `msg-order-${opt("requestId").slice(0, 8)}`, status: "PENDING_CONFIRMATION", signature: null, signatureRecovery: null, message: "Please confirm in the Binance App" });
  const key = env.FAKE_BAW_NONDETERMINISTIC === "1" ? generatePrivateKey() : env.FAKE_BAW_KEY;
  const sig = await sign({ hash: hashTypedData(typed(r.td)), privateKey: key });
  let s = BigInt(sig.s), y = sig.yParity;
  if (env.FAKE_BAW_HIGH_S === "1") { s = N - s; y ^= 1; }
  out({ orderId: `msg-order-${opt("requestId").slice(0, 8)}`, status: "COMPLETED", signature: `${sig.r.slice(2)}${s.toString(16).padStart(64, "0")}`, signatureRecovery: y ? "01" : "00", message: null });
}
if (group === "contract-call" && cmd === "preview") {
  const from = opt("from"), to = opt("to"), value = BigInt(opt("value") ?? "0"), data = opt("inputData") ?? "0x", gas = opt("gasLimit");
  if (!from || getAddress(from) !== me.address) fail(351807, "ADDRESS_NOT_OWNED", "--from is not this agent wallet");
  if (!to) fail(351821, "INVALID_PARAMS", "--to is required on EVM");
  if (opt("binanceChainId") !== "56") fail(351821, "INVALID_PARAMS", "the fake only knows chain 56");
  if (env.FAKE_BAW_RPC) { // without an RPC (unit tests) the simulation is skipped
    const pub = createPublicClient({ transport: http(env.FAKE_BAW_RPC) });
    try {
      await pub.call({ account: me.address, to, data, value, ...(gas ? { gas: BigInt(gas) } : {}) });
    } catch (e) {
      fail(351805, "AGENT_SIMULATION_FAILED", `simulation failed: ${(e.shortMessage ?? e.message).split("\n")[0]}`);
    }
  }
  const requestId = save({ kind: "tx", to, value: value.toString(), data, gas });
  out({
    requestId, parsedTx: { transactionType: "ContractCall", amount: Number(value), contractAddress: to },
    simulationResult: { simulationCode: env.FAKE_BAW_SIM_CODE ?? "000000000", simulationErrorDetail: env.FAKE_BAW_SIM_CODE ? "test: simulated failure" : null, balanceChanges: [], allowanceChanges: [], authorityChanges: [], preCheckCode: "" },
    risks: noRisks, tokenInfos: {}, requireConfirmation: confirm("tx"), expiresAt: Date.now() + 600_000,
  });
}
if (group === "contract-call" && cmd === "execute") {
  const r = load(opt("requestId"));
  if (r.kind !== "tx") fail(351806, "AGENT_PREVIEW_EXPIRED", "not a contract-call request");
  if (confirm("tx")) out({ orderId: `order-${opt("requestId").slice(0, 8)}`, status: "PENDING_CONFIRMATION", txHash: null, message: "Please confirm in the Binance App" });
  const w = createWalletClient({ account: me, chain, transport: http(env.FAKE_BAW_RPC) });
  const txHash = await w.sendTransaction({ to: r.to, data: r.data, value: BigInt(r.value), ...(r.gas ? { gas: BigInt(r.gas) } : {}) });
  log({ txHash });
  out({ orderId: `order-${opt("requestId").slice(0, 8)}`, status: "BROADCASTED", txHash, message: null });
}
fail(1, "UNKNOWN_COMMAND", `the fake baw does not implement "${group} ${cmd}"`);
