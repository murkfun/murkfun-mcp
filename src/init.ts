// `murkfun-mcp init`: everything a user needs after installing the package (`npm install -g` of its GitHub release).
// Creates MURKFUN_HOME (0700) and a random vault passphrase file (0600) unless one exists, downloads the 0xbow circuits
// (sha256-checked) and the order prover (Barretenberg bb 6.0.0: a download is sha256-pinned, a bb 6.0.0 already on the
// PATH is used as is; the compiled order circuit ships with the package), and prints the MCP client config.
// Idempotent: an existing passphrase file is never touched.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ensureCircuits } from "./circuits.js";
import { ensureBb } from "./orders.js";

export interface InitOptions {
  home: string;
  circuitsDir: string;
  /** Circuit download + check; tests pass a stub. */
  ensure?: (dir: string) => Promise<void>;
  /** The order prover (bb) download + check; tests pass a stub. */
  ensureProver?: (home: string) => Promise<string>;
  log?: (m: string) => void;
}

export interface InitResult {
  home: string;
  passphraseFile: string;
  /** false: the passphrase file already existed and was kept as it is. */
  createdPassphrase: boolean;
  circuitsDir: string;
}

export const PASSPHRASE_BACKUP_NOTE = "Store a copy of it OFFLINE: encrypted backups are useless without it.";

export async function initHome(o: InitOptions): Promise<InitResult> {
  const log = o.log ?? ((m: string) => console.error(m));
  fs.mkdirSync(o.home, { recursive: true, mode: 0o700 });
  fs.chmodSync(o.home, 0o700);
  const passphraseFile = path.join(o.home, "passphrase");
  let createdPassphrase = false;
  try {
    // "wx": create only; an existing file (even one created by a concurrent init) is never overwritten
    fs.writeFileSync(passphraseFile, crypto.randomBytes(24).toString("base64url"), { mode: 0o600, flag: "wx" });
    createdPassphrase = true;
    log(`Created ${passphraseFile} (random). ${PASSPHRASE_BACKUP_NOTE}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    log(`Kept the existing ${passphraseFile}. ${PASSPHRASE_BACKUP_NOTE}`);
  }
  await (o.ensure ?? ((d: string) => ensureCircuits(d)))(o.circuitsDir);
  log(`circuits ok in ${o.circuitsDir}`);
  const bb = await (o.ensureProver ?? ((h: string) => ensureBb({ bb: process.env.MURKFUN_BB || undefined, cacheDir: path.join(h, "bin"), download: process.env.MURKFUN_BB_DOWNLOAD !== "0" })))(o.home);
  log(`order prover ok: ${bb}`);
  return { home: o.home, passphraseFile, createdPassphrase, circuitsDir: o.circuitsDir };
}
