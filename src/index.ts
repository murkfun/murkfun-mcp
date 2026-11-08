#!/usr/bin/env node
// MurkFun MCP server (stdio). Runs locally next to the user's agent. Configure with env vars (see config.ts and
// docs/AGENT_GUIDE.md). Logs go to stderr; stdout is the MCP channel.
//   murkfun-mcp                  start the stdio MCP server
//   murkfun-mcp init             set up ~/.murkfun: passphrase file (kept if present), 0xbow circuits, client config
//   murkfun-mcp config [claude-code|json] [--absolute]  print a ready-to-paste MCP client config
//   murkfun-mcp fetch-circuits   download + verify the 0xbow circuit artifacts (otherwise done on first use)
//   murkfun-mcp network          show the bundled network values (networks/<MURKFUN_NETWORK>.json) and any placeholders left
//   murkfun-mcp tools            every tool with its input JSON Schema
//   murkfun-mcp <tool> --arg v   run one tool from the shell (cli.ts): same code, config and vault, same JSON output
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, isPlaceholder, loadNetwork, networkPlaceholders } from "./config.js";
import { MurkFunAgent } from "./agent.js";
import { ensureCircuits } from "./circuits.js";
import { initHome } from "./init.js";
import { INSTRUCTIONS, TOOLS, errorText, inputSchema, runTool, toJson, toolsJson } from "./tools.js";
import { UsageError, cliTool, parseToolArgs, toolHelp } from "./cli.js";

const VERSION: string = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;
const [cmd, arg] = process.argv.slice(2);

/** Whether `murkfun-mcp` on the PATH is this installation (the global install's bin link). */
function onPath(): boolean {
  const self = fs.realpathSync(process.argv[1]);
  return (process.env.PATH ?? "").split(path.delimiter).some((d) => {
    try {
      return !!d && fs.realpathSync(path.join(d, "murkfun-mcp")) === self;
    } catch {
      return false;
    }
  });
}

/** The MCP client config for this installation. Default: the installed binary `murkfun-mcp` (from `npm install -g`);
 *  `absolute` (also when `murkfun-mcp` on the PATH is not this installation): node and this script by absolute path,
 *  for clients that start servers without the shell's PATH. */
function clientConfig(format: "claude-code" | "json", absolute: boolean): string {
  const command = absolute ? process.execPath : "murkfun-mcp";
  const args = absolute ? [fs.realpathSync(process.argv[1])] : [];
  const home = process.env.MURKFUN_HOME;
  // values bundled in networks/<name>.json need no env entry; a "<...>" value there is printed for the user to fill in
  const missing = networkPlaceholders(loadNetwork(process.env.MURKFUN_NETWORK ?? "bsc"));
  const env = {
    ...(home ? { MURKFUN_HOME: home } : {}),
    ...(process.env.MURKFUN_NETWORK ? { MURKFUN_NETWORK: process.env.MURKFUN_NETWORK } : {}),
    MURKFUN_PASSPHRASE_FILE: path.join(home ?? path.join(os.homedir(), ".murkfun"), "passphrase"),
    ...(process.env.MURKFUN_RPC ? { MURKFUN_RPC: process.env.MURKFUN_RPC } : {}),
    ...(process.env.MURKFUN_RELAYER_URL || missing.includes("relayerUrl") ? { MURKFUN_RELAYER_URL: process.env.MURKFUN_RELAYER_URL || "<MurkFun relayer URL>" } : {}),
    ...(process.env.MURKFUN_DEPLOYMENT || missing.some((m) => m.startsWith("deployment.")) ? { MURKFUN_DEPLOYMENT: process.env.MURKFUN_DEPLOYMENT || "<path to the MurkFun deployment.json>" } : {}),
    ...(process.env.MURKFUN_INDEXER_URL ? { MURKFUN_INDEXER_URL: process.env.MURKFUN_INDEXER_URL } : {}),
    ...(process.env.MURKFUN_UPLOAD_URL ? { MURKFUN_UPLOAD_URL: process.env.MURKFUN_UPLOAD_URL } : {}),
  };
  if (format === "claude-code") return `claude mcp add murkfun --scope user ${Object.entries(env).map(([k, v]) => `-e ${k}=${JSON.stringify(v)}`).join(" ")} -- ${[command, ...args].map((x) => JSON.stringify(x)).join(" ")}`;
  return JSON.stringify({ mcpServers: { murkfun: { command, args, env } } }, null, 2);
}
const absolute = process.argv.includes("--absolute") || !onPath();
const murkfunHome = () => process.env.MURKFUN_HOME ?? path.join(os.homedir(), ".murkfun");
const circuitsDir = () => process.env.MURKFUN_CIRCUITS_DIR ?? path.join(murkfunHome(), "circuits");

if (cmd === "config") {
  if (arg === "claude-code") console.log(clientConfig("claude-code", absolute));
  else {
    console.log(clientConfig("json", absolute));
    if (arg !== "json") console.error("\n(Claude Desktop / Cursor / other clients: merge into their mcpServers config. Claude Code: `murkfun-mcp config claude-code`.)");
  }
  process.exit(0);
}
if (cmd === "init") {
  try {
    await initHome({ home: murkfunHome(), circuitsDir: circuitsDir() });
  } catch (e) {
    console.error(`murkfun-mcp init: ${(e as Error).message}`);
    process.exit(1);
  }
  console.error("\nClaude Code (run this command):");
  console.log(clientConfig("claude-code", absolute));
  console.error("\nClaude Desktop / Cursor / other MCP clients (merge into their mcpServers config):");
  console.log(clientConfig("json", absolute));
  const missing = networkPlaceholders(loadNetwork(process.env.MURKFUN_NETWORK ?? "bsc"));
  const unset = [
    ...(missing.includes("relayerUrl") && !process.env.MURKFUN_RELAYER_URL ? ["MURKFUN_RELAYER_URL"] : []),
    ...(missing.some((m) => m.startsWith("deployment.")) && !process.env.MURKFUN_DEPLOYMENT ? ["MURKFUN_DEPLOYMENT"] : []),
  ];
  if (unset.length) console.error(`\nReplace the <...> value of ${unset.join(" and ")} in that config (or export ${unset.length > 1 ? "them" : "it"} and run init again).`);
  if (!absolute) console.error("\n(If your MCP client cannot find `murkfun-mcp`, print the config with absolute paths: `murkfun-mcp config --absolute`.)");
  console.error("\nThen restart your agent so it loads the murkfun tools. Skill file for the agent: https://murk.fun/skill.md");
  process.exit(0);
}
if (cmd === "fetch-circuits") {
  const dir = circuitsDir();
  await ensureCircuits(dir);
  console.error(`circuits ok in ${dir}`);
  process.exit(0);
}
if (cmd === "network") {
  const net = loadNetwork(process.env.MURKFUN_NETWORK ?? "bsc");
  const missing = networkPlaceholders(net);
  console.log(JSON.stringify({ ...net, indexerUrl: isPlaceholder(net.indexerUrl) ? null : net.indexerUrl, placeholders: missing }, null, 2));
  if (missing.length) console.error(`\nnetworks/${net.network}.json has template placeholders (${missing.join(", ")}): set MURKFUN_DEPLOYMENT and MURKFUN_RELAYER_URL.`);
  process.exit(0);
}
if (cmd === "--version" || cmd === "-v") { console.log(VERSION); process.exit(0); }
if (cmd === "tools") {
  console.log(JSON.stringify({ instructions: INSTRUCTIONS, tools: toolsJson() }, null, 1));
  process.exit(0);
}
const cliCmd = cmd ? cliTool(cmd) : undefined;
if (cmd && !cliCmd) {
  console.error(`usage: murkfun-mcp [init | config [claude-code|json] [--absolute] | fetch-circuits | network | tools | <tool> [--arg value ...] [--json '{...}'] | --version]
Without arguments it runs the stdio MCP server. Tools: ${TOOLS.map((t) => t.name).join(", ")}.`);
  process.exit(cmd === "help" || cmd === "--help" ? 0 : 2);
}
if (cliCmd && (process.argv.includes("--help") || process.argv.includes("-h"))) { console.log(toolHelp(cliCmd)); process.exit(0); }

let cfg;
try {
  cfg = configFromEnv();
} catch (e) {
  console.error(`murkfun-mcp: ${(e as Error).message}`);
  process.exit(1);
}
for (const w of cfg.warnings ?? []) console.error(`murkfun-mcp warning: ${w}`);
if (cliCmd) {
  // CLI: the same tool function, configuration and vault as the MCP server; the result JSON on stdout
  const argv = process.argv.slice(3);
  let args;
  try {
    args = parseToolArgs(cliCmd, argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`murkfun-mcp: ${e.message}`);
    process.exit(2);
  }
  let code = 0;
  try {
    const out = await runTool(cliCmd, args, { agent: await MurkFunAgent.create(cfg), cfg });
    await new Promise<void>((r) => process.stdout.write(`${toJson(out)}\n`, () => r()));
  } catch (e) {
    console.error(errorText(e));
    code = 1;
  }
  process.exit(code);
}
const agent = await MurkFunAgent.create(cfg);
// stderr is hidden by most clients: the configuration warnings go into the instructions the model reads too
const instructions = cfg.warnings?.length
  ? `${INSTRUCTIONS} CONFIGURATION WARNING: ${cfg.warnings.join(" ")} Tell the user before any deposit or order.`
  : INSTRUCTIONS;
const server = new McpServer({ name: "murkfun", version: VERSION }, { instructions });

// One call at a time: tools share the vault and note state.
let queue: Promise<unknown> = Promise.resolve();
for (const t of TOOLS) {
  server.registerTool(t.name, { description: t.description, inputSchema: inputSchema(t) }, (async (args: any) => {
    const run = queue.then(() => runTool(t, args, { agent, cfg }));
    queue = run.catch(() => undefined);
    try {
      return { content: [{ type: "text" as const, text: toJson(await run) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: errorText(e) }] };
    }
  }) as never);
}

await server.connect(new StdioServerTransport());
console.error("murkfun mcp ready");
