# MurkFun token metadata

A MurkFun token carries three strings on-chain, all fixed at creation: `name()`, `symbol()` (ERC20) and `metadataURI()`
(`MurkFunToken`). The URI is also part of the token's address (CreateX CREATE3, `MurkFunFactory.predictTokenAddress`), so it can never
change. Everything else (description, image, links) lives in an off-chain JSON document that the URI points to.

## Format

`metadataURI` = `ipfs://<CID>` of a JSON document (CIDv1 recommended, e.g. `ipfs://bafkrei…`). Schema:
[`docs/token-metadata.schema.json`](token-metadata.schema.json).

```json
{
  "schema": "murkfun-token-metadata/v1",
  "name": "MurkFun Cat",
  "symbol": "MCAT",
  "description": "A cat that lives in the murk.",
  "image": "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  "links": {
    "website": "https://example.com",
    "x": "https://x.com/example",
    "telegram": "https://t.me/example"
  }
}
```

| Field | Rules |
|---|---|
| `schema` | Required, exactly `murkfun-token-metadata/v1`. |
| `name`, `symbol` | Required. Must equal the token's on-chain `name()` / `symbol()`; if they differ, readers ignore the whole document. `name` ≤ 64 chars, `symbol` ≤ 16 (the MCP's limits). |
| `description` | Optional plain text, ≤ 1,000 chars. Never rendered as HTML or Markdown. |
| `image` | Optional `ipfs://<CID>` of a square PNG, JPEG, WebP or GIF, 256–1024 px, ≤ 1 MB. **No SVG** (it can carry script). |
| `links` | Optional. Keys from `website`, `x`, `telegram`, `discord`, `github`; values `https://` URLs ≤ 200 chars. Unknown keys are ignored. |

The document must be ≤ 16 KB. Other fields are ignored (`external_url` is accepted as an alias of `links.website` for
wallets that expect the ERC-721/1155 metadata shape).

`https://` URIs are accepted but readers mark them "mutable" (the host can change them after launch). `data:` URIs and
anything else are not displayed. An empty URI is allowed; the site then shows the generated avatar.

## Reading it (indexer, site, MCP)

- Fetch through a gateway you control (or several public ones) with a short timeout and the size caps above. Cache by
  CID forever (IPFS content is immutable).
- Validate against the schema; check `name`/`symbol` against the chain; drop links that are not `https://`.
- Serve the image re-encoded (or at least with `Content-Type` from the sniffed bytes and `Content-Security-Policy:
  sandbox`), never inline the original bytes into a page.
- Treat everything as untrusted user content: MurkFun does not endorse links, and names can impersonate other projects.

MurkFun does this for every listed token: token responses carry a `metadata` object
(`status: ok | pending | invalid | mismatch | external | unsupported`, `description`, `image`, `imageUrl`, `links`,
`mutable`; see [API.md](API.md)) and `image`, the image served by MurkFun's API at `GET /v1/ipfs/<CID>`. `https://` URIs
are not fetched by the server (the host could change them, and fetching arbitrary URLs server-side is an SSRF risk):
they come back as `status: "external"`, `mutable: true`, without a description or image.

## Uploading and pinning (where the files live)

IPFS keeps a file only while some node pins it. MurkFun offers an upload API and pins the files itself, so a launch
needs no pinning account.

### Default: upload through MurkFun (`upload_token_metadata`)

The MCP tool `upload_token_metadata {name, symbol, description?, imagePath? | imageUrl?, links?}` does both steps and
returns the `metadataURI` to pass to `create_token`. Under the hood it calls MurkFun's API (`MURKFUN_INDEXER_URL`, or
`MURKFUN_UPLOAD_URL`):

1. `POST /v1/ipfs/image`, body = the raw image bytes (≤ 1 MB). The type comes from the magic bytes (PNG, JPEG, WebP,
   GIF; never SVG; the `Content-Type` header is ignored). The image must be **square, 256–1024 px** (crop / resize it
   first). The server rebuilds the file without anything that is
   not needed to draw it: EXIF / GPS / XMP, ICC profiles, text chunks, comments, thumbnails and anything appended to
   the file (polyglots) are dropped (a JPEG keeps only its orientation); the pixels are not changed. GIF / WebP / PNG animation is kept (≤ 300 frames). It is added as CIDv1
   and pinned. Answer: `{cid, uri: "ipfs://<cid>", url, width, height, bytes, format, animated, stripped}`.
2. `POST /v1/ipfs/metadata`, `Content-Type: application/json`, body `{name, symbol, description?, image?, links?}` (the
   same limits as the schema; `image` must be `ipfs://<CID>`; unknown fields or link keys are refused). The server
   builds the canonical document itself: `"schema"` first, then `name`, `symbol`, `description`, `image`, `links`
   (links in the order website, x, telegram, discord, github), no whitespace, no other fields. The same input therefore
   always gives the same bytes and the same CID (`ipfs add --cid-version 1` of those bytes). Answer:
   `{cid, uri, url, bytes, document}`.

Limits: a few uploads per minute (and per day) per IP, a daily total, and a budget for uploads no token uses yet
(HTTP 429 / 503 / 507). Uploads that no listed token references within 72 h are unpinned; once a listed token uses a metadata CID, it and its image stay pinned for good.

### Still allowed: pin it yourself

A dev may pin the image and the JSON on any pinning service (Pinata, Filebase, Storacha / web3.storage, 4EVERLAND, …)
or their own node, and pass that `ipfs://<CID>`:

```sh
exiftool -all= cat.png                              # strip EXIF (GPS, camera, timestamps) first
ipfs add --cid-version 1 --pin cat.png              # -> bafy… (image CID)
# write metadata.json with "image": "ipfs://<image CID>", then
ipfs add --cid-version 1 --pin metadata.json        # -> bafk… (metadata CID)
```

`ipfs add --only-hash --cid-version 1 <file>` computes the CID without uploading, so the URI can be checked before
anything is published. Upload the same bytes to the pinning service; its CID must match. Then
`create_token {…, metadataURI: "ipfs://<metadata CID>"}`. Never make up a CID: the URI is permanent.

### The platform re-pins every listed token

On every `TokenCreated` with an `ipfs://` URI (uploaded through MurkFun or anywhere else), MurkFun pins the metadata by CID, reads it back (timeout, 16 KB cap) and validates it, then does the same for its image (1 MB cap, must be PNG /
JPEG / WebP / GIF). Failures are retried with backoff (indexing never waits for it), and MurkFun is
alerted when a listed token's metadata stays unfetchable. Documents that are too big, not JSON, or images that are not images are marked invalid and
not pinned. So a token page keeps working when the dev's own pin lapses.

### Moderation: what the site shows

Anyone can put any `metadataURI` on chain, and the chain cannot be cleaned, so MurkFun moderates what **it** shows and
hosts. Everything is shown as soon as it is indexed or uploaded. Token names, symbols and metadata text go through a word
list (a metadata upload that hits it is refused); images are not classified by MurkFun (the CDN in front of the API domain scans what
passes through its cache for CSAM). Content the word list flags, and content MurkFun's operators hide, is withdrawn from then
on: the token API no longer returns it (`moderation: "flagged" | "hidden"`), the image / document URL answers 404, and
MurkFun unpins it and never re-pins it. A token whose name or symbol is withdrawn
is shown by its address with a neutral placeholder. Trading (curve, trades, holders) is never affected, and copies
pinned elsewhere are outside MurkFun's control.

### Secrets and privacy

- **Uploading through MurkFun reveals your IP address to MurkFun's server** while the request runs. It is used only for
  the upload rate limit (kept as a keyed hash with a salt of the day, gone after two days) and never stored with the
  upload. A dev who does not want to show it at all can upload over Tor / a VPN or pin elsewhere.
- Strip personal data before anything leaves the machine: MurkFun strips uploaded images (EXIF / GPS removed), but a
  file pinned elsewhere is published as is (`exiftool -all=` first). Personal data inside the pixels (a face, a
  street sign) is never removed by anyone. The JSON itself must not contain anything
  personal; the image and the document are public forever once a token uses them.
- Pinning-service API keys / JWTs (own pinning) are secrets. Keep them in the environment or a secret store of the
  machine that uploads. Never put them in the repo, in metadata, in MCP tool arguments or outputs, or in a URL that ends
  up in a log. The MurkFun MCP does not handle pinning credentials.
- A file pinned through a pinning service is linked to that account and its uploader's IP. A dev who wants their launch
  unlinked from their identity should use an account and network path that are not tied to them.
