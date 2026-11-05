// Tool definitions shared by the MCP server and the one-shot CLI.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { StateDB } from "./db.ts";
import {
  ChannelTypeName,
  DiscordClient,
  MESSAGEABLE_TYPES,
  Permissions,
  ToolError,
  basePermissions,
  channelPermissions,
  maxId,
  snowflakeFromTime,
  type DChannel,
  type DMessage,
  type DUser,
} from "./discord.ts";
import {
  CDN_BASE,
  INLINE_IMAGE_TYPES,
  MAX_INLINE_IMAGE_BYTES,
  TWEMOJI_BASE,
  download,
  parseEmoji,
  safeName,
  splitMessage,
  twemojiCode,
  type Downloaded,
} from "./media.ts";
import { resolveInsideCwd } from "./paths.ts";

const MAX_UNREAD_PAGES = 10; // count at most 1000 unread messages per channel
const REPLY_EXCERPT_CHARS = 200;
const MAX_SPLIT_CHUNKS = 10;

export interface ToolDef {
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: any) => Promise<unknown>;
}

/** A tool result that also carries local image files (sent inline over MCP; the CLI prints only `data`). */
export class WithImages {
  constructor(
    public data: unknown,
    public images: { path: string; mimeType: string }[],
  ) {}
}

export interface Context {
  db: StateDB;
  discord: DiscordClient;
  defaultGuildId: string;
}

const snowflake = z.string().regex(/^\d{1,20}$/, "must be a snowflake (string of digits)");
const content = z
  .string()
  .min(1)
  .max(2000 * MAX_SPLIT_CHUNKS)
  .describe("Message body. Over 2000 chars is split into several messages (newline/space boundaries, code blocks kept)");
const mentionIds = z
  .array(snowflake)
  .max(100)
  .optional()
  .describe("If set, only these users get pinged. If omitted, user mentions in the content work as usual");

const byIdAsc = (a: { id: string }, b: { id: string }) => {
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x < y ? -1 : x > y ? 1 : 0;
};

const typeName = (t: number) => ChannelTypeName[t] ?? String(t);
const displayName = (u: DUser) => u.global_name || u.username;

// ---- readable content ----

interface Names {
  users: Map<string, string>;
  roles: Map<string, string>;
  channels: Map<string, string>;
}
const emptyNames = (): Names => ({ users: new Map(), roles: new Map(), channels: new Map() });

/** Replace raw mention / emoji / timestamp markup with readable text. */
export function readableContent(content: string, names: Names): string {
  return content
    .replace(/<@!?(\d+)>/g, (raw, id) => (names.users.has(id) ? `@${names.users.get(id)}` : raw))
    .replace(/<@&(\d+)>/g, (raw, id) => (names.roles.has(id) ? `@${names.roles.get(id)}` : raw))
    .replace(/<#(\d+)>/g, (raw, id) => (names.channels.has(id) ? `#${names.channels.get(id)}` : raw))
    .replace(/<a?:([^:>\s]+):\d+>/g, ":$1:")
    .replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, (_, sec) => new Date(Number(sec) * 1000).toISOString());
}

function truncate(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length > n ? chars.slice(0, n).join("") + "…" : s;
}

function formatMessage(m: DMessage, botId: string, names: Names) {
  const local: Names = { ...names, users: new Map(names.users) };
  for (const u of m.mentions) local.users.set(u.id, displayName(u));
  const readable = readableContent(m.content, local);
  const isReply = m.type === 19;
  const ref = m.referenced_message;
  return {
    id: m.id,
    author_id: m.author.id,
    author_name: displayName(m.author),
    author_is_bot: !!m.author.bot,
    content: m.content,
    // Only present when it differs from `content`
    ...(readable !== m.content ? { content_readable: readable } : {}),
    timestamp: new Date(m.timestamp).toISOString(),
    reply_to_message_id: isReply ? (m.message_reference?.message_id ?? null) : null,
    ...(isReply
      ? {
          reply_to: ref
            ? {
                author_id: ref.author.id,
                author_name: displayName(ref.author),
                content: truncate(readableContent(ref.content, local), REPLY_EXCERPT_CHARS),
              }
            : { deleted: true },
        }
      : {}),
    mentions_bot: m.mentions.some((u) => u.id === botId),
    attachments: m.attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      content_type: a.content_type ?? null,
      ...(a.size !== undefined ? { size: a.size } : {}),
      ...(a.width ? { width: a.width, height: a.height } : {}),
    })),
    reactions: (m.reactions ?? []).map((r) => ({
      emoji: r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : (r.emoji.name ?? ""),
      count: r.count,
      me: r.me,
    })),
  };
}

function allowedMentions(userIds?: string[]) {
  // @everyone / @here / roles are always disabled
  return userIds ? { parse: [] as string[], users: userIds } : { parse: ["users"] };
}

function inlineImages(files: (Downloaded & { content_type: string })[]) {
  return files
    .filter((f) => INLINE_IMAGE_TYPES.has(f.content_type) && f.bytes <= MAX_INLINE_IMAGE_BYTES)
    .map((f) => ({ path: f.path, mimeType: f.content_type }));
}

export function createTools({ db, discord, defaultGuildId }: Context): Record<string, ToolDef> {
  let cachedMe: DUser | null = null;
  async function me(): Promise<DUser> {
    if (cachedMe) return cachedMe;
    cachedMe = await discord.me();
    db.setMeta("bot_user_id", cachedMe.id);
    return cachedMe;
  }

  // Per-process caches for readable names
  const guildNames = new Map<string, Names>();
  const channelGuild = new Map<string, string | null>();

  async function namesForGuild(guildId: string): Promise<Names> {
    const cached = guildNames.get(guildId);
    if (cached) return cached;
    const names = emptyNames();
    const [guild, channels] = await Promise.all([discord.guild(guildId), discord.guildChannels(guildId)]);
    for (const r of guild.roles) if (r.name) names.roles.set(r.id, r.name);
    for (const c of channels) if (c.name) names.channels.set(c.id, c.name);
    guildNames.set(guildId, names);
    return names;
  }

  /** Names for role/channel mentions, fetched only when some message actually needs them. */
  async function namesFor(channelId: string, msgs: DMessage[]): Promise<Names> {
    const texts = msgs.flatMap((m) => [m.content, m.referenced_message?.content ?? ""]);
    if (!texts.some((t) => /<@&\d+>|<#\d+>/.test(t))) return emptyNames();
    try {
      if (!channelGuild.has(channelId)) channelGuild.set(channelId, (await discord.channel(channelId)).guild_id ?? null);
      const gid = channelGuild.get(channelId);
      return gid ? await namesForGuild(gid) : emptyNames();
    } catch {
      return emptyNames(); // names are best-effort
    }
  }

  /** Fetch guild channels + active threads and split them into visible / excluded for the bot. */
  async function resolveChannels(guildId: string, botId: string) {
    const [guild, member, channels, threads] = await Promise.all([
      discord.guild(guildId),
      discord.member(guildId, botId),
      discord.guildChannels(guildId),
      discord.activeThreads(guildId).catch((e) => {
        if (e instanceof ToolError && e.code === "FORBIDDEN") return { threads: [] as DChannel[] };
        throw e;
      }),
    ]);
    // Fill the name cache while we have everything
    const names = emptyNames();
    for (const r of guild.roles) if (r.name) names.roles.set(r.id, r.name);
    for (const c of [...channels, ...threads.threads]) {
      if (c.name) names.channels.set(c.id, c.name);
      channelGuild.set(c.id, guildId);
    }
    guildNames.set(guildId, names);

    const base = basePermissions(guild, member, botId);
    const visible: (DChannel & { perms: bigint })[] = [];
    const excluded: { id: string; name: string; type: string; reason: string }[] = [];
    const permsById = new Map<string, bigint>();
    const place = (ch: DChannel, perms: bigint) => {
      if (perms & Permissions.VIEW_CHANNEL) visible.push({ ...ch, perms });
      else excluded.push({ id: ch.id, name: ch.name ?? "", type: typeName(ch.type), reason: "no_view_permission" });
    };

    for (const ch of channels.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
      const perms = channelPermissions(base, ch, guildId, member, botId);
      permsById.set(ch.id, perms);
      place(ch, perms);
    }
    // Threads inherit permissions from their parent channel
    for (const th of threads.threads) place(th, th.parent_id ? (permsById.get(th.parent_id) ?? 0n) : 0n);
    return { visible, excluded, names };
  }

  /** Send content, splitting over 2000 chars. The first chunk carries `reference` (for replies). */
  async function sendChunks(channelId: string, text: string, mentions: object, reference?: object) {
    const chunks = splitMessage(text);
    if (chunks.length > MAX_SPLIT_CHUNKS) throw new ToolError("INVALID_ARGUMENT", `content splits into too many messages (${chunks.length})`);
    const sentMsgs: DMessage[] = [];
    for (const [i, chunk] of chunks.entries()) {
      try {
        sentMsgs.push(
          await discord.createMessage(channelId, {
            content: chunk,
            allowed_mentions: mentions,
            ...(i === 0 && reference ? { message_reference: reference } : {}),
          }),
        );
      } catch (e) {
        if (sentMsgs.length > 0 && e instanceof ToolError) {
          e.message += ` (sent ${sentMsgs.length}/${chunks.length} parts before failing: ${sentMsgs.map((m) => m.id).join(",")})`;
        }
        throw e;
      }
    }
    const first = sentMsgs[0]!;
    return {
      message_id: first.id,
      channel_id: first.channel_id,
      timestamp: new Date(first.timestamp).toISOString(),
      message_ids: sentMsgs.map((m) => m.id),
    };
  }

  // ---- wake spool (written by `listen`) ----
  const spoolPath = () =>
    resolveInsideCwd(process.env.WAKE_SPOOL_PATH?.trim() || "./data/wake-events.jsonl", "WAKE_SPOOL_PATH");
  const cursorPath = () =>
    resolveInsideCwd(process.env.WAKE_CURSOR_PATH?.trim() || "./data/wake-cursor.json", "WAKE_CURSOR_PATH");
  const readCursor = (): number => {
    const p = cursorPath();
    if (!existsSync(p)) return 0;
    try {
      return Number(JSON.parse(readFileSync(p, "utf8")).offset) || 0;
    } catch {
      return 0;
    }
  };
  const writeCursor = (offset: number) => {
    const p = cursorPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(`${p}.tmp`, JSON.stringify({ offset, updated_at: new Date().toISOString() }));
    renameSync(`${p}.tmp`, p);
  };
  /** Complete spool lines after the cursor, with each line's end byte offset. */
  const pendingLines = () => {
    const p = spoolPath();
    if (!existsSync(p)) return [];
    const buf = readFileSync(p);
    let pos = Math.min(readCursor(), buf.length);
    const out: { event: any; end: number }[] = [];
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl < 0) break; // partial line still being written
      const line = buf.subarray(pos, nl).toString("utf8").trim();
      pos = nl + 1;
      if (!line) continue;
      try {
        out.push({ event: JSON.parse(line), end: pos });
      } catch {
        out.push({ event: { malformed: line }, end: pos });
      }
    }
    return out;
  };

  return {
    whoami: {
      description: "Return the bot's own user id and username (token check).",
      inputSchema: {},
      handler: async () => {
        const u = await me();
        return { id: u.id, username: u.username };
      },
    },

    list_channels: {
      description:
        "List channels the bot can view (including categories and active threads). Channels it cannot view are listed in excluded_channels.",
      inputSchema: { guild_id: snowflake.optional().describe("Defaults to the default guild") },
      handler: async ({ guild_id }: { guild_id?: string }) => {
        const gid = guild_id ?? defaultGuildId;
        const bot = await me();
        const { visible, excluded } = await resolveChannels(gid, bot.id);
        return {
          guild_id: gid,
          channels: visible.map((c) => ({
            id: c.id,
            name: c.name ?? "",
            type: typeName(c.type),
            parent_id: c.parent_id ?? null,
            topic: c.topic ?? null,
          })),
          excluded_channels: excluded,
        };
      },
    },

    list_unread: {
      description:
        "Return messages after each channel's read watermark, oldest first. Does NOT advance the watermark (use mark_read). " +
        "Channels without a watermark are initialized to their latest message and listed in initialized_channels. " +
        "Channels with 0 unread are omitted. If truncated=true, mark_read up to the last returned message id.",
      inputSchema: {
        guild_id: snowflake.optional(),
        per_channel_limit: z.number().int().min(1).max(100).optional().describe("Default 50, max 100"),
        include_own: z.boolean().optional().describe("Include the bot's own messages (default false)"),
      },
      handler: async (args: { guild_id?: string; per_channel_limit?: number; include_own?: boolean }) => {
        const gid = args.guild_id ?? defaultGuildId;
        const limit = args.per_channel_limit ?? 50;
        const includeOwn = args.include_own ?? false;
        const bot = await me();

        // When we first started watching this guild. Channels/threads created after it are
        // treated as new, so all their messages count as unread.
        const baselineKey = `guild_baseline:${gid}`;
        const baseline = db.getMeta(baselineKey);

        const { visible, excluded, names } = await resolveChannels(gid, bot.id);
        const states = db.getAllReadStates();
        const skipped = excluded.map((e) => ({ channel_id: e.id, channel_name: e.name, reason: e.reason }));
        const initialized: string[] = [];
        const out: unknown[] = [];

        for (const ch of visible) {
          if (!MESSAGEABLE_TYPES.has(ch.type)) continue;
          const name = ch.name ?? "";
          if (!(ch.perms & Permissions.READ_MESSAGE_HISTORY)) {
            skipped.push({ channel_id: ch.id, channel_name: name, reason: "no_read_history_permission" });
            continue;
          }

          let watermark = states.get(ch.id)?.last_read_message_id;
          if (watermark === undefined) {
            if (baseline !== null && BigInt(ch.id) > BigInt(baseline)) {
              // Created after watching started: read from creation (thread starter id == thread id, hence -1)
              watermark = db.advance(ch.id, gid, (BigInt(ch.id) - 1n).toString());
            } else {
              db.advance(ch.id, gid, ch.last_message_id ?? ch.id);
              initialized.push(ch.id);
              continue;
            }
          }

          // Skip the API call when nothing is newer than the watermark
          if (!ch.last_message_id || BigInt(ch.last_message_id) <= BigInt(watermark)) continue;

          const collected: DMessage[] = [];
          let cursor = watermark;
          let capped = false;
          try {
            for (let page = 0; ; page++) {
              if (page >= MAX_UNREAD_PAGES) {
                capped = true;
                break;
              }
              const batch = (await discord.messages(ch.id, { after: cursor, limit: 100 })).sort(byIdAsc);
              if (batch.length === 0) break;
              for (const m of batch) if (includeOwn || m.author.id !== bot.id) collected.push(m);
              cursor = batch[batch.length - 1]!.id;
              if (batch.length < 100) break;
            }
          } catch (e) {
            if (e instanceof ToolError && (e.code === "FORBIDDEN" || e.code === "NOT_FOUND")) {
              skipped.push({ channel_id: ch.id, channel_name: name, reason: e.code === "FORBIDDEN" ? "forbidden" : "not_found" });
              continue;
            }
            throw e;
          }
          if (collected.length === 0) continue;

          out.push({
            channel_id: ch.id,
            channel_name: name,
            channel_type: typeName(ch.type),
            parent_id: ch.parent_id ?? null,
            unread_count: collected.length,
            ...(capped ? { unread_count_is_lower_bound: true } : {}),
            truncated: collected.length > limit,
            messages: collected.slice(0, limit).map((m) => formatMessage(m, bot.id, names)),
          });
        }

        if (baseline === null) db.setMeta(baselineKey, snowflakeFromTime(Date.now()));

        return { guild_id: gid, channels: out, initialized_channels: initialized, skipped_channels: skipped };
      },
    },

    mark_read: {
      description:
        "Advance a channel's watermark. Without up_to_message_id, advances to the latest message. Never moves backwards.",
      inputSchema: { channel_id: snowflake, up_to_message_id: snowflake.optional() },
      handler: async ({ channel_id, up_to_message_id }: { channel_id: string; up_to_message_id?: string }) => {
        let target = up_to_message_id;
        let guildId: string | null = db.getReadState(channel_id)?.guild_id ?? null;
        if (!target || !guildId) {
          const ch = await discord.channel(channel_id);
          guildId = ch.guild_id ?? guildId;
          if (!target) {
            const latest = await discord.messages(channel_id, { limit: 1 });
            target = latest[0] ? maxId(latest[0].id, ch.last_message_id ?? "0") : (ch.last_message_id ?? ch.id);
          }
        }
        return { channel_id, last_read_message_id: db.advance(channel_id, guildId, target) };
      },
    },

    get_messages: {
      description: "Read channel history without touching the watermark. Returns an array, oldest first.",
      inputSchema: {
        channel_id: snowflake,
        limit: z.number().int().min(1).max(100).optional().describe("Default 50, max 100"),
        before: snowflake.optional(),
        after: snowflake.optional(),
      },
      handler: async (a: { channel_id: string; limit?: number; before?: string; after?: string }) => {
        if (a.before && a.after) throw new ToolError("INVALID_ARGUMENT", "before and after cannot be used together");
        const bot = await me();
        const msgs = (await discord.messages(a.channel_id, { limit: a.limit ?? 50, before: a.before, after: a.after })).sort(byIdAsc);
        const names = await namesFor(a.channel_id, msgs);
        return msgs.map((m) => formatMessage(m, bot.id, names));
      },
    },

    send_message: {
      description:
        "Post a message to a channel. Over 2000 chars is split into several messages. @everyone/@here/role mentions are always disabled.",
      inputSchema: { channel_id: snowflake, content, allowed_mentions_user_ids: mentionIds },
      handler: async (a: { channel_id: string; content: string; allowed_mentions_user_ids?: string[] }) =>
        sendChunks(a.channel_id, a.content, allowedMentions(a.allowed_mentions_user_ids)),
    },

    reply_message: {
      description:
        "Reply to a message (over 2000 chars: the first part is the reply, the rest follow as normal messages). " +
        "With mention_author=false (default) the replied-to user is not pinged.",
      inputSchema: {
        channel_id: snowflake,
        message_id: snowflake.describe("Message to reply to"),
        content,
        mention_author: z.boolean().optional(),
        allowed_mentions_user_ids: mentionIds,
      },
      handler: async (a: {
        channel_id: string;
        message_id: string;
        content: string;
        mention_author?: boolean;
        allowed_mentions_user_ids?: string[];
      }) =>
        sendChunks(
          a.channel_id,
          a.content,
          { ...allowedMentions(a.allowed_mentions_user_ids), replied_user: a.mention_author ?? false },
          { message_id: a.message_id, channel_id: a.channel_id, fail_if_not_exists: true },
        ),
    },

    add_reaction: {
      description: "React to a message. emoji is a Unicode emoji or a custom emoji as name:id.",
      inputSchema: { channel_id: snowflake, message_id: snowflake, emoji: z.string().min(1) },
      handler: async (a: { channel_id: string; message_id: string; emoji: string }) => {
        // Also accept <:name:id> / <a:name:id>
        const emoji = a.emoji.trim().replace(/^<a?:([^:>]+):(\d+)>$/, "$1:$2");
        await discord.addReaction(a.channel_id, a.message_id, emoji);
        return { ok: true };
      },
    },

    send_typing: {
      description: 'Show "typing…" in a channel for about 10 seconds (or until the bot sends a message).',
      inputSchema: { channel_id: snowflake },
      handler: async ({ channel_id }: { channel_id: string }) => {
        await discord.typing(channel_id);
        return { ok: true };
      },
    },

    fetch_attachment: {
      description:
        "Download a message's attachments into the local media dir and return their file paths (open images with your file/image reader). " +
        "Over MCP, images are also returned inline.",
      inputSchema: {
        channel_id: snowflake,
        message_id: snowflake,
        attachment_id: snowflake.optional().describe("Only this attachment (default: all)"),
      },
      handler: async (a: { channel_id: string; message_id: string; attachment_id?: string }) => {
        // Re-fetch the message: attachment URLs are signed and expire
        const m = await discord.message(a.channel_id, a.message_id);
        const targets = a.attachment_id ? m.attachments.filter((x) => x.id === a.attachment_id) : m.attachments;
        if (targets.length === 0) throw new ToolError("NOT_FOUND", a.attachment_id ? "attachment not found" : "message has no attachments", 404);
        const files = [];
        for (const att of targets) {
          if (!att.url) continue;
          const d = await download(att.url, `attachments/${att.id}-${safeName(att.filename)}`, att.content_type);
          files.push({
            attachment_id: att.id,
            filename: att.filename,
            ...d,
            ...(att.width ? { width: att.width, height: att.height } : {}),
          });
        }
        return new WithImages({ message_id: m.id, files }, inlineImages(files));
      },
    },

    get_emoji: {
      description:
        "Get an emoji as an image file. Accepts a Unicode emoji (rendered with Twemoji, as Discord shows it) or a custom emoji " +
        "(<:name:id>, name:id or id, e.g. from reactions).",
      inputSchema: { emoji: z.string().min(1) },
      handler: async ({ emoji }: { emoji: string }) => {
        const e = parseEmoji(emoji);
        let d: Downloaded;
        let info: Record<string, unknown>;
        if (e.kind === "unicode") {
          const code = twemojiCode(e.emoji);
          try {
            d = await download(`${TWEMOJI_BASE}/${code}.png`, `emoji/unicode/${code}.png`);
          } catch (err) {
            if (err instanceof ToolError && err.code === "NOT_FOUND") throw new ToolError("NOT_FOUND", `no image for emoji: ${emoji}`, 404);
            throw err;
          }
          info = { kind: "unicode", emoji: e.emoji, codepoints: code };
        } else {
          d = await download(`${CDN_BASE}/emojis/${e.id}.png?size=128`, `emoji/custom/${e.id}.png`);
          info = { kind: "custom", id: e.id, name: e.name, animated: e.animated };
        }
        return new WithImages({ ...info, ...d }, inlineImages([d]));
      },
    },

    get_avatar: {
      description:
        "Get a user's avatar as an image file. Uses the server-specific avatar when set, else the global one, else Discord's default.",
      inputSchema: {
        user_id: snowflake,
        guild_id: snowflake.optional().describe("For the server-specific avatar. Defaults to the default guild"),
        size: z
          .number()
          .int()
          .refine((n) => n >= 16 && n <= 4096 && (n & (n - 1)) === 0, "must be a power of 2 from 16 to 4096")
          .optional()
          .describe("Power of 2 from 16 to 4096 (default 256)"),
      },
      handler: async (a: { user_id: string; guild_id?: string; size?: number }) => {
        const gid = a.guild_id ?? defaultGuildId;
        const size = a.size ?? 256;
        const user = await discord.user(a.user_id);
        const member = await discord.member(gid, a.user_id).catch((e) => {
          if (e instanceof ToolError && (e.code === "NOT_FOUND" || e.code === "FORBIDDEN")) return null;
          throw e;
        });
        let url: string;
        let rel: string;
        let source: "guild" | "user" | "default";
        if (member?.avatar) {
          source = "guild";
          url = `${CDN_BASE}/guilds/${gid}/users/${user.id}/avatars/${member.avatar}.png?size=${size}`;
          rel = `avatars/${user.id}-guild-${safeName(member.avatar)}-${size}.png`;
        } else if (user.avatar) {
          source = "user";
          url = `${CDN_BASE}/avatars/${user.id}/${user.avatar}.png?size=${size}`;
          rel = `avatars/${user.id}-${safeName(user.avatar)}-${size}.png`;
        } else {
          source = "default";
          const idx = (BigInt(user.id) >> 22n) % 6n;
          url = `${CDN_BASE}/embed/avatars/${idx}.png`;
          rel = `avatars/default-${idx}.png`;
        }
        const d = await download(url, rel);
        return new WithImages(
          {
            user_id: user.id,
            username: user.username,
            display_name: member?.nick || displayName(user),
            is_bot: !!user.bot,
            source,
            ...d,
          },
          inlineImages([d]),
        );
      },
    },

    wake_pending: {
      description:
        "Read wake events spooled by `listen` that have not been acknowledged yet (oldest first). Does not consume them; use wake_ack.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("Default 50, max 200") },
      handler: async ({ limit }: { limit?: number }) => {
        const lines = pendingLines();
        const n = limit ?? 50;
        return { events: lines.slice(0, n).map((l) => l.event), remaining: Math.max(0, lines.length - n) };
      },
    },

    wake_ack: {
      description: "Acknowledge wake events up to and including the given message_id (from wake_pending).",
      inputSchema: { up_to_message_id: snowflake },
      handler: async ({ up_to_message_id }: { up_to_message_id: string }) => {
        const lines = pendingLines();
        const idx = lines.findIndex((l) => l.event?.message_id === up_to_message_id);
        if (idx < 0) throw new ToolError("NOT_FOUND", "message_id is not among pending wake events", 404);
        writeCursor(lines[idx]!.end);
        return { acked: idx + 1, remaining: lines.length - idx - 1 };
      },
    },
  };
}
