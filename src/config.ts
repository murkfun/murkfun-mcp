// MCP configuration (environment variables). Everything secret lives in the encrypted vault, not here.
// Public network values (deployment addresses, relayer and indexer URLs) ship with the package in networks/<name>.json
// (MURKFUN_NETWORK, default bsc), written by scripts/set-network.mjs; the repository ships the production BSC values
// (a "<...>" placeholder left in a network file is refused). Every value can be overridden by its env var
// (MURKFUN_DEPLOYMENT, MURKFUN_RELAYER_URL, MURKFUN_INDEXER_URL, MURKFUN_RPC, MURKFUN_HOLDERS_API, MURKFUN_LOG_RPCS).
// A deployment or relayer other than the network file's is reported (`custom`, a warning on stderr, in the MCP
// instructions and in `setup` / `status`), like a non-bundled RPC or holder-set API and a "*" withdraw allowlist:
// a pasted config could otherwise re-point every address unnoticed. The order verifier check stays on with them.
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { getAddress, isAddress, parseEther, parseGwei, type Address } from "viem";

/** The deployment file. `market` / `orders` / `holderRoots` / `locker` are the addresses at deployment; the MCP
 *  follows re-points on chain (a token's own market is factory.marketOf(token), new tokens go to factory.market(), a
 *  market's order gate is market.orders(), the holder set the gate's HOLDER_ROOTS()). `privacyPoolAdapter`: the 0xbow
 *  processor. `holderRootsDeployBlock`: the holder set's own deploy block, earlier than `deployBlock` when the
 *  deployment reused a live holder set (its batches before `deployBlock` count); absent = deployed together. */
export interface Deployment {
  market: Address; factory: Address; orders: Address; holderRoots: Address; locker: Address; privacyPoolAdapter: Address;
  deployBlock: number; holderRootsDeployBlock?: number;
  /** MurkFunRailgunAdapter: the adapt contract a Railgun transaction unshields to (buy / fund_pseudonym /
   *  create_token source=railgun); absent = no Railgun path. */
  railgunAdapter?: Address;
}

/** First block of the holder set's events (its Batch / Challenged logs): its own deploy block, else the deployment's. */
export function holderRootsFromBlock(d: Deployment): bigint {
  return BigInt(d.holderRootsDeployBlock ?? d.deployBlock);
}

export interface Network {
  network: string; chainId: number; rpc: string; relayerUrl: string; indexerUrl?: string; deployment: Record<string, unknown>;
  /** Base URL of the public holder-set API (GET <holdersApi>/v1/holders/lookup): the first source of the wallet's
   *  holder path, verified locally and on chain (holdersApi.ts). */
  holdersApi?: string;
  /** Free endpoints known to serve eth_getLogs over the chain's history, tried after `rpc` (logRpc.ts). */
  logRpcs?: string[];
  /** keccak256 of the deployed OrderVerifier's runtime code, the build the bundled circuits/order.vk belongs to
   *  (set by scripts/set-network.mjs). */
  orderVerifierCodeHash?: string;
}

export interface McpConfig {
  home: string; // directory holding vault.json (encrypted)
  passphrase?: string;
  rpc: string; // BSC RPC for reads and the wallet's own (public) 0xbow txs: keystore registration, deposit
  /** Endpoints tried after `rpc` for eth_getLogs scans (MURKFUN_LOG_RPCS, comma-separated; default the network file's
   *  logRpcs; "" = none). Each is probed once per process (logRpc.ts). */
  logRpcs: string[];
  /** The holder-set API base (MURKFUN_HOLDERS_API, default the network file's holdersApi; "" = never ask it, read the
   *  holder batches from the chain's logs). */
  holdersApi?: string;
  chainId: number;
  relayerUrl: string;
  indexerUrl?: string; // MurkFun indexer API base (…/v1) for list_launches / token_info market data; chain fallback
  uploadUrl?: string; // IPFS uploads API base (…/v1; upload_token_metadata): MURKFUN_UPLOAD_URL, default the indexer URL
  deployment: Deployment;
  ppSnapshotUrl: string; // 0xbow public event snapshot (https:// or file://)
  aspLeavesUrl: string; // 0xbow association-set leaves (https:// or file://)
  circuitsDir: string; // 0xbow circuit artifacts (deposit/, transact_1x1/)
  logChunk: number; // eth_getLogs block window
  ppScanFrom?: number; // override: first block to scan for 0xbow leaves after the snapshot (tests on old forks)
  signer: "local" | "baw"; // default wallet for a new vault: local (key here) or the Binance Agentic Wallet CLI
  bawPath: string; // the `baw` binary (Binance Agentic Wallet CLI, npm @binance/agentic-wallet)
  bawAccount?: Address; // optional: which agent-wallet address to use (must be one of `baw wallet address`)
  maxDepositIndex: number; // recovery tries deposit indices below this for each 0xbow deposit event
  orderWaitMs: number;
  orderRetries: number; // resubmissions of the identical order after broadcast_failed / overloaded / relayer_unreachable or status dropped
  orderRetryBackoffMs: number; // first wait before a resubmission; doubles each time (at most 30 s)
  maxRelayerFeeWei: bigint; // the most a relayer quote may bind into an order (MURKFUN_MAX_RELAYER_FEE_BNB)
  maxRelayerFeeBps: number; // and at most this share of a buy's or sell's BNB (MURKFUN_MAX_RELAYER_FEE_BPS, default 1000 = 10%)
  maxFeeMultiple: number; // and at most this multiple of the quote's own gas x gas price (MURKFUN_MAX_FEE_MULTIPLE, default 2; MurkFun's relayer quotes 1.1x)
  maxOrderValidityS: number; // a quoted deadline at most this far ahead (MURKFUN_MAX_ORDER_VALIDITY_S, default 600)
  /** Per action, a relayer fee is at most that action's most gas (MAX_ORDER_GAS, + the graduation for a completing
   *  buy) x this gas price x maxFeeMultiple, whatever the RPC reports (MURKFUN_MAX_GAS_PRICE_GWEI, default 3). */
  maxGasPriceWei: bigint;
  relayerAddress?: Address; // the relayer's address, if pinned (MURKFUN_RELAYER_ADDRESS): quotes naming another are refused
  /** MURKFUN_WITHDRAW_ALLOWLIST: withdrawals and fee recipients only to these; "*" = any address; unset = only the
   *  vault's own wallet (an instruction injected through third-party text can not send funds anywhere else). */
  withdrawAllowlist?: Address[] | "any";
  rpcCheck?: string; // MURKFUN_RPC_CHECK: a second RPC; the holder root and the chain id must match on both
  /** keccak256 of the order gate's verifier code that the bundled circuit proves for (MURKFUN_VERIFIER_CODE_HASH, else
   *  the network file's, also when MURKFUN_DEPLOYMENT overrides the deployment; MURKFUN_VERIFIER_CODE_HASH="" turns the
   *  check off): a gate with another verifier is refused before anything is signed. */
  verifierCodeHash?: `0x${string}`;
  /** What differs from the bundled network file: "deployment" (MURKFUN_DEPLOYMENT names other addresses),
   *  "relayerUrl" (MURKFUN_RELAYER_URL), "verifierCodeHash" (MURKFUN_VERIFIER_CODE_HASH); empty for the bundled
   *  network. Shown in `status` and warned about on stderr. */
  custom?: string[];
  /** Configuration warnings (custom network values, a plain-http or non-bundled RPC, a non-bundled holder-set API, a
   *  "*" withdraw allowlist): on stderr at start, in the MCP instructions, and in `setup` / `status`. */
  warnings?: string[];
  orderDelayMs: [number, number]; // random wait between the wallet's order signature and the submission (MURKFUN_ORDER_DELAY_MS "min-max")
  bbPath?: string; // Barretenberg `bb` 6.0.0 (MURKFUN_BB); default: on the PATH, else downloaded once (pinned sha256)
  bbDownload: boolean; // MURKFUN_BB_DOWNLOAD=0: never download bb
  /** MURKFUN_EXPORT_DIR: a directory (e.g. a USB stick) export_recovery may write to besides MURKFUN_HOME. Set by the
   *  user, never by the agent: the plaintext recovery file goes nowhere else. */
  exportDir?: string;
}

/** Comma-separated RPC URLs (http(s); empty entries dropped). */
function urlList(name: string, v: string): string[] {
  const out = v.split(",").map((x) => x.trim()).filter(Boolean);
  for (const u of out) if (!/^https?:\/\//.test(u)) throw new Error(`${name}: not an http(s) URL: ${u}`);
  return out;
}

/** Comma-separated addresses (checksummed on the way in). */
function addressList(name: string, v: string): Address[] {
  const out = v.split(",").map((x) => x.trim()).filter(Boolean);
  for (const a of out) if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`${name}: not an address: ${a}`);
  return out.map((a) => getAddress(a));
}

/** A service URL the MCP sends orders / uploads to: https, or http only to this machine. */
export function serviceUrl(u: string, what: string): string {
  let url: URL;
  try { url = new URL(u); } catch { throw new Error(`${what}: not a URL: ${u}`); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`${what} must be https:// (http:// only for localhost): ${u}`);
  return u;
}

/** networks/ next to src/ and dist/ (both one level below the package root). */
export const NETWORKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "networks");

/** A template value that set-network.mjs (or an env override) replaces, e.g. "<MURKFUN_RELAYER_URL>". */
export const isPlaceholder = (v: unknown) => typeof v === "string" && /^<.*>$/.test(v.trim());

export function loadNetwork(name: string): Network {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`MURKFUN_NETWORK must be a bundled network name, got ${JSON.stringify(name)}`);
  const f = path.join(NETWORKS_DIR, `${name}.json`);
  if (!fs.existsSync(f)) throw new Error(`unknown MURKFUN_NETWORK ${name} (no ${f})`);
  return JSON.parse(fs.readFileSync(f, "utf8")) as Network;
}

/** Placeholders left in a network file ("relayerUrl", "deployment.market", ...). indexerUrl is optional and not listed. */
export function networkPlaceholders(n: Network): string[] {
  const out = isPlaceholder(n.relayerUrl) ? ["relayerUrl"] : [];
  for (const [k, v] of Object.entries(n.deployment)) if (isPlaceholder(v) || (BLOCK_KEYS.includes(k) && !v)) out.push(`deployment.${k}`);
  return out;
}
const BLOCK_KEYS = ["deployBlock", "holderRootsDeployBlock"];

export function parseDeployment(d: Record<string, unknown>, from: string): Deployment {
  for (const k of ["market", "factory", "orders", "holderRoots", "locker", "privacyPoolAdapter"]) {
    if (typeof d[k] !== "string" || !isAddress(d[k] as string)) throw new Error(`${from}: ${k} is not an address (${JSON.stringify(d[k])})`);
  }
  if (d.railgunAdapter !== undefined && (typeof d.railgunAdapter !== "string" || !isAddress(d.railgunAdapter))) {
    throw new Error(`${from}: railgunAdapter is not an address (${JSON.stringify(d.railgunAdapter)})`);
  }
  if (!Number.isInteger(Number(d.deployBlock)) || Number(d.deployBlock) <= 0) throw new Error(`${from}: deployBlock must be a positive block number`);
  const out = { ...(d as unknown as Deployment), deployBlock: Number(d.deployBlock) };
  if (d.holderRootsDeployBlock === undefined || d.holderRootsDeployBlock === null) {
    delete out.holderRootsDeployBlock;
    return out;
  }
  const h = Number(d.holderRootsDeployBlock);
  if (!Number.isInteger(h) || h <= 0 || h > out.deployBlock) {
    throw new Error(`${from}: holderRootsDeployBlock must be a positive block number, at most deployBlock (got ${JSON.stringify(d.holderRootsDeployBlock)})`);
  }
  return { ...out, holderRootsDeployBlock: h };
}

function nonNegativeInt(name: string, v: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(v)}`);
  return n;
}

function signerFrom(v: string | undefined): "local" | "baw" {
  if (v === undefined || v === "" || v === "local") return "local";
  if (v === "baw") return "baw";
  throw new Error(`MURKFUN_SIGNER must be "local" or "baw", got ${JSON.stringify(v)}`);
}

/** "min-max" milliseconds (or one number). */
export function delayRange(v: string): [number, number] {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(v);
  if (!m) throw new Error(`MURKFUN_ORDER_DELAY_MS must be "min-max" milliseconds, got ${JSON.stringify(v)}`);
  const lo = Number(m[1]), hi = Number(m[2] ?? m[1]);
  if (hi < lo) throw new Error("MURKFUN_ORDER_DELAY_MS: max below min");
  return [lo, hi];
}

function codeHashFrom(v: string | undefined): `0x${string}` | undefined {
  if (v === undefined || v === "") return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error("the order verifier code hash (MURKFUN_VERIFIER_CODE_HASH / networks file) must be 0x + 64 hex");
  return v.toLowerCase() as `0x${string}`;
}

/** What the effective deployment / relayer / verifier hash change against the network file (McpConfig.custom). */
export function customValues(net: Network, c: { deployment: Deployment; relayerUrl: string; verifierCodeHash?: string }): string[] {
  const out: string[] = [];
  const bundled = net.deployment as Record<string, unknown>;
  const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && isAddress(a) && isAddress(b) ? getAddress(a) === getAddress(b) : a === b;
  const keys = ["market", "factory", "orders", "holderRoots", "locker", "privacyPoolAdapter", "railgunAdapter"] as const;
  if (keys.some((k) => !same(c.deployment[k], bundled[k]))) out.push("deployment");
  if (c.relayerUrl.replace(/\/+$/, "") !== String(net.relayerUrl).replace(/\/+$/, "")) out.push("relayerUrl");
  const bundledHash = isPlaceholder(net.orderVerifierCodeHash) ? undefined : net.orderVerifierCodeHash?.toLowerCase();
  if ((c.verifierCodeHash ?? undefined) !== bundledHash) out.push("verifierCodeHash");
  return out;
}

/** An RPC URL: http(s). Plain http is accepted (a local node) but warned about off this machine. */
function rpcUrl(u: string, warnings: string[]): string {
  if (!/^https?:\/\//.test(u)) throw new Error(`MURKFUN_RPC: not an http(s) URL: ${u}`);
  let host = "";
  try { host = new URL(u).hostname; } catch { throw new Error(`MURKFUN_RPC: not a URL: ${u}`); }
  if (u.startsWith("http://") && !["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    warnings.push(`MURKFUN_RPC is plain http (${host}): anyone on the path sees and can alter what this wallet reads; use https`);
  }
  return u;
}

function bawAccountFrom(v: string): Address {
  if (!isAddress(v)) throw new Error("MURKFUN_BAW_ACCOUNT is not an address");
  return v as Address;
}

export function configFromEnv(e: NodeJS.ProcessEnv = process.env): McpConfig {
  const env = (k: string, d?: string) => {
    const v = e[k] ?? d;
    if (v === undefined) throw new Error(`missing env ${k}`);
    return v;
  };
  const net = loadNetwork(e.MURKFUN_NETWORK ?? "bsc");
  const noValue = (what: string, envVar: string) =>
    new Error(`networks/${net.network}.json has no value for ${what} (it holds the template placeholder): set ${envVar}`);
  let deployment: Deployment;
  if (e.MURKFUN_DEPLOYMENT) {
    const dep = e.MURKFUN_DEPLOYMENT;
    deployment = parseDeployment(JSON.parse(dep.trim().startsWith("{") ? dep : fs.readFileSync(dep, "utf8")), "MURKFUN_DEPLOYMENT");
  } else {
    if (networkPlaceholders(net).some((p) => p.startsWith("deployment."))) throw noValue("the MurkFun deployment", "MURKFUN_DEPLOYMENT");
    deployment = parseDeployment(net.deployment, `networks/${net.network}.json`);
  }
  const relayerUrl = e.MURKFUN_RELAYER_URL ?? net.relayerUrl;
  if (isPlaceholder(relayerUrl)) throw noValue("the relayer URL", "MURKFUN_RELAYER_URL");
  // optional: an empty MURKFUN_INDEXER_URL or a placeholder in the network file means no indexer
  const indexerUrl = e.MURKFUN_INDEXER_URL ?? net.indexerUrl;
  const home = env("MURKFUN_HOME", path.join(os.homedir(), ".murkfun"));
  // optional: an empty MURKFUN_HOLDERS_API (or none in the network file) means the holder path comes from the logs only
  const holdersApi = e.MURKFUN_HOLDERS_API ?? net.holdersApi;
  const warnings: string[] = [];
  const rpc = rpcUrl(env("MURKFUN_RPC", net.rpc), warnings);
  const verifierCodeHash = codeHashFrom(e.MURKFUN_VERIFIER_CODE_HASH ?? (isPlaceholder(net.orderVerifierCodeHash) ? undefined : net.orderVerifierCodeHash));
  const relayer = serviceUrl(relayerUrl, "MURKFUN_RELAYER_URL");
  const custom = customValues(net, { deployment, relayerUrl: relayer, verifierCodeHash });
  if (custom.length) {
    warnings.push(`custom network values (${custom.join(", ")}): not the ones bundled in networks/${net.network}.json. Funds and orders go to these addresses; use them only if you set them yourself${!verifierCodeHash ? " (the order verifier check is off: MURKFUN_VERIFIER_CODE_HASH is empty)" : ""}`);
  }
  // values an injected instruction could have set: an RPC that sees (and could misreport) every read, a holder-set API
  // that sees the wallet's address and IP, destinations without the allowlist (the user's own node on this machine and
  // an empty MURKFUN_HOLDERS_API are what the privacy advice recommends: not warned about)
  const trim = (u: string | undefined) => (u ?? "").replace(/\/+$/, "");
  const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };
  if (trim(rpc) !== trim(net.rpc) && !["localhost", "127.0.0.1", "[::1]"].includes(hostOf(rpc))) {
    warnings.push(`MURKFUN_RPC is not the bundled one (${hostOf(rpc)}): it sees every read of the wallet and its pseudonyms and could misreport balances or quotes; use it only if the user set it`);
  }
  if (e.MURKFUN_HOLDERS_API && trim(e.MURKFUN_HOLDERS_API) !== trim(net.holdersApi)) {
    warnings.push(`MURKFUN_HOLDERS_API is not the bundled one (${hostOf(e.MURKFUN_HOLDERS_API)}): it sees the wallet's address and IP address (its answers are checked on chain); use it only if the user set it`);
  }
  if (e.MURKFUN_WITHDRAW_ALLOWLIST?.trim() === "*") {
    warnings.push("MURKFUN_WITHDRAW_ALLOWLIST is \"*\": withdrawals and fee recipients may go to any address, also one named by injected text; confirm every destination with the user");
  }
  return {
    home,
    passphrase: e.MURKFUN_PASSPHRASE ?? (e.MURKFUN_PASSPHRASE_FILE ? fs.readFileSync(e.MURKFUN_PASSPHRASE_FILE, "utf8").trim() : undefined),
    rpc,
    logRpcs: e.MURKFUN_LOG_RPCS !== undefined ? urlList("MURKFUN_LOG_RPCS", e.MURKFUN_LOG_RPCS) : urlList(`networks/${net.network}.json logRpcs`, (net.logRpcs ?? []).join(",")),
    holdersApi: holdersApi && !isPlaceholder(holdersApi) ? serviceUrl(holdersApi.replace(/\/+$/, ""), "MURKFUN_HOLDERS_API") : undefined,
    chainId: Number(env("MURKFUN_CHAIN_ID", String(net.chainId))),
    relayerUrl: relayer,
    indexerUrl: indexerUrl && !isPlaceholder(indexerUrl) ? serviceUrl(indexerUrl.replace(/\/+$/, ""), "MURKFUN_INDEXER_URL") : undefined,
    uploadUrl: e.MURKFUN_UPLOAD_URL ? serviceUrl(e.MURKFUN_UPLOAD_URL.replace(/\/+$/, ""), "MURKFUN_UPLOAD_URL") : undefined,
    deployment,
    ppSnapshotUrl: env("MURKFUN_PP_SNAPSHOT_URL", "https://api-v2.0xbow.io/56/public/event-snapshot/payload"),
    aspLeavesUrl: env("MURKFUN_ASP_LEAVES_URL", "https://api-v2.0xbow.io/association-set/leaves?chainId=56&entrypoint=0xca1e072236D231130059eeA6Bfceb7F4e9a1F0C3"),
    circuitsDir: env("MURKFUN_CIRCUITS_DIR", path.join(home, "circuits")),
    logChunk: Number(env("MURKFUN_LOG_CHUNK", "5000")),
    ppScanFrom: e.MURKFUN_PP_SCAN_FROM ? Number(e.MURKFUN_PP_SCAN_FROM) : undefined,
    signer: signerFrom(e.MURKFUN_SIGNER),
    bawPath: env("MURKFUN_BAW_PATH", "baw"),
    bawAccount: e.MURKFUN_BAW_ACCOUNT ? bawAccountFrom(e.MURKFUN_BAW_ACCOUNT) : undefined,
    maxDepositIndex: Number(env("MURKFUN_MAX_DEPOSIT_INDEX", "64")),
    orderWaitMs: Number(env("MURKFUN_ORDER_WAIT_MS", "120000")),
    // a failed broadcast sent nothing and a dropped order was not executed: the identical order is resubmitted
    orderRetries: nonNegativeInt("MURKFUN_ORDER_RETRIES", env("MURKFUN_ORDER_RETRIES", "3")),
    orderRetryBackoffMs: nonNegativeInt("MURKFUN_ORDER_RETRY_BACKOFF_MS", env("MURKFUN_ORDER_RETRY_BACKOFF_MS", "2000")),
    maxRelayerFeeWei: parseEther(env("MURKFUN_MAX_RELAYER_FEE_BNB", "0.05")),
    maxRelayerFeeBps: nonNegativeInt("MURKFUN_MAX_RELAYER_FEE_BPS", env("MURKFUN_MAX_RELAYER_FEE_BPS", "1000")),
    maxFeeMultiple: Number(env("MURKFUN_MAX_FEE_MULTIPLE", "2")),
    maxOrderValidityS: nonNegativeInt("MURKFUN_MAX_ORDER_VALIDITY_S", env("MURKFUN_MAX_ORDER_VALIDITY_S", "600")),
    maxGasPriceWei: parseGwei(env("MURKFUN_MAX_GAS_PRICE_GWEI", "3")),
    relayerAddress: e.MURKFUN_RELAYER_ADDRESS ? addressList("MURKFUN_RELAYER_ADDRESS", e.MURKFUN_RELAYER_ADDRESS)[0] : undefined,
    withdrawAllowlist: e.MURKFUN_WITHDRAW_ALLOWLIST?.trim() === "*" ? "any"
      : e.MURKFUN_WITHDRAW_ALLOWLIST ? addressList("MURKFUN_WITHDRAW_ALLOWLIST", e.MURKFUN_WITHDRAW_ALLOWLIST) : undefined,
    rpcCheck: e.MURKFUN_RPC_CHECK ? serviceUrl(e.MURKFUN_RPC_CHECK, "MURKFUN_RPC_CHECK") : undefined,
    verifierCodeHash,
    custom,
    warnings,
    // Binance sees when each order signature is made: the order lands a random 30 s - 3 min later
    orderDelayMs: delayRange(env("MURKFUN_ORDER_DELAY_MS", "30000-180000")),
    bbPath: e.MURKFUN_BB || undefined,
    bbDownload: e.MURKFUN_BB_DOWNLOAD !== "0",
    exportDir: e.MURKFUN_EXPORT_DIR ? path.resolve(e.MURKFUN_EXPORT_DIR) : undefined,
  };
}
