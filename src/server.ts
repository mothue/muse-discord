#!/usr/bin/env bun
// Entry point.
//   bun run start                  -> MCP server over stdio (stdout = JSON-RPC only)
//   bun run start <tool> [args]    -> run one tool, print JSON to stdout, exit
//   bun run start listen           -> stay on the Gateway, append triggers to a JSONL spool
// Logs always go to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { StateDB } from "./db.ts";
import { DiscordClient, ToolError } from "./discord.ts";
import { WithImages, createTools, type ToolDef } from "./tools.ts";
import { readFileSync } from "node:fs";
import { resolveInsideCwd } from "./paths.ts";

// Keep stdout clean: route console.log / info to stderr
console.log = console.error;
console.info = console.error;

const TOKEN = process.env.DISCORD_BOT_TOKEN?.trim() || undefined;
const DEFAULT_GUILD_ID = process.env.DISCORD_MCP_DEFAULT_GUILD_ID?.trim() || "1513823779124416582";

/** Side effects (the DB file) are confined to the working directory. */
function resolveDbPath(): string {
  return resolveInsideCwd(process.env.DISCORD_MCP_DB?.trim() || "./data/state.sqlite", "DISCORD_MCP_DB");
}

function toError(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  if (e instanceof z.ZodError) return new ToolError("INVALID_ARGUMENT", z.prettifyError(e));
  return new ToolError("INTERNAL_ERROR", (e as Error)?.message ?? String(e));
}

interface RunResult {
  ok: boolean;
  text: string;
  images?: { path: string; mimeType: string }[];
}

async function runTool(tool: ToolDef, args: unknown): Promise<RunResult> {
  try {
    const parsed = z.object(tool.inputSchema).strict().parse(args ?? {});
    const out = await tool.handler(parsed);
    if (out instanceof WithImages) return { ok: true, text: JSON.stringify(out.data), images: out.images };
    return { ok: true, text: JSON.stringify(out) };
  } catch (e) {
    const err = toError(e);
    console.error(`[tool] ${err.code}: ${err.message}`);
    return { ok: false, text: JSON.stringify(err.toJSON()) };
  }
}

// ---- CLI ----

function unwrap(s: z.ZodType): z.ZodType {
  return s instanceof z.ZodOptional ? unwrap(s.unwrap() as z.ZodType) : s;
}

/** Parse `--key value` flags (or a single JSON object) using the tool's schema for types. */
function parseCliArgs(tool: ToolDef, argv: string[]): Record<string, unknown> {
  if (argv.length === 1 && argv[0]!.trim().startsWith("{")) return JSON.parse(argv[0]!);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (!flag.startsWith("--")) throw new ToolError("INVALID_ARGUMENT", `unexpected argument: ${flag}`);
    let key = flag.slice(2);
    let value: string | undefined;
    const eq = key.indexOf("=");
    if (eq >= 0) [key, value] = [key.slice(0, eq), key.slice(eq + 1)];
    key = key.replaceAll("-", "_");
    const schema = tool.inputSchema[key];
    if (!schema) throw new ToolError("INVALID_ARGUMENT", `unknown option: --${key}`);
    const base = unwrap(schema as z.ZodType);
    if (base instanceof z.ZodBoolean) {
      if (value === undefined && (argv[i + 1] === "true" || argv[i + 1] === "false")) value = argv[++i];
      out[key] = value === undefined ? true : value === "true";
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new ToolError("INVALID_ARGUMENT", `missing value for --${key}`);
    }
    if (base instanceof z.ZodNumber) out[key] = Number(value);
    else if (base instanceof z.ZodArray) out[key] = [...((out[key] as string[]) ?? []), ...value.split(",").filter(Boolean)];
    else out[key] = value;
  }
  return out;
}

function usage(tools: Record<string, ToolDef>): string {
  const lines = ["Usage: bun run start <tool> [--option value ...] | [JSON]", "       bun run start            (MCP stdio server)", "       bun run start listen     (Gateway listener -> wake spool)", "", "Tools:"];
  for (const [name, t] of Object.entries(tools)) {
    const opts = Object.entries(t.inputSchema).map(([k, s]) => ((s as z.ZodType).isOptional() ? `[--${k}]` : `--${k}`));
    lines.push(`  ${name} ${opts.join(" ")}`.trimEnd(), `      ${t.description}`);
  }
  return lines.join("\n");
}

// ---- main ----

const argv = process.argv.slice(2);

// listen is CLI-only and must not open the SQLite DB (watermarks stay untouched)
if (argv[0] === "listen") {
  const { runListen } = await import("./listen.ts");
  await runListen();
}

const db = new StateDB(resolveDbPath());
const tools = createTools({ db, discord: new DiscordClient(TOKEN), defaultGuildId: DEFAULT_GUILD_ID });

if (argv.length > 0) {
  const [name, ...rest] = argv;
  if (name === "help" || name === "--help" || name === "-h") {
    process.stdout.write(usage(tools) + "\n");
    process.exit(0);
  }
  const tool = tools[name!];
  let result: RunResult;
  if (!tool) {
    result = { ok: false, text: JSON.stringify(new ToolError("INVALID_ARGUMENT", `unknown tool: ${name} (try: help)`).toJSON()) };
  } else {
    try {
      result = await runTool(tool, parseCliArgs(tool, rest));
    } catch (e) {
      result = { ok: false, text: JSON.stringify(toError(e).toJSON()) };
    }
  }
  db.close();
  process.stdout.write(result.text + "\n");
  process.exit(result.ok ? 0 : 1);
}

const server = new McpServer({ name: "muse-discord", version: "0.1.0" });
for (const [name, tool] of Object.entries(tools)) {
  server.registerTool(name, { description: tool.description, inputSchema: tool.inputSchema }, async (args: unknown) => {
    const r = await runTool(tool, args);
    const images = (r.images ?? []).map((img) => ({
      type: "image" as const,
      data: readFileSync(img.path).toString("base64"),
      mimeType: img.mimeType,
    }));
    return { ...(r.ok ? {} : { isError: true }), content: [{ type: "text" as const, text: r.text }, ...images] };
  });
}

await server.connect(new StdioServerTransport());
console.error(`[muse-discord] MCP server started (default guild ${DEFAULT_GUILD_ID}, token ${TOKEN ? "set" : "MISSING"})`);

const shutdown = () => {
  try {
    db.close();
  } finally {
    process.exit(0);
  }
};
process.stdin.on("end", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
