// upload_token_metadata against a mocked upload API (unit).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { isPrivateHost, loadImage, sniffImage, uploadTokenMetadata } from "../src/upload.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "murkfun-mcp-upload-"));
// A real 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const IMG_CID = "bafkreieb6wpwcsu5gdquzqcvfqy543ktqvkfpv4naawtgzgwzlaxkd6fce";
const META_CID = "bafkreidtvy46tqmgk34bunxmhfqrbhk3toibdvhq6pr7jua22fvf3gfkk4";

let server: http.Server;
let base = "";
const seen: { path: string; type: string; body: Buffer }[] = [];
let mode: "ok" | "limited" | "absent" = "ok";
before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    seen.push({ path: req.url ?? "", type: String(req.headers["content-type"]), body });
    const json = (code: number, x: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(x));
    if (mode === "absent") return json(404, { error: "not found" });
    if (mode === "limited") return json(429, { error: "rate_limited" });
    if (req.url === "/v1/ipfs/image") {
      if (!sniffImage(body)) return json(415, { error: "unsupported_image", reason: "only PNG, JPEG, WebP or GIF" });
      return json(200, { cid: IMG_CID, uri: `ipfs://${IMG_CID}`, url: `/v1/ipfs/${IMG_CID}`, width: 256, height: 256, bytes: 1234, format: "png" });
    }
    if (req.url === "/v1/ipfs/metadata") {
      const m = JSON.parse(body.toString());
      if (m.description?.includes("BAD")) return json(400, { error: "bad_metadata", reason: "description contains control characters" });
      return json(200, { cid: META_CID, uri: `ipfs://${META_CID}`, url: `/v1/ipfs/${META_CID}`, bytes: 200, document: { schema: "murkfun-token-metadata/v1", ...m } });
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("upload_token_metadata: image then metadata through the indexer; returns the metadataURI for create_token", async () => {
  mode = "ok";
  seen.length = 0;
  const file = path.join(tmp, "cat.png");
  fs.writeFileSync(file, PNG);
  const r = await uploadTokenMetadata(base, { name: "MurkFun Cat", symbol: "MCAT", description: "A cat.", imagePath: file, links: { x: "https://x.com/murkcat" } });
  assert.equal(r.metadataURI, `ipfs://${META_CID}`);
  assert.equal(r.imageUrl, `${new URL(base).origin}/v1/ipfs/${IMG_CID}`);
  assert.deepEqual(r.preview, { schema: "murkfun-token-metadata/v1", name: "MurkFun Cat", symbol: "MCAT", description: "A cat.", image: `ipfs://${IMG_CID}`, links: { x: "https://x.com/murkcat" } });
  assert.match(r.next, /create_token .*metadataURI "ipfs:\/\/bafkrei/);
  assert.deepEqual(seen.map((s) => [s.path, s.type]), [["/v1/ipfs/image", "application/octet-stream"], ["/v1/ipfs/metadata", "application/json"]]);
  assert.ok(seen[0].body.equals(PNG), "the file's bytes, untouched (the server re-encodes)");

  seen.length = 0;
  const noImage = await uploadTokenMetadata(base, { name: "A", symbol: "A" });
  assert.equal(noImage.imageUrl, null);
  assert.deepEqual(seen.map((s) => s.path), ["/v1/ipfs/metadata"]);
  assert.deepEqual(JSON.parse(seen[0].body.toString()), { name: "A", symbol: "A" });
});

test("upload_token_metadata: refuses bad input before uploading, and explains server refusals", async () => {
  mode = "ok";
  seen.length = 0;
  const svg = path.join(tmp, "x.svg");
  fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await assert.rejects(uploadTokenMetadata(base, { name: "A", symbol: "A", imagePath: svg }), /PNG, JPEG, WebP or GIF/);
  const big = path.join(tmp, "big.png");
  fs.writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(1_000_001)]));
  await assert.rejects(uploadTokenMetadata(base, { name: "A", symbol: "A", imagePath: big }), /limit is 1000000/);
  await assert.rejects(uploadTokenMetadata(base, { name: "A", symbol: "A", imagePath: path.join(tmp, "nope.png") }), /no such file/);
  await assert.rejects(uploadTokenMetadata(base, { name: "A", symbol: "A", imagePath: big, imageUrl: "https://a.example/x.png" }), /not both/);
  for (const u of ["http://example.com/x.png", "https://127.0.0.1/x.png", "https://localhost/x.png", "https://192.168.1.5/x.png", "https://[::1]/x.png", "file:///etc/passwd", "https://u:p@example.com/x.png"]) {
    await assert.rejects(uploadTokenMetadata(base, { name: "A", symbol: "A", imageUrl: u }), /imageUrl/, u);
  }
  assert.deepEqual(seen, [], "nothing was uploaded");
  await assert.rejects(uploadTokenMetadata(undefined, { name: "A", symbol: "A" }), /MURKFUN_INDEXER_URL/);
  await assert.rejects(uploadTokenMetadata(base, { name: "A", symbol: "A", description: "BAD" }), /upload refused \(400 bad_metadata\): «description contains control/);
  mode = "limited";
  await assert.rejects(uploadTokenMetadata(base, { name: "A", symbol: "A" }), /rate limit/);
  mode = "absent";
  await assert.rejects(uploadTokenMetadata(base, { name: "A", symbol: "A" }), /does not offer uploads/);
  mode = "ok";
  assert.ok(isPrivateHost("10.1.2.3") && isPrivateHost("printer.local") && !isPrivateHost("example.com") && !isPrivateHost("8.8.8.8"));
});

test("imageUrl: fetched with a size cap (declared or streamed), only images, no private hosts", async () => {
  await assert.rejects(loadImage({ imageUrl: "https://0.0.0.0/x.png" }), /private/);
  const serve = (body: BodyInit, headers: Record<string, string> = {}) => async () => new Response(body, { headers });
  assert.ok((await loadImage({ imageUrl: "https://img.example/cat.png" }, 1000, serve(new Uint8Array(PNG)))).equals(PNG));
  await assert.rejects(loadImage({ imageUrl: "https://img.example/big.png" }, 1000, serve("x", { "content-length": "2000000" })), /limit is 1000000/);
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(100_000)); c.close(); } });
  await assert.rejects(loadImage({ imageUrl: "https://img.example/stream.png" }, 1000, serve(stream)), /over 1000000 bytes/);
  await assert.rejects(loadImage({ imageUrl: "https://img.example/x.png" }, 1000, serve("<svg xmlns='http://www.w3.org/2000/svg'/>", { "content-type": "image/png" })), /PNG, JPEG, WebP or GIF/);
});

test("imageUrl: one deadline for the whole fetch: a server trickling bytes (or never answering) cannot hold the tool", async () => {
  let cancelled = false, aborted = false;
  const trickle: import("../src/upload.js").ImageGet = async (_u, _t, signal) => {
    signal.addEventListener("abort", () => (aborted = true));
    let timer: NodeJS.Timeout;
    const body = new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(PNG.subarray(0, 8))); timer = setInterval(() => c.enqueue(new Uint8Array(1)), 50); },
      cancel() { cancelled = true; clearInterval(timer); },
    });
    return new Response(body);
  };
  const t0 = Date.now();
  await assert.rejects(loadImage({ imageUrl: "https://img.example/slow.png" }, 400, trickle), /not loaded within 0.4 s/);
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(cancelled && aborted, "the body is cancelled and the request aborted");
  await assert.rejects(loadImage({ imageUrl: "https://img.example/hang.png" }, 300, () => new Promise(() => {})), /not loaded within 0.3 s/);
});

test("imagePath: an error shows the home directory as ~", async () => {
  await assert.rejects(loadImage({ imagePath: "~/murkfun-no-such-image.png" }), (e: Error) => e.message === "imagePath: no such file ~/murkfun-no-such-image.png");
});

test("private hosts: NAT64, 6to4, Teredo, site-local, multicast and IETF / documentation ranges are refused", () => {
  for (const h of ["[64:ff9b::7f00:1]", "64:ff9b:1::a00:1", "2002:7f00:1::1", "2001:0:4136:e378::1", "fec0::1", "ff02::1", "::7f00:1", "2001:db8::1",
    "192.0.0.1", "192.0.2.1", "198.51.100.7", "203.0.113.9", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) assert.ok(isPrivateHost(h), h);
  for (const h of ["2606:4700::1111", "2a00:1450:4001::200e", "1.1.1.1", "192.1.0.1", "2001:4860:4860::8888"]) assert.equal(isPrivateHost(h), false, h); // test data: public IPs (public addresses that must not count as private)
});

test("imageUrl: every redirect target is checked before it is requested; names resolving to private addresses are refused", async () => {
  const requested: string[] = [];
  const hops = (to: string) => async (u: URL) => {
    requested.push(u.href);
    return u.hostname === "img.example" ? new Response(null, { status: 302, headers: { location: to } }) : new Response(new Uint8Array(PNG));
  };
  for (const to of ["http://127.0.0.1:8000/admin", "https://127.0.0.1/x.png", "https://[::1]/x.png", "https://10.0.0.5/x.png", "http://cdn.example/x.png"]) {
    requested.length = 0;
    await assert.rejects(loadImage({ imageUrl: "https://img.example/a.png" }, 1000, hops(to)), /imageUrl/, to);
    assert.deepEqual(requested, ["https://img.example/a.png"], `${to} is never requested`);
  }
  requested.length = 0;
  assert.ok((await loadImage({ imageUrl: "https://img.example/a.png" }, 1000, hops("https://cdn.example/x.png"))).equals(PNG));
  assert.deepEqual(requested, ["https://img.example/a.png", "https://cdn.example/x.png"]);
  const loop = async () => new Response(null, { status: 301, headers: { location: "https://img.example/again.png" } });
  await assert.rejects(loadImage({ imageUrl: "https://img.example/a.png" }, 1000, loop), /redirects/);
  // the real client resolves the name first and refuses a private answer (localhost resolves to 127.0.0.1 / ::1)
  await assert.rejects(loadImage({ imageUrl: "https://localtest.me/x.png" }, 3000), /private|ENOTFOUND|EAI_AGAIN|resolve/);
  assert.ok(isPrivateHost("198.18.0.1") && isPrivateHost("224.0.0.1") && isPrivateHost("255.255.255.255"));
});
