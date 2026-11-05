// One-shot CLI mode: `bun run src/server.ts <tool> [args]` prints JSON to stdout.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { BOT, FakeDiscord, GOOD_TOKEN, HUMAN, IDS } from "./fake-discord.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const TEST_DIR = ".test-data-cli";
let fake: FakeDiscord;
let dbPath: string;
let n = 0;

async function cli(args: string[], token = GOOD_TOKEN) {
  const proc = Bun.spawn([process.execPath, "run", "src/server.ts", ...args], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      DISCORD_BOT_TOKEN: token,
      DISCORD_MCP_DB: dbPath,
      DISCORD_API_BASE: fake.base,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out, json: () => JSON.parse(out) };
}

beforeEach(() => {
  fake = new FakeDiscord();
  dbPath = `${TEST_DIR}/state-${process.pid}-${n++}.sqlite`;
});
afterEach(() => fake.stop());
afterAll(() => rmSync(`${ROOT}${TEST_DIR}`, { recursive: true, force: true }));

test("help lists all tools", async () => {
  const r = await cli(["help"]);
  expect(r.code).toBe(0);
  for (const t of ["whoami", "list_channels", "list_unread", "mark_read", "get_messages", "send_message", "reply_message", "add_reaction"])
    expect(r.out).toContain(t);
});

test("whoami prints JSON and exits 0", async () => {
  const r = await cli(["whoami"]);
  expect(r.code).toBe(0);
  expect(r.json()).toEqual({ id: BOT.id, username: BOT.username });
});

test("401 prints error JSON and exits 1", async () => {
  const r = await cli(["whoami"], "dummy");
  expect(r.code).toBe(1);
  expect(r.json().error).toMatchObject({ code: "UNAUTHORIZED", status: 401 });
});

test("flags are typed by schema; snowflakes stay strings; state persists across runs", async () => {
  expect((await cli(["list_unread"])).json().initialized_channels).toContain(IDS.times);
  fake.post(IDS.times, HUMAN, "hi");
  const r = await cli(["list_unread", "--per-channel-limit", "5", "--include_own"]);
  expect(r.code).toBe(0);
  const ch = r.json().channels[0];
  expect(ch.messages[0].content).toBe("hi");

  expect((await cli(["mark_read", "--channel_id", IDS.times])).code).toBe(0);
  expect((await cli(["list_unread"])).json().channels).toEqual([]);
});

test("accepts a JSON object argument", async () => {
  const r = await cli(["send_message", JSON.stringify({ channel_id: IDS.times, content: "yo", allowed_mentions_user_ids: [HUMAN.id] })]);
  expect(r.code).toBe(0);
  expect(fake.requests.find((x) => x.method === "POST")!.body.allowed_mentions).toEqual({ parse: [], users: [HUMAN.id] });
});

test("array flags accept comma-separated values", async () => {
  await cli(["send_message", "--channel_id", IDS.times, "--content", "x", "--allowed_mentions_user_ids", `${HUMAN.id},${BOT.id}`]);
  expect(fake.requests.find((x) => x.method === "POST")!.body.allowed_mentions.users).toEqual([HUMAN.id, BOT.id]);
});

test("invalid input yields INVALID_ARGUMENT and exit 1", async () => {
  for (const args of [["nope"], ["mark_read"], ["mark_read", "--bogus", "1"], ["get_messages", "--channel_id", "abc"]]) {
    const r = await cli(args);
    expect(r.code).toBe(1);
    expect(r.json().error.code).toBe("INVALID_ARGUMENT");
  }
  expect(fake.requests.length).toBe(0);
});
