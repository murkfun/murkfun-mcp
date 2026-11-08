// The MCP tools as shell commands, for agents without an MCP client (OpenClaw, scripts, any client without MCP support):
//   murkfun-mcp <tool> [--arg value ...] [--json '{"arg": ...}']
// runs the same function as the MCP tool, with the same configuration (env vars) and the same vault, and prints the
// same JSON on stdout. Errors: the MCP's error text on stderr, exit code 1 (2 for a bad command line).
import { z } from "zod";
import { inputSchema, toolByName, type ToolDef } from "./tools.js";

export class UsageError extends Error {}

/** `token-info` and `token_info` name the same tool; `--bnb-amount` and `--bnbAmount` the same argument. */
export const cliTool = (name: string) => toolByName(name.replace(/-/g, "_"));
const camel = (s: string) => s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

/** Command-line arguments -> the tool's validated input. A value is taken as a string when the argument accepts one,
 *  else parsed as JSON (numbers, booleans, arrays, objects). A flag without a value is `true`. Unknown arguments are
 *  refused, so a typo never silently drops an argument. */
export function parseToolArgs(t: ToolDef, argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = (key: string, raw: string | true) => {
    const field = t.shape[key] as z.ZodType | undefined;
    if (!field) throw new UsageError(`${t.name}: unknown argument --${key} (murkfun-mcp ${t.name} --help lists them)`);
    if (raw === true || field.safeParse(raw).success) { out[key] = raw; return; }
    try { out[key] = JSON.parse(raw); } catch { out[key] = raw; }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new UsageError(`${t.name}: unexpected argument "${a}" (use --name value)`);
    const eq = a.indexOf("=");
    const key = camel(eq > 0 ? a.slice(2, eq) : a.slice(2));
    const next = argv[i + 1];
    const value: string | true = eq > 0 ? a.slice(eq + 1) : next !== undefined && !next.startsWith("--") ? argv[++i] : true;
    if (key === "json") {
      if (value === true) throw new UsageError(`${t.name}: --json needs a JSON object`);
      let obj: unknown;
      try { obj = JSON.parse(value); } catch { throw new UsageError(`${t.name}: --json is not valid JSON`); }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new UsageError(`${t.name}: --json must be a JSON object`);
      Object.assign(out, obj);
    } else set(key, value);
  }
  const r = inputSchema(t).safeParse(out);
  if (!r.success) throw new UsageError(`${t.name}: ${r.error.issues.map((x) => `${x.path.join(".") || "input"}: ${x.message}`).join("; ")}`);
  return r.data;
}

/** `murkfun-mcp <tool> --help`: the description and the input schema. */
export const toolHelp = (t: ToolDef) =>
  `murkfun-mcp ${t.name} [--arg value ...] [--json '{...}']\n\n${t.description}\n\nInput (JSON Schema):\n${JSON.stringify(z.toJSONSchema(inputSchema(t)), null, 1)}`;
