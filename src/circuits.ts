// 0xbow Privacy Pools v2 circuit artifacts (ceremony keys). Downloaded on first use into MURKFUN_CIRCUITS_DIR and
// checked against pinned sha256 hashes: the files whose proofs the BSC verifiers accept. Fetched from a pinned commit of
// the 0xbow repository (not its moving main branch).
import fs from "fs";
import path from "path";
import crypto from "crypto";

const COMMIT = "61fac03acd1fc306164ddc234f7fac4147d04493";
const BASE = `https://media.githubusercontent.com/media/0xbow-io/privacy-pools-v2-monorepo/${COMMIT}/packages/circuits/build`;
export const CIRCUIT_FILES: Record<string, string> = {
  "deposit/deposit_js/deposit.wasm": "833e7b3c44a900a95496009a36284e11f57ba0385fab6b63f92075750817550a",
  "deposit/groth16_pkey.zkey": "e6fb5283c7b7511b0422a773d9f054925969e47e8ddf55a6b38b590c951a73a4",
  "transact_1x1/transact_1x1_js/transact_1x1.wasm": "bd13ab4130320f095cdee83b42e27877fc6c17f18be3fbdfc55436d33689d262",
  "transact_1x1/groth16_pkey.zkey": "e92ad88f417c034f073580658839b64fdd1ad3c89a86a9faa926728f80351121",
};

const sha256 = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/** Make sure every artifact of `circuit` (or all) exists in `dir` with the pinned hash; download what is missing. */
export async function ensureCircuits(dir: string, circuit?: string, log: (m: string) => void = (m) => console.error(m)) {
  for (const [rel, hash] of Object.entries(CIRCUIT_FILES)) {
    if (circuit && !rel.startsWith(`${circuit}/`)) continue;
    const f = path.join(dir, rel);
    if (fs.existsSync(f)) {
      if (sha256(f) !== hash) throw new Error(`circuit file ${f} does not match the pinned sha256; delete it to re-download`);
      continue;
    }
    log(`murkfun: downloading 0xbow circuit ${rel} ...`);
    const r = await fetch(`${BASE}/${rel}`, { signal: AbortSignal.timeout(300_000) });
    if (!r.ok) throw new Error(`download ${rel}: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    if (got !== hash) throw new Error(`downloaded ${rel} has sha256 ${got}, expected ${hash}; refusing to use it`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.tmp`, buf);
    fs.renameSync(`${f}.tmp`, f);
  }
}
