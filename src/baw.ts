// Signer backend: the Binance Agentic Wallet CLI (`baw`, npm @binance/agentic-wallet). A Binance agent wallet has no
// exportable private key; it signs on Binance's side after `baw auth signin`, and the CLI exposes a two-step
// preview -> execute flow for user-built transactions and EIP-712 messages (Developer Mode must be on in the Binance
// App: Agentic Wallet management page -> Settings -> Developer Mode). Shapes used here (CLI 1.12.0 and the
// binance-agentic-wallet skill's references/external-sign.md); every command prints {success, data} or
// {success:false, error:{code, name, message}} on stdout with --json:
//   baw wallet address --json                         data.addresses[] {binanceChainId, chainName, address}
//   baw sign-message preview --binanceChainId 56 --message '<eth_signTypedData_v4 JSON-RPC>' --signType EIP712 --json
//                                                     data.requestId, data.requireConfirmation, data.risks
//   baw sign-message execute --requestId <id> --json  data.status COMPLETED | PENDING_CONFIRMATION,
//                                                     data.signature (r||s, 64 bytes hex, no 0x), data.signatureRecovery "00"/"01"
//   baw contract-call preview --binanceChainId 56 --from <a> --to <c> --value <wei> --inputData <hex> [--gasLimit n] --json
//                                                     data.requestId, data.simulationResult {simulationCode "000000000" = ok,
//                                                     simulationErrorDetail}, data.requireConfirmation, data.risks
//   baw contract-call execute --requestId <id> --json data.status BROADCASTED | PENDING_CONFIRMATION, data.txHash, data.orderId
// requireConfirmation = true means execute would create an order that waits for approval in the Binance App: we stop
// before execute and tell the user. The CLI's stdout is never logged or put into an error: for sign-message execute
// it carries the signature, which is the MurkFun identity secret. The CLI's session files are never read here.
import { execFile } from "child_process";
import { getAddress, hexToBytes, isAddress, toHex, type Address, type Hex } from "viem";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; // secp256k1 order
const SIM_OK = "000000000";

export class BawError extends Error {}

export interface BawOptions { bin: string; account?: Address; chainId: number; timeoutMs?: number }
export interface BawTx { from: Address; to: Address; value: bigint; data: Hex; gas?: bigint }

type Risks = { riskDetails?: { title?: string; description?: string; riskType?: string }[]; addresses?: Record<string, { riskLevel?: number; riskDetails?: { title?: string; description?: string; riskType?: string }[] }> };

/** Blocking risk items (riskType RISK) in a preview; CAUTION items are allowed through. */
function blockingRisks(r: Risks | undefined): string[] {
  const out: string[] = [];
  for (const d of r?.riskDetails ?? []) if (d.riskType !== "CAUTION") out.push(`${d.title ?? "risk"}: ${d.description ?? ""}`.trim());
  for (const [a, v] of Object.entries(r?.addresses ?? {})) {
    for (const d of v.riskDetails ?? []) if (d.riskType !== "CAUTION") out.push(`${a} ${d.title ?? "risk"}: ${d.description ?? ""}`.trim());
  }
  return out;
}

/** 64-byte r||s hex (with or without 0x) + recovery "00"/"01" (or "1b"/"1c") -> 65-byte low-s r||s||v, v in {27, 28}.
 *  A high-s signature is folded to its low-s twin (s' = n - s, v flipped), which is deterministic, so the same baw
 *  signature always gives the same bytes (and the same seed). */
export function bawSignature(signature: string, recovery: string): Hex {
  const hex = signature.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{128}$/.test(hex)) throw new BawError("BAW_BAD_SIGNATURE: baw returned a signature that is not 64 bytes of r||s hex");
  const rec = Number.parseInt(String(recovery).trim(), 16);
  if (![0, 1, 27, 28].includes(rec)) throw new BawError("BAW_BAD_SIGNATURE: baw returned an invalid signatureRecovery");
  let v = rec < 27 ? rec + 27 : rec;
  const b = hexToBytes(`0x${hex}`);
  let s = BigInt(toHex(b.slice(32, 64)));
  if (s === 0n || s >= N) throw new BawError("BAW_BAD_SIGNATURE: baw returned an invalid s");
  if (s > N / 2n) { s = N - s; v = v === 27 ? 28 : 27; }
  return `0x${hex.slice(0, 64)}${s.toString(16).padStart(64, "0")}${v.toString(16)}` as Hex;
}

export class BawSigner {
  constructor(readonly o: BawOptions) {}

  private get chain() { return String(this.o.chainId); }

  /** Run one baw command with --json. `secret`: its output holds a secret (never include any of it in an error). */
  private run(args: string[], secret = false): Promise<any> {
    const what = `baw ${args.slice(0, 2).join(" ")}`;
    return new Promise((resolve, reject) => {
      execFile(this.o.bin, [...args, "--json"], { timeout: this.o.timeoutMs ?? 180_000, maxBuffer: 8 << 20, windowsHide: true }, (err, stdout, stderr) => {
        let j: any;
        try { j = JSON.parse(String(stdout)); } catch { j = undefined; }
        if (j && j.success === true) return resolve(j.data ?? {});
        if (j && j.success === false && j.error) {
          const e = j.error;
          return reject(new BawError(`BAW_${e.name ?? "ERROR"}: ${what} failed (${e.code ?? "?"}): ${String(e.message ?? "").slice(0, 300)}${bawHint(e.code)}`));
        }
        if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
          return reject(new BawError(`BAW_NOT_FOUND: the Binance Agentic Wallet CLI was not found at ${JSON.stringify(this.o.bin)}: install it (npm i -g @binance/agentic-wallet), run \`baw auth signin\`, or set MURKFUN_BAW_PATH`));
        }
        const detail = secret ? "" : `: ${String(stderr || "").trim().split("\n")[0].slice(0, 200)}`;
        reject(new BawError(`BAW_FAILED: ${what} failed${err ? ` (${(err as { code?: unknown }).code ?? err.message.split("\n")[0]})` : " (no JSON output)"}${detail}`));
      });
    });
  }

  /** The agent wallet's address on this chain (`baw wallet address`); with an account configured, it must be one of them. */
  async address(): Promise<Address> {
    const d = await this.run(["wallet", "address"]);
    const list: Address[] = (d.addresses ?? []).filter((a: any) => String(a.binanceChainId) === this.chain && isAddress(a.address)).map((a: any) => getAddress(a.address));
    const uniq = [...new Set(list)];
    if (this.o.account) {
      const want = getAddress(this.o.account);
      if (!uniq.includes(want)) throw new BawError(`BAW_ACCOUNT_MISMATCH: the signed-in Binance Agentic Wallet has no address ${want} on chain ${this.chain} (it has ${uniq.join(", ") || "none"}): sign in to the right account (baw auth signin) or fix MURKFUN_BAW_ACCOUNT`);
      return want;
    }
    if (uniq.length === 0) throw new BawError(`BAW_NO_ADDRESS: the Binance Agentic Wallet has no address on chain ${this.chain}: run \`baw auth signin\` and \`baw wallet address\``);
    if (uniq.length > 1) throw new BawError(`BAW_SEVERAL_ADDRESSES: the Binance Agentic Wallet has several addresses on chain ${this.chain} (${uniq.join(", ")}): set MURKFUN_BAW_ACCOUNT to the one that holds the SPACE ID Agent ID`);
    return uniq[0];
  }

  /** EIP-712 signature (eth_signTypedData_v4 JSON) by `from`, as 65-byte low-s hex. Stops if the Binance App has to confirm. */
  async signTypedData(from: Address, typedDataJson: unknown): Promise<Hex> {
    const message = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_signTypedData_v4", params: [getAddress(from), JSON.stringify(typedDataJson)] });
    const p = await this.run(["sign-message", "preview", "--binanceChainId", this.chain, "--message", message, "--signType", "EIP712"]);
    if (!p.requestId) throw new BawError("BAW_PREVIEW_FAILED: sign-message preview returned no requestId (intercepted?); nothing was signed");
    const risks = blockingRisks(p.risks);
    if (risks.length) throw new BawError(`BAW_RISK: the Binance wallet flagged the MurkFun seed message (${risks.join("; ")}); nothing was signed`);
    if (p.requireConfirmation) {
      throw new BawError("BAW_CONFIRMATION_REQUIRED: the Binance Agentic Wallet wants this signature approved in the Binance App; MurkFun did not execute it. Ask the user to check the wallet's security settings (Developer Mode on, no extra confirmation for message signing), then call again");
    }
    const e = await this.run(["sign-message", "execute", "--requestId", String(p.requestId)], true);
    if (e.status !== "COMPLETED" || !e.signature) {
      throw new BawError(`BAW_NOT_SIGNED: sign-message execute status ${e.status ?? "?"}${e.orderId ? ` (order ${e.orderId})` : ""}; nothing was derived${e.status === "PENDING_CONFIRMATION" ? ": approve it in the Binance App, then call again" : ""}`);
    }
    return bawSignature(e.signature, e.signatureRecovery);
  }

  /** Sign twice and require identical bytes: the seed is derived from the signature, so a wallet that does not sign
   *  deterministically cannot be the backup (re-signing later would give another identity). */
  async signTypedDataTwice(from: Address, typedDataJson: unknown): Promise<Hex> {
    const a = await this.signTypedData(from, typedDataJson);
    const b = await this.signTypedData(from, typedDataJson);
    if (a.toLowerCase() !== b.toLowerCase()) {
      throw new BawError("BAW_NONDETERMINISTIC: the Binance Agentic Wallet signed the same MurkFun seed message twice with different signatures. MurkFun needs a deterministic signer (one seed signature per wallet: one pseudonym per token, and the wallet as the backup); nothing was stored");
    }
    return a;
  }

  /** Preview (simulate + risk check) and execute a contract call from `from`; returns the tx hash. Never executes when
   *  the simulation fails, a blocking risk is flagged or the Binance App would have to confirm. */
  async sendTransaction(tx: BawTx): Promise<Hex> {
    const args = ["contract-call", "preview", "--binanceChainId", this.chain, "--from", getAddress(tx.from), "--to", getAddress(tx.to), "--value", tx.value.toString(), "--inputData", tx.data];
    if (tx.gas !== undefined) args.push("--gasLimit", tx.gas.toString());
    const p = await this.run(args);
    if (!p.requestId) throw new BawError("BAW_PREVIEW_FAILED: contract-call preview returned no requestId (intercepted?); nothing was sent");
    const sim = p.simulationResult ?? {};
    if (sim.simulationCode !== undefined && String(sim.simulationCode) !== SIM_OK) {
      throw new BawError(`BAW_SIMULATION_FAILED: the Binance wallet's simulation failed (${sim.simulationCode}${sim.simulationErrorDetail ? `: ${String(sim.simulationErrorDetail).slice(0, 300)}` : ""}); nothing was sent`);
    }
    const risks = blockingRisks(p.risks);
    if (risks.length) throw new BawError(`BAW_RISK: the Binance wallet flagged this transaction (${risks.join("; ")}); nothing was sent. Tell the user`);
    if (p.requireConfirmation) {
      throw new BawError("BAW_CONFIRMATION_REQUIRED: the Binance Agentic Wallet wants this transaction approved in the Binance App (over a limit or a security setting); MurkFun did not execute it. Tell the user; after they change the setting (or raise the limit), call again");
    }
    const e = await this.run(["contract-call", "execute", "--requestId", String(p.requestId)]);
    if (e.status !== "BROADCASTED" || !/^0x[0-9a-fA-F]{64}$/.test(e.txHash ?? "")) {
      throw new BawError(`BAW_NOT_BROADCAST: contract-call execute status ${e.status ?? "?"}${e.orderId ? ` (order ${e.orderId})` : ""}${e.message ? `: ${String(e.message).slice(0, 200)}` : ""}`);
    }
    return e.txHash as Hex;
  }
}

/** Known baw error codes (external-sign.md) -> what to tell the user. */
function bawHint(code: unknown): string {
  switch (Number(code)) {
    case 351802: return " (Developer Mode expired: enable it again in the Binance App, Agentic Wallet management page → Settings → Developer Mode)";
    case 351803: return " (the Binance wallet blocked it as high risk; nothing was sent)";
    case 351804: return " (Developer Mode can only be enabled below the balance cap)";
    case 351805: return " (the Binance wallet's simulation failed; nothing was sent)";
    default: return "";
  }
}
