// upload_token_metadata: the token image + metadata JSON go to MurkFun's IPFS uploads API (POST <MURKFUN_UPLOAD_URL or
// MURKFUN_INDEXER_URL>/ipfs/image, then /ipfs/metadata; docs/TOKEN_METADATA.md): MurkFun's server pins them on IPFS, so
// launching a token with an image and a description needs no pinning account. The server checks the image (square, 256-1024 px), strips its metadata (EXIF)
// and builds the canonical document itself; this side only reads the local file / fetches the https URL with caps and
// passes the answers on.
// Privacy: the upload reveals the user's IP address to MurkFun's server.
import fs from "fs";
import net from "net";
import dns from "dns";
import { get as httpsRequest, type RequestOptions } from "https";
import { Readable } from "stream";
import path from "path";
import { z } from "zod";
import { Vault } from "./vault.js";
import { fence } from "./fence.js";

export const IMAGE_MAX_BYTES = 1_000_000;
export const LINK_KEYS = ["website", "x", "telegram", "discord", "github"] as const;
const https = z.string().max(200).regex(/^https:\/\/[^\s]+$/, "must be an https:// URL");
/** The tool's input schema (same limits as docs/token-metadata.schema.json; the server checks again). */
export const uploadShape = {
  name: z.string().min(1).max(64).describe("exactly the name create_token will get (the document must match the chain)"),
  symbol: z.string().min(1).max(16).describe("exactly the symbol create_token will get"),
  description: z.string().max(1000).optional().describe("plain text, ≤ 1000 characters (no HTML / Markdown rendering)"),
  imagePath: z.string().optional().describe("a local PNG / JPEG / WebP / GIF file (≤ 1 MB; no SVG)"),
  imageUrl: z.string().optional().describe("or an https:// URL of the image (fetched here, ≤ 1 MB)"),
  links: z.object(Object.fromEntries(LINK_KEYS.map((k) => [k, https.optional()])) as Record<(typeof LINK_KEYS)[number], z.ZodOptional<typeof https>>)
    .strict().optional().describe("optional https links: website, x, telegram, discord, github"),
};
export type UploadInput = z.infer<z.ZodObject<typeof uploadShape>>;

const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
/** PNG / JPEG / GIF / WebP by magic bytes (what the server accepts), else null. */
export function sniffImage(b: Uint8Array): string | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a"))) return "gif";
  if (startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8)) return "webp";
  return null;
}

/** A host an image URL must not point at from the user's machine (loopback, private / link-local ranges, .local). */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split(".").map(Number);
    const c = Number(h.split(".")[2]);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
      || (a === 198 && (b === 18 || b === 19)) || a >= 224
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113); // IETF, documentation
  }
  // unspecified, loopback, IPv4-mapped / -compatible (::), ULA (fc00::/7), link- and site-local (fe80::/10, fec0::/10),
  // multicast, and the prefixes that reach IPv4 through a translator: NAT64 (64:ff9b::/96, 64:ff9b:1::/48), 6to4
  // (2002::/16), Teredo (2001::/32); documentation (2001:db8::/32)
  if (net.isIPv6(h)) return h.startsWith("::") || /^(fc|fd|fe[89a-f]|ff)/.test(h) || /^(64:ff9b:|2002:|2001::|2001:0:|2001:db8:)/.test(h);
  return false;
}

async function readCapped(res: Response, cap: number, deadline: Promise<never>) {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > cap) throw new Error(`image is ${declared} bytes; the limit is ${cap} (1 MB)`);
  const reader = res.body!.getReader();
  deadline.catch(() => reader.cancel().catch(() => {}));
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await Promise.race([reader.read(), deadline]);
    if (done) break;
    total += value.length;
    if (total > cap) { await reader.cancel().catch(() => {}); throw new Error(`image is over ${cap} bytes (1 MB)`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** One HTTPS GET without following redirects; `signal` aborts it (and its body) at the overall deadline. */
export type ImageGet = (url: URL, timeoutMs: number, signal: AbortSignal) => Promise<Response>;

/** dns.lookup that refuses a host resolving to a private / local address. The request connects to the address checked
 *  here, so a second resolution (DNS rebinding) cannot swap it. */
const publicLookup: RequestOptions["lookup"] = (host, opts, cb) => {
  dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err, "", 0);
    const list = addrs as dns.LookupAddress[];
    if (!list.length || list.some((a) => isPrivateHost(a.address))) return cb(new Error(`imageUrl: ${host} resolves to a local / private network address`), "", 0);
    if ((opts as { all?: boolean }).all) return (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    cb(null, list[0].address, list[0].family);
  });
};

const httpsGet: ImageGet = (url, timeoutMs, signal) => new Promise((resolve, reject) => {
  const req = httpsRequest(url, { lookup: publicLookup, timeout: timeoutMs, signal, headers: { accept: "image/png,image/jpeg,image/webp,image/gif" } }, (res) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers.set(k, v);
    const status = res.statusCode ?? 0;
    const body = status >= 200 && status < 300 ? (Readable.toWeb(res) as ReadableStream) : (res.resume(), null);
    resolve(new Response(body, { status, headers }));
  });
  req.on("timeout", () => req.destroy(new Error(`imageUrl: no answer within ${timeoutMs} ms`)));
  req.on("error", reject);
});

/** At most this many redirects; each target is checked like the first URL before it is requested. */
const MAX_REDIRECTS = 3;

function checkImageUrl(u: URL) {
  if (u.protocol !== "https:") throw new Error("imageUrl: only https:// URLs (redirects too)");
  if (u.username || u.password) throw new Error("imageUrl: no credentials in the URL");
  if (isPrivateHost(u.hostname)) throw new Error("imageUrl: refusing a local / private network address");
}

/** The image bytes from a local file or an https URL, ≤ 1 MB and of an accepted format. An URL is fetched within
 *  `timeoutMs` in all (every redirect and the whole body: a server trickling bytes cannot hold the tool, and the vault
 *  lock with it). `get` (tests) replaces the HTTPS client. */
export async function loadImage(o: { imagePath?: string; imageUrl?: string }, timeoutMs = 30_000, get: ImageGet = httpsGet): Promise<Buffer> {
  let bytes: Buffer;
  if (o.imagePath) {
    const p = path.resolve(o.imagePath.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (!st || !st.isFile()) throw new Error(`imagePath: no such file ${Vault.shown(p)}`);
    if (st.size > IMAGE_MAX_BYTES) throw new Error(`imagePath: ${st.size} bytes; the limit is ${IMAGE_MAX_BYTES} (1 MB): shrink it first`);
    bytes = fs.readFileSync(p);
  } else {
    let u: URL;
    try { u = new URL(o.imageUrl!); } catch { throw new Error("imageUrl: not a URL"); }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const deadline = new Promise<never>((_, reject) => ctl.signal.addEventListener("abort", () => reject(new Error(`imageUrl: not loaded within ${timeoutMs / 1000} s`)), { once: true }));
    deadline.catch(() => {});
    try {
      let res: Response;
      for (let hops = 0; ; hops++) {
        checkImageUrl(u);
        res = await Promise.race([get(u, timeoutMs, ctl.signal), deadline]);
        const location = res.headers.get("location");
        if (res.status < 300 || res.status >= 400 || !location) break;
        if (hops >= MAX_REDIRECTS) throw new Error(`imageUrl: more than ${MAX_REDIRECTS} redirects`);
        u = new URL(location, u);
      }
      if (!res.ok) throw new Error(`imageUrl: HTTP ${res.status}`);
      bytes = await readCapped(res, IMAGE_MAX_BYTES, deadline);
    } finally {
      clearTimeout(timer);
      ctl.abort(); // closes a connection still open (an error above)
    }
  }
  if (!sniffImage(bytes)) throw new Error("the image must be a PNG, JPEG, WebP or GIF file (SVG and other formats are refused)");
  return bytes;
}

async function post(url: string, body: BodyInit, type: string, timeoutMs: number) {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", body, headers: { "content-type": type, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(`MurkFun uploads API unreachable at ${url} (${(e as Error).message})`);
  }
  const text = await res.text();
  let j: any;
  try { j = JSON.parse(text); } catch { j = {}; }
  if (!res.ok) {
    if (res.status === 404 || res.status === 405) throw new Error("this MurkFun API does not offer uploads; set MURKFUN_UPLOAD_URL or pin the files yourself (https://murk.fun/skill.md, \"Launching a token\")");
    if (res.status === 429) throw new Error("upload rate limit reached; wait a minute and retry");
    // the server's text reaches the model: fenced as third-party text; its code only if it is a plain identifier
    const code = typeof j.error === "string" && /^[a-z][a-z0-9_]{0,47}$/.test(j.error) ? ` ${j.error}` : "";
    throw new Error(`upload refused (${res.status}${code}): ${fence("reason", typeof j.reason === "string" ? j.reason : text.slice(0, 300))}`);
  }
  return j;
}

const CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,98})$/;

/**
 * Upload the image (if any) and then the metadata. Returns the metadataURI for create_token and a preview of the
 * exact document. `indexerUrl` is the API base including /v1.
 */
export async function uploadTokenMetadata(indexerUrl: string | undefined, o: UploadInput, timeoutMs = 60_000) {
  if (!indexerUrl) throw new Error("no MurkFun API configured (MURKFUN_INDEXER_URL or MURKFUN_UPLOAD_URL); uploads go through it");
  if (o.imagePath && o.imageUrl) throw new Error("give imagePath or imageUrl, not both");
  const base = indexerUrl.replace(/\/+$/, "");
  const abs = (u: string) => (u.startsWith("/") ? `${new URL(base).origin}${u}` : u);
  let image: { uri: string; url: string; width: number; height: number; bytes: number } | undefined;
  if (o.imagePath || o.imageUrl) {
    const bytes = await loadImage(o);
    const r = await post(`${base}/ipfs/image`, new Uint8Array(bytes), "application/octet-stream", timeoutMs);
    if (!CID.test(r.cid ?? "") || r.uri !== `ipfs://${r.cid}`) throw new Error("unexpected answer from the indexer (image)");
    image = { uri: r.uri, url: abs(String(r.url ?? `/v1/ipfs/${r.cid}`)), width: r.width, height: r.height, bytes: r.bytes };
  }
  const links = o.links && Object.fromEntries(Object.entries(o.links).filter(([, v]) => v));
  const m = await post(`${base}/ipfs/metadata`, JSON.stringify({
    name: o.name, symbol: o.symbol, ...(o.description ? { description: o.description } : {}), ...(image ? { image: image.uri } : {}),
    ...(links && Object.keys(links).length ? { links } : {}),
  }), "application/json", timeoutMs);
  if (!CID.test(m.cid ?? "") || m.uri !== `ipfs://${m.cid}`) throw new Error("unexpected answer from the indexer (metadata)");
  if (m.document?.name !== o.name || m.document?.symbol !== o.symbol || (image && m.document?.image !== image.uri)) {
    throw new Error("the indexer returned a document that does not match the request");
  }
  return {
    metadataURI: m.uri as string,
    imageUrl: image?.url ?? null,
    image: image ? { uri: image.uri, width: image.width, height: image.height, bytes: image.bytes } : null,
    preview: m.document,
    next: `create_token with name "${o.name}", symbol "${o.symbol}" (exactly these) and metadataURI "${m.uri}"`,
    note: "Pinned by MurkFun; it stays pinned once a token uses it (unused uploads are removed after a few days). The upload showed your IP address to MurkFun's server.",
  };
}
