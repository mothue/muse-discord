// Fake Discord REST server for tests (localhost only, no file side effects)
import { snowflakeFromTime, type DChannel, type DMessage, type DUser } from "../src/discord.ts";

export const GOOD_TOKEN = "good-token";
export const GUILD_ID = "1513823779124416582";
export const BOT: DUser = { id: "900000000000000001", username: "minerva-bot", bot: true };
export const HUMAN: DUser = { id: "900000000000000002", username: "mose", global_name: "Mose" };
export const BOT_ROLE = "900000000000000010";

const VIEW = 1n << 10n;
const HISTORY = 1n << 16n;
const SEND = 1n << 11n;

// Old snowflakes for channels that existed before watching started
const OLD = (n: number) => (BigInt(snowflakeFromTime(Date.UTC(2025, 0, 1))) + BigInt(n)).toString();

export interface Recorded {
  method: string;
  path: string;
  body?: any;
}

export class FakeDiscord {
  server: ReturnType<typeof Bun.serve>;
  channels: DChannel[] = [];
  threads: DChannel[] = [];
  messages = new Map<string, DMessage[]>();
  reactions: { channel: string; message: string; emoji: string }[] = [];
  requests: Recorded[] = [];
  /** Return 429 for the next N requests */
  rateLimitNext = 0;
  /** Channels that return 403 (visible by permission calc, but rejected by the API) */
  forbiddenChannels = new Set<string>();
  private seq = 0n;

  constructor() {
    const everyoneDeny = { id: GUILD_ID, type: 0 as const, allow: "0", deny: VIEW.toString() };
    this.channels = [
      { id: OLD(1), type: 4, name: "General", guild_id: GUILD_ID, position: 0, permission_overwrites: [] },
      { id: OLD(2), type: 0, name: "times-mose", guild_id: GUILD_ID, parent_id: OLD(1), topic: "mose's times", position: 1, permission_overwrites: [] },
      { id: OLD(3), type: 0, name: "secret", guild_id: GUILD_ID, position: 2, permission_overwrites: [everyoneDeny] },
      { id: OLD(4), type: 0, name: "bot-allowed-secret", guild_id: GUILD_ID, position: 3, permission_overwrites: [everyoneDeny, { id: BOT_ROLE, type: 0, allow: VIEW.toString(), deny: "0" }] },
      { id: OLD(5), type: 0, name: "forbidden-at-runtime", guild_id: GUILD_ID, position: 4, permission_overwrites: [] },
    ];
    for (const c of this.channels) this.messages.set(c.id, []);
    // Past messages (must not flood in on the first run)
    for (let i = 0; i < 5; i++) this.post(OLD(2), HUMAN, `old ${i}`, OLD(100 + i));

    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => this.handle(req) });
  }

  get base() {
    return `http://127.0.0.1:${this.server.port}/api/v10`;
  }
  stop() {
    this.server.stop(true);
  }

  nextId(): string {
    this.seq += 1n;
    return (BigInt(snowflakeFromTime(Date.now())) + this.seq).toString();
  }

  allChannels() {
    return [...this.channels, ...this.threads];
  }

  post(channelId: string, author: DUser, content: string, id = this.nextId(), extra: Partial<DMessage> = {}): DMessage {
    const m: DMessage = {
      id,
      channel_id: channelId,
      author,
      content,
      timestamp: new Date().toISOString().replace("Z", "000+00:00"),
      mentions: [],
      mention_roles: [],
      attachments: [],
      type: 0,
      ...extra,
    };
    this.messages.get(channelId)!.push(m);
    const ch = this.allChannels().find((c) => c.id === channelId)!;
    ch.last_message_id = id;
    return m;
  }

  createThread(parentId: string, name: string): DChannel {
    const th: DChannel = { id: this.nextId(), type: 11, name, guild_id: GUILD_ID, parent_id: parentId };
    this.threads.push(th);
    this.messages.set(th.id, []);
    return th;
  }

  private json(data: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v10/, "");
    const body = req.method === "GET" || req.method === "PUT" ? undefined : await req.json().catch(() => undefined);
    this.requests.push({ method: req.method, path: path + url.search, body });

    if (req.headers.get("authorization") !== `Bot ${GOOD_TOKEN}`) {
      return this.json({ message: "401: Unauthorized", code: 0 }, 401);
    }
    if (this.rateLimitNext > 0) {
      this.rateLimitNext--;
      return this.json({ message: "You are being rate limited.", retry_after: 0.05, global: false }, 429, { "retry-after": "1" });
    }

    let m: RegExpMatchArray | null;
    if (path === "/users/@me") return this.json(BOT);
    if (path === `/guilds/${GUILD_ID}`)
      return this.json({
        id: GUILD_ID,
        name: "test-guild",
        owner_id: HUMAN.id,
        roles: [
          { id: GUILD_ID, permissions: (VIEW | HISTORY | SEND).toString() },
          { id: BOT_ROLE, permissions: "0" },
        ],
      });
    if (path === `/guilds/${GUILD_ID}/members/${BOT.id}`) return this.json({ roles: [BOT_ROLE] });
    if (path === `/guilds/${GUILD_ID}/channels`) return this.json(this.channels);
    if (path === `/guilds/${GUILD_ID}/threads/active`) return this.json({ threads: this.threads, members: [] });

    if ((m = path.match(/^\/channels\/(\d+)$/))) {
      const ch = this.allChannels().find((c) => c.id === m![1]);
      return ch ? this.json(ch) : this.json({ message: "Unknown Channel", code: 10003 }, 404);
    }

    if ((m = path.match(/^\/channels\/(\d+)\/messages$/))) {
      const cid = m[1]!;
      if (this.forbiddenChannels.has(cid)) return this.json({ message: "Missing Access", code: 50001 }, 403);
      const list = this.messages.get(cid);
      if (!list) return this.json({ message: "Unknown Channel", code: 10003 }, 404);

      if (req.method === "POST") {
        const extra: Partial<DMessage> = {};
        if (body.message_reference) {
          extra.type = 19;
          extra.message_reference = body.message_reference;
        }
        return this.json(this.post(cid, BOT, body.content, this.nextId(), extra));
      }

      const limit = Number(url.searchParams.get("limit") ?? "50");
      const after = url.searchParams.get("after");
      const before = url.searchParams.get("before");
      const asc = [...list].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      let picked: DMessage[];
      if (after) picked = asc.filter((x) => BigInt(x.id) > BigInt(after)).slice(0, limit);
      else if (before) picked = asc.filter((x) => BigInt(x.id) < BigInt(before)).slice(-limit);
      else picked = asc.slice(-limit);
      return this.json(picked.reverse()); // Discord returns newest first
    }

    if ((m = path.match(/^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/)) && req.method === "PUT") {
      this.reactions.push({ channel: m[1]!, message: m[2]!, emoji: decodeURIComponent(m[3]!) });
      return new Response(null, { status: 204 });
    }

    return this.json({ message: "404: Not Found", code: 0 }, 404);
  }
}

export const IDS = {
  category: OLD(1),
  times: OLD(2),
  secret: OLD(3),
  botSecret: OLD(4),
  forbidden: OLD(5),
};
