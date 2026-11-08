// Local safety rules of the vault tools and the order validity, without a chain: export_recovery writes only inside
// MURKFUN_HOME / MURKFUN_EXPORT_DIR, backup never replaces a file unasked, a malformed recovery file or backup echoes
// nothing of itself, a signed order's validity is bounded by MURKFUN_MAX_ORDER_VALIDITY_S, a negative sell is refused, and a
// destination that is the user's own wallet comes back with a privacy warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keccak256, toBytes, zeroAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { configFromEnv } from "../src/config.js";
import { MurkFunAgent, OWN_WALLET_PRIVACY } from "../src/agent.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "murkfun-mcp-safety-"));
const KEY = keccak256(toBytes("murkfun.test.key1"));
const DEP = {
  market: "0x0000000000000000000000000000000000001001", factory: "0x0000000000000000000000000000000000001002",
  orders: "0x0000000000000000000000000000000000001003", holderRoots: "0x0000000000000000000000000000000000001004",
  locker: "0x0000000000000000000000000000000000001005", privacyPoolAdapter: "0x0000000000000000000000000000000000001006",
  deployBlock: 100,
};

/** An agent on a fresh home with a local wallet vault (nothing is read from a chain). */
function agentIn(name: string, env: Record<string, string> = {}) {
  const home = path.join(tmp, name, ".murkfun");
  const cfg = configFromEnv({
    MURKFUN_HOME: home, MURKFUN_PASSPHRASE: "a long test passphrase", MURKFUN_DEPLOYMENT: JSON.stringify(DEP),
    MURKFUN_RELAYER_URL: "http://127.0.0.1:1", MURKFUN_RPC: "http://127.0.0.1:9", ...env,
  });
  const agent = new MurkFunAgent(cfg);
  return { agent: agent as any, home, cfg };
}

test("export_recovery writes only inside MURKFUN_HOME or MURKFUN_EXPORT_DIR (set by the user)", async () => {
  const usb = path.join(tmp, "usb");
  const { agent, home } = agentIn("export", { MURKFUN_EXPORT_DIR: usb });
  agent.vault.create({ eoaKey: KEY });
  for (const p of [path.join(tmp, "elsewhere.json"), path.join(os.homedir(), ".bashrc-murkfun-test"), `${home}-sibling/r.json`, home]) {
    await assert.rejects(agent.exportRecovery({ path: p, confirm: true }), /writes only inside .*MURKFUN_HOME, MURKFUN_EXPORT_DIR.*nothing was written/, p);
    assert.equal(fs.existsSync(p) && p !== home, false, p);
  }
  const inHome = path.join(home, "recovery.json");
  assert.equal((await agent.exportRecovery({ path: inHome, confirm: true })).deposits, 0);
  assert.equal(JSON.parse(fs.readFileSync(inHome, "utf8")).walletKey, KEY);
  assert.equal(fs.statSync(inHome).mode & 0o777, 0o600);
  await agent.exportRecovery({ path: path.join(usb, "murkfun", "recovery.json"), confirm: true });
  assert.ok(fs.existsSync(path.join(usb, "murkfun", "recovery.json")));
  // without MURKFUN_EXPORT_DIR the error says how the user allows one more directory
  const other = agentIn("export-no-dir");
  other.agent.vault.create({ eoaKey: KEY });
  await assert.rejects(other.agent.exportRecovery({ path: path.join(usb, "x.json"), confirm: true }), /the user can allow one more directory.*MURKFUN_EXPORT_DIR/);
});

test("backup never replaces an existing file unless confirmed", async () => {
  const { agent } = agentIn("backup");
  agent.vault.create({ eoaKey: KEY });
  const victim = path.join(tmp, "backup", "dotfile");
  fs.writeFileSync(victim, "keep me\n");
  await assert.rejects(agent.backup({ path: victim }), /already exists; choose a new path \(or pass confirm=true/);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep me\n");
  const fresh = path.join(tmp, "backup", "vault-backup.json");
  assert.equal((await agent.backup({ path: fresh })).encrypted, true);
  assert.ok(!fs.readFileSync(fresh, "utf8").includes(KEY.slice(2)), "encrypted");
  // a second backup over the same file only with confirm
  await assert.rejects(agent.backup({ path: fresh }), /already exists/);
  await agent.backup({ path: fresh, confirm: true });
});

test("setup {recoveryFile}: a file that is not a recovery file echoes nothing of its contents", async () => {
  const rawKey = path.join(tmp, "raw.key");
  fs.writeFileSync(rawKey, `${KEY}\n`);
  const notJson = path.join(tmp, "notes.txt");
  fs.writeFileSync(notJson, "{ secret words here");
  for (const [i, f] of [rawKey, notJson].entries()) {
    const { agent } = agentIn(`recovery-${i}`);
    await assert.rejects(agent.setup({ recoveryFile: f }), (e: Error) => {
      assert.equal(e.message, "not a MurkFun recovery file");
      assert.ok(!e.message.includes(KEY.slice(2, 12)) && !e.message.includes("secret"));
      return true;
    });
  }
  const { agent } = agentIn("recovery-missing");
  await assert.rejects(agent.setup({ recoveryFile: path.join(tmp, "nope.json") }), /cannot read the recovery file \(ENOENT\)/);
  // valid JSON that is not an object
  const num = path.join(tmp, "num.json");
  fs.writeFileSync(num, "12345");
  await assert.rejects(agentIn("recovery-num").agent.setup({ recoveryFile: num }), (e: Error) => e.message === "not a MurkFun recovery file");
});

test("restore: a file that is not a vault backup echoes nothing of its contents", async () => {
  const rawKey = path.join(tmp, "raw-backup.key");
  fs.writeFileSync(rawKey, `${KEY}\n`);
  const notJson = path.join(tmp, "backup-notes.txt");
  fs.writeFileSync(notJson, "{ secret words here");
  const num = path.join(tmp, "backup-num.json");
  fs.writeFileSync(num, "12345");
  const str = path.join(tmp, "backup-str.json");
  fs.writeFileSync(str, JSON.stringify(KEY));
  const { agent } = agentIn("restore-bad");
  agent.vault.create({ eoaKey: KEY });
  for (const f of [rawKey, notJson, num, str]) {
    await assert.rejects(agent.restore({ path: f, confirm: true }), (e: Error) => {
      assert.equal(e.message, "not a MurkFun vault backup", f);
      assert.ok(!e.message.includes(KEY.slice(2, 12)) && !e.message.includes("secret"));
      return true;
    });
    assert.throws(() => agent.vault.peek(f), (e: Error) => e.message === "not a MurkFun vault backup");
  }
  await assert.rejects(agent.restore({ path: path.join(tmp, "no-backup.json") }), /cannot read the backup \(ENOENT\)/);
  // a real backup still restores
  const good = path.join(tmp, "restore-bad", "good-backup.json");
  await agent.backup({ path: good });
  assert.equal((await agent.restore({ path: good })).restored, true);
});

test("configuration warnings reach the agent: status before setup names them", async () => {
  const { agent, cfg } = agentIn("config-warnings", { MURKFUN_WITHDRAW_ALLOWLIST: "*" });
  assert.match(cfg.warnings!.join("\n"), /MURKFUN_WITHDRAW_ALLOWLIST is "\*"/);
  await assert.rejects(agent.status(), /no vault yet: call setup first\. CONFIGURATION WARNING: .*MURKFUN_WITHDRAW_ALLOWLIST is "\*".* Tell the user before any deposit or order\./);
  assert.match(JSON.stringify(agent.customStatus().configWarnings), /MURKFUN_WITHDRAW_ALLOWLIST/);
});

test("order validity: at most MURKFUN_MAX_ORDER_VALIDITY_S (never less than the 30 min a Railgun proof needs)", async () => {
  const now = 1_000_000n;
  const at = (maxOrderValidityS: number) => {
    const agent: any = Object.create(MurkFunAgent.prototype);
    Object.assign(agent, { cfg: { maxOrderValidityS }, pub: { getBlock: async () => ({ timestamp: now }) } });
    return agent;
  };
  const def = at(600);
  assert.equal(await def.deadlineIn(), now + 300n, "default 5 min");
  assert.equal(await def.deadlineIn(30), now + 1800n, "the Railgun default always fits");
  await assert.rejects(def.deadlineIn(31), /validity_too_long: validMinutes 31 is above 30 .*nothing was signed or sent/);
  await assert.rejects(def.deadlineIn(1440), /validity_too_long/);
  const long = at(7200);
  assert.equal(await long.deadlineIn(120), now + 7200n);
  await assert.rejects(long.deadlineIn(121), /above 120/);
});

test("sell: a negative amount or percent is refused before any quote", async () => {
  const agent: any = Object.create(MurkFunAgent.prototype);
  const T = "0x00000000000000000000000000000000000007aa";
  let quoted = false;
  Object.assign(agent, {
    pseudonym: () => 7n, tradable: async () => ({ graduated: false }), tread: async () => 10n ** 18n,
    relayQuote: async () => { quoted = true; throw new Error("no quote expected"); },
  });
  await assert.rejects(agent.sell({ token: T, amount: "-1" }), /amount must be positive/);
  await assert.rejects(agent.sell({ token: T, percent: -5 }), /percent must be above 0 and at most 100/);
  await assert.rejects(agent.sell({ token: T, percent: 0 }), /percent must be above 0/);
  assert.equal(quoted, false);
});

test("a withdrawal / fee recipient that is the user's own wallet comes back with a privacy warning; another allowed one does not", async () => {
  const fresh = "0x00000000000000000000000000000000000Fe5A1" as Address;
  const { agent } = agentIn("own-wallet", { MURKFUN_WITHDRAW_ALLOWLIST: `${privateKeyToAccount(KEY).address},${fresh}` });
  agent.vault.create({ eoaKey: KEY });
  // a chain where nothing is a MurkFun contract and both addresses are plain wallets
  agent.pub = {
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "marketOf" ? zeroAddress : functionName === "isBlockedRecipient" ? false : Promise.reject(new Error("no such call")),
    getCode: async () => "0x",
  };
  const own = await agent.checkRecipient(privateKeyToAccount(KEY).address, { what: "withdraw_bnb to" });
  assert.deepEqual(MurkFunAgent.destinationInfo(own), { kind: "wallet", privacy: OWN_WALLET_PRIVACY });
  assert.match(OWN_WALLET_PRIVACY, /publicly links this pseudonym .* MURKFUN_WITHDRAW_ALLOWLIST/);
  assert.deepEqual(MurkFunAgent.destinationInfo(await agent.checkRecipient(fresh, { what: "withdraw_bnb to" })), { kind: "wallet" });
  // the default (no allowlist): a fresh address is refused with how the user allows it
  const def = agentIn("own-wallet-default");
  def.agent.vault.create({ eoaKey: KEY });
  await assert.rejects(def.agent.checkRecipient(fresh, { what: "withdraw_bnb to" }), /destination_not_allowed: .*to use a fresh address .*MURKFUN_WITHDRAW_ALLOWLIST in the MCP server's environment .*restarts the MCP server/);
});
