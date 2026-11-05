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
      DISCORD_CDN_BASE: fake.cdn,
      TWEMOJI_BASE: fake.twemoji,
      DISCORD_MCP_MEDIA_DIR: `${dbPath}.media`,
      WAKE_SPOOL_PATH: `${dbPath}.wake.jsonl`,
      WAKE_CURSOR_PATH: `${dbPath}.wake-cursor.json`,
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
  test("tools/list exposes all tools", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "add_reaction", "fetch_attachment", "get_avatar", "get_emoji", "get_messages", "list_channels", "list_unread",
        "mark_read", "reply_message", "send_message", "send_typing", "wake_ack", "wake_pending", "whoami",
      ].sort(),
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
      attachments: [{ id: "777", filename: "a.png", content_type: "image/png", size: 10, width: 4, height: 3 }],
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
    expect(m2.attachments).toEqual([{ id: "777", filename: "a.png", content_type: "image/png", size: 10, width: 4, height: 3 }]);
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
    expect(Object.keys(r.data).sort()).toEqual(["channel_id", "message_id", "message_ids", "timestamp"]);
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

  test("rejects content that would split into more than 10 messages", async () => {
    const c = await connect();
    const r = (await c.callTool({ name: "send_message", arguments: { channel_id: IDS.times, content: "x".repeat(20001) } })) as any;
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

// ---- v3: readable content, replies, media, typing, splitting, wake spool ----
import { existsSync as exists, readFileSync as readFile, mkdirSync as mkdir, appendFileSync as append } from "node:fs";
import { dirname as dirOf } from "node:path";
import { BOT_ROLE } from "./fake-discord.ts";

async function callRaw(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  };
}

describe("readable content and reply context", () => {
  test("mentions, roles, channels, custom emoji and timestamps become readable", async () => {
    const c = await connect();
    fake.post(IDS.times, HUMAN, `hi <@${BOT.id}> <@&${BOT_ROLE}> see <#${IDS.times}> <:party:123> <t:0:R>`, undefined, { mentions: [BOT] });
    fake.post(IDS.times, HUMAN, "plain");
    const msgs = (await call(c, "get_messages", { channel_id: IDS.times, limit: 2 })).data;
    expect(msgs[0].content_readable).toBe("hi @minerva-bot @Agent see #times-mose :party: 1970-01-01T00:00:00.000Z");
    expect(msgs[1].content_readable).toBeUndefined(); // only when different
  });

  test("replies include an excerpt of the replied-to message", async () => {
    const c = await connect();
    const q = fake.post(IDS.times, HUMAN, "what is " + "x".repeat(300));
    await call(c, "reply_message", { channel_id: IDS.times, message_id: q.id, content: "answer" });
    const [msg] = (await call(c, "get_messages", { channel_id: IDS.times, limit: 1 })).data;
    expect(msg.reply_to_message_id).toBe(q.id);
    expect(msg.reply_to.author_id).toBe(HUMAN.id);
    expect(msg.reply_to.author_name).toBe("Mose");
    expect(Array.from(msg.reply_to.content as string).length).toBe(201); // 200 + "…"
  });
});

describe("splitting", () => {
  test("send_message splits over 2000 chars on line boundaries", async () => {
    const c = await connect();
    const text = Array.from({ length: 60 }, (_, i) => `line ${i} ` + "y".repeat(50)).join("\n"); // ~3500 chars
    const r = await call(c, "send_message", { channel_id: IDS.times, content: text });
    expect(r.data.message_ids).toHaveLength(2);
    expect(r.data.message_id).toBe(r.data.message_ids[0]);
    const posts = fake.requests.filter((x) => x.method === "POST").map((x) => x.body.content as string);
    expect(posts.every((p) => p.length <= 2000)).toBe(true);
    expect(posts.join("\n")).toBe(text);
    expect(fake.requests.filter((x) => x.method === "POST").every((x) => x.body.allowed_mentions.parse.length <= 1)).toBe(true);
  });

  test("reply_message: only the first part is a reply", async () => {
    const c = await connect();
    const q = fake.post(IDS.times, HUMAN, "q");
    const r = await call(c, "reply_message", { channel_id: IDS.times, message_id: q.id, content: "z".repeat(4500) });
    expect(r.data.message_ids).toHaveLength(3);
    const posts = fake.requests.filter((x) => x.method === "POST");
    expect(posts[0]!.body.message_reference.message_id).toBe(q.id);
    expect(posts.slice(1).every((p) => p.body.message_reference === undefined)).toBe(true);
    expect(posts.map((p) => p.body.content).join("")).toBe("z".repeat(4500));
  });
});

describe("media", () => {
  test("fetch_attachment downloads into the media dir and returns the image inline over MCP", async () => {
    const c = await connect();
    const m = fake.post(IDS.times, HUMAN, "look", undefined, {
      attachments: [
        { id: "501", filename: "cat photo.png", content_type: "image/png", size: 20, url: `${fake.cdn}/attachments/1/501/cat.png?ex=1`, width: 10, height: 8 },
        { id: "502", filename: "notes.txt", content_type: "text/plain", size: 5, url: `${fake.cdn}/attachments/1/502/notes.txt` },
      ],
    });
    const r = await callRaw(c, "fetch_attachment", { channel_id: IDS.times, message_id: m.id });
    expect(r.isError).toBeFalsy();
    const data = JSON.parse((r.content[0] as any).text);
    expect(data.files).toHaveLength(2);
    const [img, txt] = data.files;
    expect(img).toMatchObject({ attachment_id: "501", filename: "cat photo.png", content_type: "image/png", width: 10, height: 8, cached: false });
    expect(img.path).toStartWith(ROOT); // inside the working directory
    expect(img.path).toEndWith("attachments/501-cat_photo.png");
    expect(exists(img.path)).toBe(true);
    expect(txt.content_type).toBe("text/plain");
    // Only the image is inlined
    const images = r.content.filter((x) => x.type === "image") as any[];
    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe("image/png");
    expect(Buffer.from(images[0].data, "base64").equals(readFile(img.path))).toBe(true);
    // The token is never sent to the CDN
    expect(fake.cdnRequests.every((x) => !x.auth)).toBe(true);

    // Second call is served from the local file
    const again = JSON.parse(((await callRaw(c, "fetch_attachment", { channel_id: IDS.times, message_id: m.id, attachment_id: "501" })).content[0] as any).text);
    expect(again.files).toHaveLength(1);
    expect(again.files[0].cached).toBe(true);
  });

  test("fetch_attachment on a message without attachments is NOT_FOUND", async () => {
    const c = await connect();
    const m = fake.post(IDS.times, HUMAN, "no files");
    const r = await call(c, "fetch_attachment", { channel_id: IDS.times, message_id: m.id });
    expect(r.data.error.code).toBe("NOT_FOUND");
  });

  test("get_emoji renders Unicode emoji via Twemoji (FE0F rules) and custom emoji via the CDN", async () => {
    const c = await connect();
    const thumbs = await callRaw(c, "get_emoji", { emoji: "👍" });
    expect(JSON.parse((thumbs.content[0] as any).text)).toMatchObject({ kind: "unicode", codepoints: "1f44d", content_type: "image/png" });
    expect(thumbs.content.some((x) => x.type === "image")).toBe(true);

    const heart = (await call(c, "get_emoji", { emoji: "❤️" })).data; // U+2764 U+FE0F -> 2764
    expect(heart.codepoints).toBe("2764");
    const coder = (await call(c, "get_emoji", { emoji: "👨‍💻" })).data; // ZWJ sequence
    expect(coder.codepoints).toBe("1f468-200d-1f4bb");

    for (const input of ["<:party:123456789012345678>", "party:123456789012345678", "123456789012345678"]) {
      const d = (await call(c, "get_emoji", { emoji: input })).data;
      expect(d).toMatchObject({ kind: "custom", id: "123456789012345678" });
    }
    expect((await call(c, "get_emoji", { emoji: "<a:dance:223456789012345678>" })).data.animated).toBe(true);
    expect(fake.cdnRequests.map((x) => x.path)).toContain("/twemoji/1f44d.png");
    expect(fake.cdnRequests.map((x) => x.path)).toContain("/cdn/emojis/123456789012345678.png?size=128");

    expect((await call(c, "get_emoji", { emoji: "hello" })).data.error.code).toBe("INVALID_ARGUMENT");
  });

  test("get_avatar prefers the guild avatar, then the user avatar, then the default", async () => {
    const c = await connect();
    fake.users.set(HUMAN.id, { ...HUMAN, avatar: "abc123" });
    fake.members.set(HUMAN.id, { roles: [], avatar: "guildhash", nick: "Mo" });
    const g = (await call(c, "get_avatar", { user_id: HUMAN.id, size: 128 })).data;
    expect(g).toMatchObject({ user_id: HUMAN.id, display_name: "Mo", source: "guild", content_type: "image/png" });
    expect(fake.cdnRequests.at(-1)!.path).toBe(`/cdn/guilds/${GUILD_ID}/users/${HUMAN.id}/avatars/guildhash.png?size=128`);

    fake.members.delete(HUMAN.id);
    const u = await callRaw(c, "get_avatar", { user_id: HUMAN.id });
    expect(JSON.parse((u.content[0] as any).text)).toMatchObject({ source: "user", display_name: "Mose" });
    expect(fake.cdnRequests.at(-1)!.path).toBe(`/cdn/avatars/${HUMAN.id}/abc123.png?size=256`);
    expect(u.content.some((x) => x.type === "image")).toBe(true);

    fake.users.set(BOT.id, { ...BOT, avatar: null });
    const idx = (BigInt(BOT.id) >> 22n) % 6n;
    const d = (await call(c, "get_avatar", { user_id: BOT.id })).data;
    if (idx === 0n) expect(d.error.code).toBe("NOT_FOUND"); // fake CDN 404s on 0.png
    else expect(d).toMatchObject({ source: "default", is_bot: true });

    expect((await callRaw(c, "get_avatar", { user_id: HUMAN.id, size: 100 })).isError).toBe(true); // rejected by schema
    expect((await call(c, "get_avatar", { user_id: "123" })).data.error.code).toBe("NOT_FOUND");
  });
});

describe("typing", () => {
  test("send_typing posts the typing indicator", async () => {
    const c = await connect();
    expect((await call(c, "send_typing", { channel_id: IDS.times })).data).toEqual({ ok: true });
    expect(fake.typing).toEqual([IDS.times]);
  });
});

describe("wake spool", () => {
  test("wake_pending reads unacked events; wake_ack advances the cursor; partial lines are ignored", async () => {
    const c = await connect();
    expect((await call(c, "wake_pending")).data).toEqual({ events: [], remaining: 0 });

    const spool = `${ROOT}${dbPath}.wake.jsonl`;
    mkdir(dirOf(spool), { recursive: true });
    const ev = (id: string) => JSON.stringify({ reason: "mention", message_id: id, channel_id: IDS.times, content: "日本語 ok" }) + "\n";
    append(spool, ev("1001") + ev("1002") + ev("1003"));
    append(spool, '{"reason":"mention","message_id":"1004"'); // still being written

    const p1 = (await call(c, "wake_pending", { limit: 2 })).data;
    expect(p1.events.map((e: any) => e.message_id)).toEqual(["1001", "1002"]);
    expect(p1.remaining).toBe(1);

    expect((await call(c, "wake_ack", { up_to_message_id: "1002" })).data).toEqual({ acked: 2, remaining: 1 });
    expect((await call(c, "wake_pending")).data.events.map((e: any) => e.message_id)).toEqual(["1003"]);

    append(spool, ',"channel_id":"1"}\n');
    expect((await call(c, "wake_pending")).data.events.map((e: any) => e.message_id)).toEqual(["1003", "1004"]);
    expect((await call(c, "wake_ack", { up_to_message_id: "9999" })).data.error.code).toBe("NOT_FOUND");
    await call(c, "wake_ack", { up_to_message_id: "1004" });
    expect((await call(c, "wake_pending")).data).toEqual({ events: [], remaining: 0 });
    expect(exists(`${ROOT}${dbPath}.wake-cursor.json`)).toBe(true);
  });
});
