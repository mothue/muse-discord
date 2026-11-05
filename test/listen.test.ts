// E2E for `listen`: spawn the listener against a fake REST API + fake Gateway.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { BOT, FakeDiscord, GOOD_TOKEN, GUILD_ID, HUMAN } from "./fake-discord.ts";
import { FakeGateway } from "./fake-gateway.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const TEST_DIR = ".test-data-listen";
const BOT_USER = { id: BOT.id, username: "mose" };
const AGENT_ROLE = "1567703605514084353";
const TEXT_CH = "1567704255312420001";
const WATCHED_CH = "1567704255312420002";
const OTHER_BOT = { id: "900000000000000099", username: "other-agent", bot: true };

let fake: FakeDiscord;
let gw: FakeGateway;
let spool: string;
let statePath: string;
let n = 0;
const procs: Listener[] = [];

interface Listener {
  proc: ReturnType<typeof Bun.spawn>;
  logs: any[];
  rawOut: string;
  rawErr: string;
  exited: Promise<number>;
}

function start(extraEnv: Record<string, string> = {}): Listener {
  const proc = Bun.spawn([process.execPath, "run", "src/server.ts", "listen"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      DISCORD_BOT_TOKEN: GOOD_TOKEN,
      DISCORD_API_BASE: fake.base,
      DISCORD_GUILD_ID: GUILD_ID,
      WAKE_CHANNEL_IDS: WATCHED_CH,
      WAKE_SPOOL_PATH: spool,
      LISTEN_STATE_PATH: statePath,
      ...extraEnv,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const l: Listener = { proc, logs: [], rawOut: "", rawErr: "", exited: proc.exited };
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      const text = dec.decode(chunk, { stream: true });
      l.rawOut += text;
      buf += text;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) l.logs.push(JSON.parse(line));
      }
    }
  })();
  (async () => {
    l.rawErr = await new Response(proc.stderr as ReadableStream).text();
  })();
  procs.push(l);
  return l;
}

async function waitFor<T>(fn: () => T | undefined | false, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await Bun.sleep(20);
  }
  throw new Error("waitFor timed out");
}

const spoolLines = (): any[] =>
  existsSync(`${ROOT}${spool}`)
    ? readFileSync(`${ROOT}${spool}`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

let idSeq = 0n;
function msg(over: Record<string, unknown> = {}) {
  idSeq += 1n;
  return {
    id: (1567900000000000000n + idSeq).toString(),
    channel_id: TEXT_CH,
    guild_id: GUILD_ID,
    channel_type: 0,
    author: { id: HUMAN.id, username: HUMAN.username, global_name: HUMAN.global_name },
    content: "hello",
    timestamp: "2026-11-05T09:00:00.000000+00:00",
    mentions: [],
    mention_roles: [],
    ...over,
  };
}

/** Start, complete Identify, receive READY. */
async function startReady(extraEnv?: Record<string, string>) {
  const l = start(extraEnv);
  await waitFor(() => gw.received.find((p) => p.op === 2));
  gw.ready(BOT_USER);
  await waitFor(() => l.logs.find((x) => x.event === "ready"));
  return l;
}

/** Send a mention as a sentinel and wait until it is spooled, so earlier messages have been processed. */
async function flush() {
  const s = msg({ content: "sentinel", mentions: [{ id: BOT.id }] });
  gw.dispatch("MESSAGE_CREATE", s);
  await waitFor(() => spoolLines().find((x) => x.message_id === s.id));
  return s;
}

beforeEach(() => {
  fake = new FakeDiscord();
  gw = new FakeGateway();
  fake.gatewayUrl = gw.url;
  spool = `${TEST_DIR}/${process.pid}-${n}/wake.jsonl`;
  statePath = `${TEST_DIR}/${process.pid}-${n}/listen-state.json`;
  n++;
});

afterEach(async () => {
  for (const l of procs.splice(0)) {
    l.proc.kill("SIGTERM");
    await l.exited;
    // The token must never show up in logs (stdout/stderr) or the spool
    expect(l.rawOut).not.toContain(GOOD_TOKEN);
    expect(l.rawErr).not.toContain(GOOD_TOKEN);
  }
  if (existsSync(`${ROOT}${spool}`)) expect(readFileSync(`${ROOT}${spool}`, "utf8")).not.toContain(GOOD_TOKEN);
  fake.stop();
  gw.stop();
});

afterAll(() => rmSync(`${ROOT}${TEST_DIR}`, { recursive: true, force: true }));

describe("connect", () => {
  test("Hello -> Identify (token, intents 33281) -> READY logs ready; heartbeats carry seq", async () => {
    gw.heartbeatInterval = 100;
    const l = start();
    const identify = await waitFor(() => gw.received.find((p) => p.op === 2));
    expect(identify.d.token).toBe(GOOD_TOKEN);
    expect(identify.d.intents).toBe(33281);
    expect(gw.current!.path).toContain("v=10");
    expect(gw.current!.path).toContain("encoding=json");

    const s = gw.ready(BOT_USER);
    const ready = await waitFor(() => l.logs.find((x) => x.event === "ready"));
    expect(ready).toMatchObject({ username: "mose", id: BOT.id });
    expect(l.logs[0].event).toBe("connecting");

    const hb = await waitFor(() => gw.received.find((p) => p.op === 1 && p.d === s));
    expect(hb).toEqual({ op: 1, d: s });
  });

  test("zombie connection (no heartbeat ACK) triggers a resume reconnect", async () => {
    gw.heartbeatInterval = 100;
    const l = await startReady();
    gw.ackHeartbeats = false;
    const rc = await waitFor(() => l.logs.find((x) => x.event === "reconnecting"));
    expect(rc).toMatchObject({ reason: "heartbeat_ack_timeout", in_seconds: 1, resume: true });
    await waitFor(() => gw.received.find((p) => p.op === 6), 4000);
    expect(gw.current!.path.startsWith("/resume")).toBe(true);
  });

  test("fatal close code (4004) exits 1 without reconnecting", async () => {
    const l = start();
    await waitFor(() => gw.received.find((p) => p.op === 2));
    gw.current!.ws.close(4004, "Authentication failed");
    expect(await l.exited).toBe(1);
    expect(l.logs.find((x) => x.event === "error")).toMatchObject({ close_code: 4004 });
    expect(gw.conns.length).toBe(1);
  });

  test("invalid REST token exits 1 before connecting", async () => {
    const l = start({ DISCORD_BOT_TOKEN: "bad-token-value" });
    expect(await l.exited).toBe(1);
    expect(l.logs[0]).toMatchObject({ event: "error", code: "UNAUTHORIZED" });
    expect(l.rawOut).not.toContain("bad-token-value");
    expect(gw.conns.length).toBe(0);
  });
});

describe("triggers and spool", () => {
  test("bot mention writes one well-formed line", async () => {
    const l = await startReady();
    const m = msg({ content: `<@${BOT.id}> ping`, mentions: [{ id: BOT.id }] });
    gw.dispatch("MESSAGE_CREATE", m);
    const line = await waitFor(() => spoolLines()[0]);
    expect(Object.keys(line).sort()).toEqual(
      ["author_id", "author_name", "channel_id", "content", "detected_at", "guild_id", "message_id", "reason", "timestamp"].sort(),
    );
    expect(line).toMatchObject({
      reason: "mention",
      message_id: m.id,
      channel_id: TEXT_CH,
      guild_id: GUILD_ID,
      author_id: HUMAN.id,
      author_name: "Mose",
      content: `<@${BOT.id}> ping`,
      timestamp: "2026-11-05T09:00:00.000000+00:00",
    });
    expect(Date.parse(line.detected_at)).not.toBeNaN();
    const trig = await waitFor(() => l.logs.find((x) => x.event === "trigger"));
    expect(Object.keys(trig).sort()).toEqual(["channel_id", "event", "message_id", "ts"]);
  });

  test("text mention forms, role mention, other bots, and 500-char truncation", async () => {
    await startReady();
    const nick = msg({ content: `hey <@!${BOT.id}>` }); // mentions array empty, only in text
    const role = msg({ content: `<@&${AGENT_ROLE}> all`, mention_roles: [AGENT_ROLE] });
    const fromBot = msg({ author: OTHER_BOT, content: `<@${BOT.id}> from agent`, mentions: [{ id: BOT.id }] });
    const long = msg({ content: `<@${BOT.id}> ` + "あ".repeat(600), mentions: [{ id: BOT.id }] });
    for (const m of [nick, role, fromBot, long]) gw.dispatch("MESSAGE_CREATE", m);
    await waitFor(() => spoolLines().length === 4);
    const lines = spoolLines();
    expect(lines.map((x) => x.reason)).toEqual(["mention", "role_mention", "mention", "mention"]);
    expect(lines[2].author_id).toBe(OTHER_BOT.id);
    expect(Array.from(lines[3].content as string).length).toBe(500);
  });

  test("plain messages, DMs, other guilds, own messages and non-message events are not spooled", async () => {
    await startReady();
    gw.dispatch("MESSAGE_CREATE", msg({ content: "just chatting" }));
    gw.dispatch("MESSAGE_CREATE", msg({ guild_id: undefined, channel_type: 1, content: `<@${BOT.id}>`, mentions: [{ id: BOT.id }] }));
    gw.dispatch("MESSAGE_CREATE", msg({ guild_id: "123", content: `<@${BOT.id}>`, mentions: [{ id: BOT.id }] }));
    gw.dispatch("MESSAGE_CREATE", msg({ author: { id: BOT.id, username: "mose", bot: true }, content: `<@${BOT.id}>`, mentions: [{ id: BOT.id }] }));
    gw.dispatch("MESSAGE_CREATE", msg({ author: { id: BOT.id, username: "mose", bot: true }, channel_id: WATCHED_CH }));
    gw.dispatch("MESSAGE_UPDATE", msg({ content: `<@${BOT.id}>`, mentions: [{ id: BOT.id }] }));
    const s = await flush();
    expect(spoolLines().map((x) => x.message_id)).toEqual([s.id]);
  });

  test("watched channel spools without a mention", async () => {
    await startReady();
    const m = msg({ channel_id: WATCHED_CH, content: "no mention here" });
    gw.dispatch("MESSAGE_CREATE", m);
    const line = await waitFor(() => spoolLines()[0]);
    expect(line).toMatchObject({ reason: "watched_channel", message_id: m.id, channel_id: WATCHED_CH });
  });

  test("token posted in a message is redacted in the spool", async () => {
    await startReady();
    gw.dispatch("MESSAGE_CREATE", msg({ content: `<@${BOT.id}> ${GOOD_TOKEN}`, mentions: [{ id: BOT.id }] }));
    const line = await waitFor(() => spoolLines()[0]);
    expect(line.content).toBe(`<@${BOT.id}> [REDACTED]`);
  });

  test("does not touch the SQLite DB", async () => {
    await startReady({ DISCORD_MCP_DB: `${TEST_DIR}/must-not-exist.sqlite` });
    await flush();
    expect(existsSync(`${ROOT}${TEST_DIR}/must-not-exist.sqlite`)).toBe(false);
  });
});

describe("resume and dedupe", () => {
  test("disconnect -> Resume with session_id + seq; replayed message is not spooled twice", async () => {
    const l = await startReady();
    const m = msg({ content: `<@${BOT.id}> once`, mentions: [{ id: BOT.id }] });
    const s = gw.dispatch("MESSAGE_CREATE", m);
    await waitFor(() => spoolLines().length === 1);

    gw.current!.ws.close(4000, "server restart");
    const resume = await waitFor(() => gw.received.find((p) => p.op === 6), 4000);
    expect(resume.d).toEqual({ token: GOOD_TOKEN, session_id: "sess-1", seq: s });
    expect(gw.current!.path.startsWith("/resume")).toBe(true);

    gw.replay("MESSAGE_CREATE", m, s); // Discord replays missed events
    gw.dispatch("RESUMED", null);
    await waitFor(() => l.logs.find((x) => x.event === "resumed"));
    const sentinel = await flush();
    expect(spoolLines().map((x) => x.message_id)).toEqual([m.id, sentinel.id]);
    expect(l.logs.find((x) => x.event === "reconnecting")).toMatchObject({ reason: "closed_4000", resume: true });
  });

  test("op 7 Reconnect resumes", async () => {
    await startReady();
    gw.send({ op: 7, d: null });
    await waitFor(() => gw.received.find((p) => p.op === 6), 4000);
  });

  test("op 9 (d=false) falls back to a fresh Identify", async () => {
    await startReady();
    gw.send({ op: 9, d: false });
    await waitFor(() => gw.received.filter((p) => p.op === 2).length === 2, 4000);
    expect(gw.received.some((p) => p.op === 6)).toBe(false);
    expect(gw.current!.path.startsWith("/gw")).toBe(true);
  });

  test("process restart resumes from persisted state and keeps dedupe", async () => {
    const first = await startReady();
    const m = msg({ content: `<@${BOT.id}> before restart`, mentions: [{ id: BOT.id }] });
    const s = gw.dispatch("MESSAGE_CREATE", m);
    await waitFor(() => spoolLines().length === 1);
    first.proc.kill("SIGTERM");
    expect(await first.exited).toBe(0);
    expect(first.logs.at(-1)).toMatchObject({ event: "stopped", signal: "SIGTERM" });
    const persisted = JSON.parse(readFileSync(`${ROOT}${statePath}`, "utf8"));
    expect(persisted).toMatchObject({ session_id: "sess-1", seq: s, bot_user_id: BOT.id });
    expect(persisted.recent_message_ids).toContain(m.id);
    expect(readFileSync(`${ROOT}${statePath}`, "utf8")).not.toContain(GOOD_TOKEN);

    const second = start();
    const resume = await waitFor(() => gw.received.find((p) => p.op === 6));
    expect(resume.d).toMatchObject({ session_id: "sess-1", seq: s });
    gw.replay("MESSAGE_CREATE", m, s);
    gw.dispatch("RESUMED", null);
    await waitFor(() => second.logs.find((x) => x.event === "resumed"));
    const sentinel = await flush();
    expect(spoolLines().map((x) => x.message_id)).toEqual([m.id, sentinel.id]);
  });

  test("restart after invalid session re-identifies and dedupe still holds", async () => {
    const first = await startReady();
    const m = msg({ content: `<@${BOT.id}> x`, mentions: [{ id: BOT.id }] });
    gw.dispatch("MESSAGE_CREATE", m);
    await waitFor(() => spoolLines().length === 1);
    first.proc.kill("SIGTERM");
    await first.exited;

    const second = start();
    await waitFor(() => gw.received.find((p) => p.op === 6));
    gw.send({ op: 9, d: false });
    await waitFor(() => gw.received.filter((p) => p.op === 2).length === 2, 4000);
    gw.ready(BOT_USER, "sess-2");
    await waitFor(() => second.logs.find((x) => x.event === "ready" && x.session_id === "sess-2"));
    gw.dispatch("MESSAGE_CREATE", m); // redelivered after re-identify
    const sentinel = await flush();
    expect(spoolLines().map((x) => x.message_id)).toEqual([m.id, sentinel.id]);
  });
});
