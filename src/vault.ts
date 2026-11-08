// Encrypted local secret store: scrypt (N=2^15) -> AES-256-GCM. Written atomically with mode 0600.
// `seedSig` is the wallet's signature over the fixed MurkFun seed message (orders.ts): the identity secret behind every
// pseudonym (H(secret, token)); it alone can not trade, every order needs a fresh wallet signature. `seed` (the 0xbow
// keys and note secrets) is derived from it. Re-signing with the same wallet gives both back: the wallet is the backup.
// The wallet (holder of the SPACE ID Agent ID) is a key held here (eoaKey) or the Binance Agentic Wallet driven through
// its CLI (account + signer "baw"; no key exists). The deposits and notes can be found again on-chain from the seed
// (recover in agent.ts).
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import type { Address, Hex } from "viem";

export interface DepositRec {
  index: number; value: string; label: string; commitment: string; txHash?: Hex; timestamp?: string; createdAt: number;
}
export interface NoteRec {
  depositIndex: number; spendIndex: number; value: string; label: string; commitment: string;
  timestamp?: string; status: "unspent" | "pending" | "spent";
  /** While `pending`: the last order the relayer accepted for it, its deadline and the change note it creates (settled later). */
  spend?: { orderId: string; changeCommitment: string; changeValue: string; deadline?: string };
}
export interface OrderRec {
  id: string; action: string; token?: string; txHash?: Hex; status: string; createdAt: number; detail?: string;
}
/** A Railgun-paid order waiting for its Railgun transactions (submit_railgun): the relayer body without them and what
 *  they must be bound to. */
export interface RailgunRelayRec {
  id: string; action: "railgunBuy" | "railgunFund" | "railgunLaunch"; token: Address; createdAt: number; deadline: string;
  /** pending (not accepted by the relayer yet), submitted (accepted: order_status), then the order's final status */
  status: string; orderId?: string;
  adapter: Address; adaptParams: Hex; wbnb: Address; grossWei: string; offeredWei: string;
  body: Record<string, unknown>;
}
export interface VaultData {
  version: 1;
  seedSig?: Hex; // the wallet's seed signature (set once by setup)
  seed?: Hex; // the 0xbow seed, derived from seedSig
  eoaKey?: Hex; // the wallet's key, when it is held here
  account?: Address; // the Binance Agentic Wallet's address (signer "baw")
  signer?: "baw"; // the wallet signs and sends through the Binance Agentic Wallet CLI (`baw`)
  createdAt: number;
  deposits: DepositRec[];
  notes: NoteRec[];
  orders: OrderRec[];
  tokens: string[];
  relayers?: Record<string, Address>; // relayer URL -> the relayer address its first quote named (the pin)
  railgunRelays?: RailgunRelayRec[]; // Railgun-paid orders waiting for (or sent with) their Railgun transactions
}

interface Envelope { v: 1; kdf: "scrypt"; N: number; r: number; p: number; salt: string; iv: string; tag: string; ct: string }

const KDF = { N: 1 << 15, r: 8, p: 1 };
const key = (pass: string, salt: Buffer, e = KDF) => crypto.scryptSync(pass, salt, 32, { ...e, maxmem: 256 * 1024 * 1024 });

export function encrypt(data: VaultData, pass: string): Envelope {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(pass, salt), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(data), "utf8"), c.final()]);
  return { v: 1, kdf: "scrypt", ...KDF, salt: salt.toString("hex"), iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), ct: ct.toString("base64") };
}

export function decrypt(env: Envelope, pass: string): VaultData {
  const d = crypto.createDecipheriv("aes-256-gcm", key(pass, Buffer.from(env.salt, "hex"), { N: env.N, r: env.r, p: env.p }), Buffer.from(env.iv, "hex"));
  d.setAuthTag(Buffer.from(env.tag, "hex"));
  try {
    return JSON.parse(Buffer.concat([d.update(Buffer.from(env.ct, "base64")), d.final()]).toString("utf8"));
  } catch {
    throw new Error("cannot decrypt the vault: wrong MURKFUN_PASSPHRASE or corrupted file");
  }
}

/** A backup file's envelope. A file that is not one (e.g. a raw key file pointed at by mistake) must not echo any of
 *  its text in the error: JSON.parse quotes the start of its input, and tool errors go to the model. */
function readBackup(src: string): Envelope {
  let env: any;
  try {
    env = JSON.parse(fs.readFileSync(src, "utf8"));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code ? `cannot read the backup (${code})` : "not a MurkFun vault backup");
  }
  if (!env || typeof env !== "object" || env.v !== 1 || !["salt", "iv", "tag", "ct"].every((k) => typeof env[k] === "string")) {
    throw new Error("not a MurkFun vault backup");
  }
  return env;
}

export class Vault {
  data!: VaultData;
  /** The file as this process last read or wrote it (another process may write it meanwhile: see refresh). */
  private stamp?: string;
  constructor(readonly file: string, private pass: string) {}

  private fileStamp() {
    try { const s = fs.statSync(this.file); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return undefined; }
  }

  /** Re-read the file if another process (an MCP server, a CLI call) changed it since this one loaded or saved it.
   *  True if it was re-read. */
  refresh(): boolean {
    if (!this.data) return false;
    const now = this.fileStamp();
    if (!now || now === this.stamp) return false;
    this.load();
    return true;
  }

  exists() { return fs.existsSync(this.file); }

  /** A new vault for the wallet: a key held here (`eoaKey`, or a new random key) or the Binance Agentic Wallet
   *  (`account` + signer "baw"). The seed signature is added by setup. */
  create(o: { eoaKey?: Hex; account?: Address; signer?: "baw" }): VaultData {
    if (this.exists()) throw new Error(`vault already exists at ${this.file}`);
    const rnd = () => `0x${crypto.randomBytes(32).toString("hex")}` as Hex;
    this.data = {
      version: 1, createdAt: Date.now(), deposits: [], notes: [], orders: [], tokens: [],
      ...(o.account ? { account: o.account, ...(o.signer ? { signer: o.signer } : {}) } : { eoaKey: o.eoaKey ?? rnd() }),
    };
    this.save();
    return this.data;
  }

  load(): VaultData {
    const stamp = this.fileStamp();
    this.data = decrypt(JSON.parse(fs.readFileSync(this.file, "utf8")), this.pass);
    this.stamp = stamp;
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(encrypt(this.data, this.pass)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.stamp = this.fileStamp();
  }

  /** Encrypted copy (same passphrase) at `dest`: written to a new 0600 file, then moved over `dest` (never readable by
   *  others, not even briefly). */
  backup(dest: string) {
    this.save();
    const to = path.resolve(dest);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    const tmp = `${to}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, fs.readFileSync(this.file), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, to);
  }

  /** `p` with the user's home directory shown as `~` (tool results go to the model provider: no user name). */
  static shown(p: string): string {
    const home = os.homedir(), abs = path.resolve(p);
    return home && (abs === home || abs.startsWith(home + path.sep)) ? `~${abs.slice(home.length)}` : abs;
  }

  /** A backup file's contents, without replacing anything (must decrypt with the same passphrase). */
  peek(src: string): VaultData {
    return decrypt(readBackup(src), this.pass);
  }

  /** Replace the current vault with a backup file (must decrypt with the same passphrase). */
  restore(src: string) {
    const d = decrypt(readBackup(src), this.pass);
    this.data = d;
    this.save();
  }
}
