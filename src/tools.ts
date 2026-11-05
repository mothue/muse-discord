// Tool definitions shared by the MCP server and the one-shot CLI.

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

const MAX_UNREAD_PAGES = 10; // count at most 1000 unread messages per channel

export interface ToolDef {
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: any) => Promise<unknown>;
}

export interface Context {
  db: StateDB;
  discord: DiscordClient;
  defaultGuildId: string;
}

const snowflake = z.string().regex(/^\d{1,20}$/, "must be a snowflake (string of digits)");
const content = z.string().min(1).max(2000).describe("Message body (max 2000 chars)");
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

function formatMessage(m: DMessage, botId: string) {
  return {
    id: m.id,
    author_id: m.author.id,
    author_name: m.author.global_name || m.author.username,
    author_is_bot: !!m.author.bot,
    content: m.content,
    timestamp: new Date(m.timestamp).toISOString(),
    reply_to_message_id: m.type === 19 ? (m.message_reference?.message_id ?? null) : null,
    mentions_bot: m.mentions.some((u) => u.id === botId),
    attachments: m.attachments.map((a) => ({ filename: a.filename, content_type: a.content_type ?? null })),
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

function sent(m: DMessage) {
  return { message_id: m.id, channel_id: m.channel_id, timestamp: new Date(m.timestamp).toISOString() };
}

const typeName = (t: number) => ChannelTypeName[t] ?? String(t);

export function createTools({ db, discord, defaultGuildId }: Context): Record<string, ToolDef> {
  let cachedMe: DUser | null = null;
  async function me(): Promise<DUser> {
    if (cachedMe) return cachedMe;
    cachedMe = await discord.me();
    db.setMeta("bot_user_id", cachedMe.id);
    return cachedMe;
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
    return { visible, excluded };
  }

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

        const { visible, excluded } = await resolveChannels(gid, bot.id);
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
            messages: collected.slice(0, limit).map((m) => formatMessage(m, bot.id)),
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
        const msgs = await discord.messages(a.channel_id, { limit: a.limit ?? 50, before: a.before, after: a.after });
        return msgs.sort(byIdAsc).map((m) => formatMessage(m, bot.id));
      },
    },

    send_message: {
      description: "Post a message to a channel. @everyone/@here/role mentions are always disabled.",
      inputSchema: { channel_id: snowflake, content, allowed_mentions_user_ids: mentionIds },
      handler: async (a: { channel_id: string; content: string; allowed_mentions_user_ids?: string[] }) =>
        sent(
          await discord.createMessage(a.channel_id, {
            content: a.content,
            allowed_mentions: allowedMentions(a.allowed_mentions_user_ids),
          }),
        ),
    },

    reply_message: {
      description: "Reply to a message. With mention_author=false (default) the replied-to user is not pinged.",
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
        sent(
          await discord.createMessage(a.channel_id, {
            content: a.content,
            message_reference: { message_id: a.message_id, channel_id: a.channel_id, fail_if_not_exists: true },
            allowed_mentions: { ...allowedMentions(a.allowed_mentions_user_ids), replied_user: a.mention_author ?? false },
          }),
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
  };
}
