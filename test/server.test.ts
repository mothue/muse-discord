// End-to-end: spawn the MCP server as a child process against a fake Discord
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync } from "node:fs";
import { FakeDiscord, BOT, GOOD_TOKEN, GUILD_ID, HUMAN, IDS } from "./fake-discord.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const TEST_DIR = ".test-data"; // inside the working directory
let dbCounter = 0;

let fake: FakeDiscord;
let dbPath: string;
const clients: Client[] = [];

async function connect(token = GOOD_TOKEN, db = dbPath) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "src/server.ts"],
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      DISCORD_BOT_TOKEN: token,
      DISCORD_MCP_DB: db,
      DISCORD_API_BASE: fake.base,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  return { isError: !!res.isError, data: JSON.parse(res.content[0]!.text) };
}

beforeEach(() => {
  fake = new FakeDiscord();
  dbPath = `${TEST_DIR}/state-${process.pid}-${dbCounter++}.sqlite`;
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  fake.stop();
});
afterAll(() => rmSync(`${ROOT}${TEST_DIR}`, { recursive: true, force: true }));

describe("startup and tool list", () => {
  test("tools/list exposes the 8 tools", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["add_reaction", "get_messages", "list_channels", "list_unread", "mark_read", "reply_message", "send_message", "whoami"].sort(),
    );
  });

  test("refuses to start when the DB path is outside the working directory", async () => {
    const proc = Bun.spawn([process.execPath, "run", "src/server.ts"], {
      cwd: ROOT,
      env: { ...process.env, DISCORD_MCP_DB: "../outside.sqlite", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain("inside the working directory");
  });
});

describe("auth", () => {
  test("dummy token returns a machine-readable 401 error", async () => {
    const c = await connect("dummy");
    const r = await call(c, "whoami");
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe("UNAUTHORIZED");
    expect(r.data.error.status).toBe(401);
    // 401 is not retried
    expect(fake.requests.length).toBe(1);
  });

  test("whoami returns the bot name", async () => {
    const c = await connect();
    expect((await call(c, "whoami")).data).toEqual({ id: BOT.id, username: BOT.username });
  });
});

describe("list_channels", () => {
  test("channels the bot cannot view are excluded and reported", async () => {
    const c = await connect();
    const { data } = await call(c, "list_channels", { guild_id: GUILD_ID });
    const ids = data.channels.map((x: any) => x.id);
    expect(ids).toContain(IDS.times);
    expect(ids).toContain(IDS.botSecret); // allowed via role overwrite
    expect(ids).not.toContain(IDS.secret);
    expect(data.excluded_channels).toEqual([
      { id: IDS.secret, name: "secret", type: "text", reason: "no_view_permission" },
    ]);
    const times = data.channels.find((x: any) => x.id === IDS.times);
    expect(times).toEqual({ id: IDS.times, name: "times-mose", type: "text", parent_id: IDS.category, topic: "mose's times" });
    expect(data.channels.find((x: any) => x.id === IDS.category).type).toBe("category");
  });
});

describe("list_unread / mark_read", () => {
  test("first run only initializes, no backlog", async () => {
    const c = await connect();
    const { data } = await call(c, "list_unread");
    expect(data.channels).toEqual([]);
    expect(data.initialized_channels).toContain(IDS.times);
    expect(data.initialized_channels).not.toContain(IDS.category);
    expect(data.initialized_channels).not.toContain(IDS.secret);
  });

  test("human posts show up, own posts excluded, watermark not advanced", async () => {
    const c = await connect();
    await call(c, "list_unread");
    fake.post(IDS.times, HUMAN, `hello <@${BOT.id}>`, undefined, { mentions: [BOT] });
    fake.post(IDS.times, BOT, "my own post");
    fake.post(IDS.times, HUMAN, "second", undefined, {
      attachments: [{ filename: "a.png", content_type: "image/png" }],
      reactions: [{ count: 1, me: false, emoji: { id: null, name: "👍" } }, { count: 2, me: true, emoji: { id: "123", name: "party" } }],
    });

    const r1 = await call(c, "list_unread");
    expect(r1.data.initialized_channels).toEqual([]);
    expect(r1.data.channels).toHaveLength(1);
    const ch = r1.data.channels[0];
    expect(ch.channel_name).toBe("times-mose");
    expect(ch.unread_count).toBe(2);
    expect(ch.truncated).toBe(false);
    expect(ch.messages.map((m: any) => m.content)).toEqual([`hello <@${BOT.id}>`, "second"]);
    const [m1, m2] = ch.messages;
    expect(m1).toMatchObject({ author_id: HUMAN.id, author_name: "Mose", author_is_bot: false, mentions_bot: true, reply_to_message_id: null });
    expect(m1.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(m2.mentions_bot).toBe(false);
    expect(m2.attachments).toEqual([{ filename: "a.png", content_type: "image/png" }]);
    expect(m2.reactions).toEqual([{ emoji: "👍", count: 1, me: false }, { emoji: "party:123", count: 2, me: true }]);

    // reading alone does not mark as read
    const r2 = await call(c, "list_unread");
    expect(r2.data.channels[0].unread_count).toBe(2);

    // include_own includes own posts
    const r3 = await call(c, "list_unread", { include_own: true });
    expect(r3.data.channels[0].unread_count).toBe(3);
  });

  test("channel with only own new posts has 0 unread", async () => {
    const c = await connect();
    await call(c, "list_unread");
    fake.post(IDS.times, BOT, "only me");
    expect((await call(c, "list_unread")).data.channels).toEqual([]);
  });

  test("no duplicates after mark_read and restart", async () => {
    let c = await connect();
    await call(c, "list_unread");
    fake.post(IDS.times, HUMAN, "a");
    const latest = fake.post(IDS.times, HUMAN, "b");
    expect((await call(c, "list_unread")).data.channels[0].unread_count).toBe(2);

    const mr = await call(c, "mark_read", { channel_id: IDS.times });
    expect(mr.data).toEqual({ channel_id: IDS.times, last_read_message_id: latest.id });
    await c.close();

    c = await connect();
    expect((await call(c, "list_unread")).data.channels).toEqual([]);
    fake.post(IDS.times, HUMAN, "c");
    const after = await call(c, "list_unread");
    expect(after.data.channels[0].messages.map((m: any) => m.content)).toEqual(["c"]);
    expect(after.data.initialized_channels).toEqual([]);
  });

  test("mark_read advances to the given id and never moves backwards", async () => {
    const c = await connect();
    await call(c, "list_unread");
    const a = fake.post(IDS.times, HUMAN, "a");
    const b = fake.post(IDS.times, HUMAN, "b");
    expect((await call(c, "mark_read", { channel_id: IDS.times, up_to_message_id: a.id })).data.last_read_message_id).toBe(a.id);
    const r = await call(c, "list_unread");
    expect(r.data.channels[0].messages.map((m: any) => m.id)).toEqual([b.id]);

    await call(c, "mark_read", { channel_id: IDS.times, up_to_message_id: b.id });
    const back = await call(c, "mark_read", { channel_id: IDS.times, up_to_message_id: a.id });
    expect(back.data.last_read_message_id).toBe(b.id);
  });

  test("pages past 100 and truncates at per_channel_limit (oldest first)", async () => {
    const c = await connect();
    await call(c, "list_unread");
    for (let i = 0; i < 230; i++) fake.post(IDS.times, HUMAN, `m${i}`);
    const { data } = await call(c, "list_unread", { per_channel_limit: 10 });
    const ch = data.channels[0];
    expect(ch.unread_count).toBe(230);
    expect(ch.truncated).toBe(true);
    expect(ch.messages.map((m: any) => m.content)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`));
    const pages = fake.requests.filter((r) => r.path.startsWith(`/channels/${IDS.times}/messages?`) && r.path.includes("after="));
    expect(pages.length).toBe(3);
  });

  test("does not call the messages API when nothing is new", async () => {
    const c = await connect();
    await call(c, "list_unread");
    fake.requests = [];
    await call(c, "list_unread");
    expect(fake.requests.some((r) => r.path.includes("/messages"))).toBe(false);
  });

  test("403 channel is skipped and reported without failing the call", async () => {
    const c = await connect();
    await call(c, "list_unread");
    fake.forbiddenChannels.add(IDS.forbidden);
    fake.post(IDS.forbidden, HUMAN, "x");
    fake.post(IDS.times, HUMAN, "y");
    const { isError, data } = await call(c, "list_unread");
    expect(isError).toBe(false);
    expect(data.channels.map((x: any) => x.channel_id)).toEqual([IDS.times]);
    expect(data.skipped_channels).toContainEqual({ channel_id: IDS.forbidden, channel_name: "forbidden-at-runtime", reason: "forbidden" });
    expect(data.skipped_channels).toContainEqual({ channel_id: IDS.secret, channel_name: "secret", reason: "no_view_permission" });
  });

  test("threads created after watching started are unread from the first post", async () => {
    const c = await connect();
    await call(c, "list_unread");
    const th = fake.createThread(IDS.times, "new-thread");
    fake.post(th.id, HUMAN, "starter", th.id); // like a forum post: starter message id == thread id
    fake.post(th.id, HUMAN, "follow-up");
    const { data } = await call(c, "list_unread");
    expect(data.initialized_channels).toEqual([]);
    const ch = data.channels.find((x: any) => x.channel_id === th.id);
    expect(ch.channel_type).toBe("public_thread");
    expect(ch.messages.map((m: any) => m.content)).toEqual(["starter", "follow-up"]);
  });
});

describe("get_messages", () => {
  test("returns history oldest first without touching the watermark", async () => {
    const c = await connect();
    await call(c, "list_unread");
    fake.post(IDS.times, HUMAN, "new");
    const { data } = await call(c, "get_messages", { channel_id: IDS.times, limit: 3 });
    expect(data.map((m: any) => m.content)).toEqual(["old 3", "old 4", "new"]);
    // unread is still there
    expect((await call(c, "list_unread")).data.channels[0].unread_count).toBe(1);
  });

  test("before and after together is an error", async () => {
    const c = await connect();
    const r = await call(c, "get_messages", { channel_id: IDS.times, before: "1", after: "2" });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe("INVALID_ARGUMENT");
  });
});

describe("sending", () => {
  test("send_message disables @everyone/@here/roles", async () => {
    const c = await connect();
    const r = await call(c, "send_message", { channel_id: IDS.times, content: "@everyone hi" });
    expect(r.isError).toBe(false);
    expect(Object.keys(r.data).sort()).toEqual(["channel_id", "message_id", "timestamp"]);
    const post = fake.requests.find((x) => x.method === "POST")!;
    expect(post.body.allowed_mentions).toEqual({ parse: ["users"] });

    await call(c, "send_message", { channel_id: IDS.times, content: "hi", allowed_mentions_user_ids: [HUMAN.id] });
    const post2 = fake.requests.filter((x) => x.method === "POST")[1]!;
    expect(post2.body.allowed_mentions).toEqual({ parse: [], users: [HUMAN.id] });
  });

  test("reply_message uses message_reference and does not ping by default", async () => {
    const c = await connect();
    const target = fake.post(IDS.times, HUMAN, "question");
    const r = await call(c, "reply_message", { channel_id: IDS.times, message_id: target.id, content: "answer" });
    expect(r.data.channel_id).toBe(IDS.times);
    const post = fake.requests.find((x) => x.method === "POST")!;
    expect(post.body.message_reference.message_id).toBe(target.id);
    expect(post.body.allowed_mentions.replied_user).toBe(false);
    expect(post.body.allowed_mentions.parse).not.toContain("everyone");

    // replies are readable as reply_to_message_id
    const msgs = (await call(c, "get_messages", { channel_id: IDS.times, limit: 1 })).data;
    expect(msgs[0].reply_to_message_id).toBe(target.id);

    await call(c, "reply_message", { channel_id: IDS.times, message_id: target.id, content: "ping", mention_author: true });
    expect(fake.requests.filter((x) => x.method === "POST")[1]!.body.allowed_mentions.replied_user).toBe(true);
  });

  test("add_reaction accepts Unicode and custom emoji (name:id / <:name:id>)", async () => {
    const c = await connect();
    const target = fake.post(IDS.times, HUMAN, "nice");
    for (const emoji of ["👍", "party:123", "<a:dance:456>"]) {
      expect((await call(c, "add_reaction", { channel_id: IDS.times, message_id: target.id, emoji })).data).toEqual({ ok: true });
    }
    expect(fake.reactions.map((r) => r.emoji)).toEqual(["👍", "party:123", "dance:456"]);
  });

  test("rejects content over 2000 chars", async () => {
    const c = await connect();
    const r = (await c.callTool({ name: "send_message", arguments: { channel_id: IDS.times, content: "x".repeat(2001) } })) as any;
    expect(r.isError).toBe(true);
    expect(fake.requests.some((x) => x.method === "POST")).toBe(false);
  });
});

describe("rate limits", () => {
  test("retries 429 up to 2 times then succeeds", async () => {
    const c = await connect();
    fake.rateLimitNext = 2;
    expect((await call(c, "whoami")).isError).toBe(false);
    expect(fake.requests.length).toBe(3);
  });

  test("3 consecutive 429s yield RATE_LIMITED", async () => {
    const c = await connect();
    fake.rateLimitNext = 3;
    const r = await call(c, "whoami");
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({ code: "RATE_LIMITED", status: 429 });
  });
});

describe("missing token", () => {
  test("returns MISSING_TOKEN", async () => {
    const c = await connect("");
    const r = await call(c, "whoami");
    expect(r.data.error.code).toBe("MISSING_TOKEN");
  });
});
