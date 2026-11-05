// Discord REST client (v10). Logs go to stderr only.

// DISCORD_API_BASE is for tests (points at a fake server)
const API_BASE = process.env.DISCORD_API_BASE?.trim() || "https://discord.com/api/v10";
const MAX_RATE_LIMIT_RETRIES = 2;

export const Permissions = {
  ADD_REACTIONS: 1n << 6n,
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  READ_MESSAGE_HISTORY: 1n << 16n,
} as const;
const ALL_PERMISSIONS = (1n << 64n) - 1n;

export const ChannelTypeName: Record<number, string> = {
  0: "text",
  2: "voice",
  4: "category",
  5: "announcement",
  10: "announcement_thread",
  11: "public_thread",
  12: "private_thread",
  13: "stage",
  15: "forum",
  16: "media",
};
/** Channel types that can hold messages */
export const MESSAGEABLE_TYPES = new Set([0, 2, 5, 10, 11, 12, 13]);
export const THREAD_TYPES = new Set([10, 11, 12]);

export type ErrorCode =
  | "MISSING_TOKEN"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INVALID_ARGUMENT"
  | "DISCORD_API_ERROR"
  | "NETWORK_ERROR"
  | "INTERNAL_ERROR";

export class ToolError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status?: number,
    public discordCode?: number,
  ) {
    super(message);
  }
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.status !== undefined ? { status: this.status } : {}),
        ...(this.discordCode !== undefined ? { discord_code: this.discordCode } : {}),
      },
    };
  }
}

// ---- Discord objects (only the fields we use) ----
export interface DUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}
export interface DOverwrite {
  id: string;
  type: 0 | 1; // 0 = role, 1 = member
  allow: string;
  deny: string;
}
export interface DChannel {
  id: string;
  type: number;
  guild_id?: string;
  name?: string;
  topic?: string | null;
  parent_id?: string | null;
  last_message_id?: string | null;
  permission_overwrites?: DOverwrite[];
  position?: number;
}
export interface DRole {
  id: string;
  permissions: string;
}
export interface DGuild {
  id: string;
  name: string;
  owner_id: string;
  roles: DRole[];
}
export interface DMember {
  roles: string[];
}
export interface DMessage {
  id: string;
  channel_id: string;
  author: DUser;
  content: string;
  timestamp: string;
  mentions: DUser[];
  mention_roles: string[];
  attachments: { filename: string; content_type?: string }[];
  reactions?: { count: number; me: boolean; emoji: { id: string | null; name: string | null } }[];
  message_reference?: { message_id?: string; channel_id?: string };
  type: number;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export class DiscordClient {
  /** route key -> bucket hash */
  private routeBuckets = new Map<string, string>();
  /** bucket(+major param) -> reset time (ms) */
  private bucketResetAt = new Map<string, number>();
  private globalResetAt = 0;

  constructor(private token: string | undefined) {}

  private routeKey(method: string, path: string): { route: string; major: string } {
    // Keep /channels/{id} and /guilds/{id} as the major parameter; collapse other snowflakes
    const m = path.match(/^\/(channels|guilds)\/(\d+)/);
    const major = m ? `${m[1]}:${m[2]}` : "";
    const route = path.split("?")[0]!.replace(/\d{15,}/g, ":id").replace(/\/reactions\/[^/]+/, "/reactions/:emoji");
    return { route: `${method} ${route}`, major };
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.token) {
      throw new ToolError("MISSING_TOKEN", "DISCORD_BOT_TOKEN is not set");
    }
    const { route, major } = this.routeKey(method, path);

    for (let attempt = 0; ; attempt++) {
      // Respect known rate limits before sending
      const bucket = this.routeBuckets.get(route);
      const waitUntil = Math.max(
        this.globalResetAt,
        bucket ? (this.bucketResetAt.get(`${bucket}|${major}`) ?? 0) : 0,
      );
      const wait = waitUntil - Date.now();
      if (wait > 0) await sleep(wait);

      let res: Response;
      try {
        res = await fetch(API_BASE + path, {
          method,
          headers: {
            Authorization: `Bot ${this.token}`,
            "User-Agent": "DiscordBot (muse-discord, 0.1.0)",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        throw new ToolError("NETWORK_ERROR", `failed to reach Discord: ${(e as Error).message}`);
      }

      const bucketHash = res.headers.get("x-ratelimit-bucket");
      if (bucketHash) {
        this.routeBuckets.set(route, bucketHash);
        if (res.headers.get("x-ratelimit-remaining") === "0") {
          const resetAfter = Number(res.headers.get("x-ratelimit-reset-after") ?? "0");
          this.bucketResetAt.set(`${bucketHash}|${major}`, Date.now() + resetAfter * 1000);
        }
      }

      if (res.status === 429) {
        const data = (await res.json().catch(() => ({}))) as { retry_after?: number; global?: boolean };
        const retryAfterSec = Number(data.retry_after ?? res.headers.get("retry-after") ?? "1");
        if (data.global) this.globalResetAt = Date.now() + retryAfterSec * 1000;
        if (attempt >= MAX_RATE_LIMIT_RETRIES) {
          throw new ToolError("RATE_LIMITED", `rate limited (retry_after=${retryAfterSec}s)`, 429);
        }
        console.error(`[discord] 429 on ${route}, retry in ${retryAfterSec}s (${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`);
        await sleep(retryAfterSec * 1000);
        continue;
      }

      if (res.status === 204) return undefined as T;
      const text = await res.text();
      const data = text ? JSON.parse(text) : undefined;

      if (res.ok) return data as T;

      const msg = (data as { message?: string })?.message ?? res.statusText;
      const dcode = (data as { code?: number })?.code;
      switch (res.status) {
        case 401:
          throw new ToolError("UNAUTHORIZED", `invalid bot token: ${msg}`, 401, dcode);
        case 403:
          throw new ToolError("FORBIDDEN", msg, 403, dcode);
        case 404:
          throw new ToolError("NOT_FOUND", msg, 404, dcode);
        default:
          throw new ToolError("DISCORD_API_ERROR", msg, res.status, dcode);
      }
    }
  }

  me() {
    return this.request<DUser>("GET", "/users/@me");
  }
  guild(guildId: string) {
    return this.request<DGuild>("GET", `/guilds/${guildId}`);
  }
  member(guildId: string, userId: string) {
    return this.request<DMember>("GET", `/guilds/${guildId}/members/${userId}`);
  }
  guildChannels(guildId: string) {
    return this.request<DChannel[]>("GET", `/guilds/${guildId}/channels`);
  }
  activeThreads(guildId: string) {
    return this.request<{ threads: DChannel[] }>("GET", `/guilds/${guildId}/threads/active`);
  }
  channel(channelId: string) {
    return this.request<DChannel>("GET", `/channels/${channelId}`);
  }
  messages(channelId: string, q: { limit?: number; before?: string; after?: string }) {
    const p = new URLSearchParams();
    if (q.limit !== undefined) p.set("limit", String(q.limit));
    if (q.before) p.set("before", q.before);
    if (q.after) p.set("after", q.after);
    return this.request<DMessage[]>("GET", `/channels/${channelId}/messages?${p}`);
  }
  createMessage(channelId: string, payload: unknown) {
    return this.request<DMessage>("POST", `/channels/${channelId}/messages`, payload);
  }
  addReaction(channelId: string, messageId: string, emoji: string) {
    return this.request<void>(
      "PUT",
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    );
  }
}

// ---- Permission calculation ----

export function basePermissions(guild: DGuild, member: DMember, userId: string): bigint {
  if (guild.owner_id === userId) return ALL_PERMISSIONS;
  const roles = new Map(guild.roles.map((r) => [r.id, BigInt(r.permissions)]));
  let perms = roles.get(guild.id) ?? 0n; // @everyone
  for (const rid of member.roles) perms |= roles.get(rid) ?? 0n;
  if (perms & Permissions.ADMINISTRATOR) return ALL_PERMISSIONS;
  return perms;
}

export function channelPermissions(
  base: bigint,
  channel: DChannel,
  guildId: string,
  member: DMember,
  userId: string,
): bigint {
  if (base & Permissions.ADMINISTRATOR || base === ALL_PERMISSIONS) return ALL_PERMISSIONS;
  let perms = base;
  const ows = channel.permission_overwrites ?? [];
  const everyone = ows.find((o) => o.id === guildId);
  if (everyone) perms = (perms & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of ows) {
    if (o.type === 0 && member.roles.includes(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  }
  perms = (perms & ~deny) | allow;
  const own = ows.find((o) => o.type === 1 && o.id === userId);
  if (own) perms = (perms & ~BigInt(own.deny)) | BigInt(own.allow);
  return perms;
}

// ---- snowflake ----

const DISCORD_EPOCH = 1420070400000n;
export function snowflakeFromTime(ms: number): string {
  return ((BigInt(ms) - DISCORD_EPOCH) << 22n).toString();
}
export function maxId(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b;
}
