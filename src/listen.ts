// `listen` mode: stay connected to the Discord Gateway and append trigger events to a JSONL spool.
// Never touches the SQLite watermarks. Operational logs go to stdout as JSON Lines.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DiscordClient, ToolError } from "./discord.ts";
import { resolveInsideCwd } from "./paths.ts";

const DEFAULT_BOT_USER_ID = "1567841740222631946";
const DEFAULT_GUILD_ID = "1513823779124416582";
const DEFAULT_AGENT_ROLE_ID = "1567703605514084353";
const DEFAULT_WAKE_CHANNEL_IDS = "1567704255312429208";
const FALLBACK_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

// GUILDS (1<<0) | GUILD_MESSAGES (1<<9) | MESSAGE_CONTENT (1<<15)
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 15); // 33281
const MAX_CONTENT_CHARS = 500;
const DEDUPE_SIZE = 1000;
const MAX_BACKOFF_SEC = 60;
/** Close code we use ourselves: anything except 1000/1001 keeps the session resumable. */
const RESUMABLE_CLOSE = 4000;
/** Session can't be resumed: start over with Identify. */
const SESSION_INVALID_CODES = new Set([4007, 4009]);
/** Fatal: reconnecting won't help (bad token, bad intents, ...). */
const FATAL_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const DM_CHANNEL_TYPES = new Set([1, 3]);

interface PersistedState {
  session_id: string | null;
  seq: number | null;
  resume_gateway_url: string | null;
  bot_user_id: string | null;
  recent_message_ids: string[];
}

interface GatewayPayload {
  op: number;
  d?: any;
  s?: number | null;
  t?: string | null;
}

interface MessageCreate {
  id: string;
  channel_id: string;
  guild_id?: string;
  channel_type?: number;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  content: string;
  timestamp: string;
  mentions?: { id: string }[];
  mention_roles?: string[];
}

export type TriggerReason = "mention" | "role_mention" | "watched_channel";

export interface TriggerConfig {
  guildId: string;
  botUserId: string;
  agentRoleId: string;
  wakeChannelIds: Set<string>;
}

/** Decide whether a MESSAGE_CREATE is a trigger. Returns null if it should be ignored. */
export function triggerReason(m: MessageCreate, cfg: TriggerConfig): TriggerReason | null {
  if (!m.guild_id || m.guild_id !== cfg.guildId) return null; // DMs have no guild_id
  if (m.channel_type !== undefined && DM_CHANNEL_TYPES.has(m.channel_type)) return null;
  if (m.author?.id === cfg.botUserId) return null; // only our own messages; other bots are kept
  const content = m.content ?? "";
  if (
    (m.mentions ?? []).some((u) => u.id === cfg.botUserId) ||
    content.includes(`<@${cfg.botUserId}>`) ||
    content.includes(`<@!${cfg.botUserId}>`)
  )
    return "mention";
  if ((m.mention_roles ?? []).includes(cfg.agentRoleId)) return "role_mention";
  if (cfg.wakeChannelIds.has(m.channel_id)) return "watched_channel";
  return null;
}

function truncateChars(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length > n ? chars.slice(0, n).join("") : s;
}

function withQuery(url: string): string {
  const u = new URL(url);
  u.searchParams.set("v", "10");
  u.searchParams.set("encoding", "json");
  return u.toString();
}

export async function runListen(): Promise<never> {
  const token = process.env.DISCORD_BOT_TOKEN?.trim() || "";
  const redact = (s: string) => (token ? s.split(token).join("[REDACTED]") : s);

  const log = (event: string, fields: Record<string, unknown> = {}) => {
    process.stdout.write(redact(JSON.stringify({ ts: new Date().toISOString(), event, ...fields })) + "\n");
  };
  const errMsg = (e: unknown) => redact(e instanceof Error ? e.message : String(e));

  if (!token) {
    log("error", { code: "MISSING_TOKEN", message: "DISCORD_BOT_TOKEN is not set" });
    process.exit(1);
  }

  const spoolPath = resolveInsideCwd(process.env.WAKE_SPOOL_PATH?.trim() || "./data/wake-events.jsonl", "WAKE_SPOOL_PATH");
  const statePath = resolveInsideCwd(process.env.LISTEN_STATE_PATH?.trim() || "./data/listen-state.json", "LISTEN_STATE_PATH");
  mkdirSync(dirname(spoolPath), { recursive: true });
  mkdirSync(dirname(statePath), { recursive: true });

  const cfg: TriggerConfig = {
    guildId: process.env.DISCORD_GUILD_ID?.trim() || DEFAULT_GUILD_ID,
    botUserId: DEFAULT_BOT_USER_ID,
    agentRoleId: process.env.AGENT_ROLE_ID?.trim() || DEFAULT_AGENT_ROLE_ID,
    wakeChannelIds: new Set(
      (process.env.WAKE_CHANNEL_IDS ?? DEFAULT_WAKE_CHANNEL_IDS)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  };

  // ---- persisted state (session for Resume + dedupe ring) ----
  let state: PersistedState = { session_id: null, seq: null, resume_gateway_url: null, bot_user_id: null, recent_message_ids: [] };
  if (existsSync(statePath)) {
    try {
      state = { ...state, ...JSON.parse(readFileSync(statePath, "utf8")) };
    } catch (e) {
      log("error", { message: `ignoring unreadable state file: ${errMsg(e)}` });
    }
  }
  if (state.bot_user_id) cfg.botUserId = state.bot_user_id;
  const seen = new Set(state.recent_message_ids);

  const saveState = () => {
    state.recent_message_ids = [...seen];
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, statePath);
  };
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const saveSoon = () => {
    saveTimer ??= setTimeout(() => {
      saveTimer = null;
      saveState();
    }, 500);
  };
  const remember = (id: string) => {
    seen.add(id);
    while (seen.size > DEDUPE_SIZE) seen.delete(seen.values().next().value!);
  };

  // ---- gateway URL ----
  let gatewayUrl = FALLBACK_GATEWAY_URL;
  try {
    const r = await new DiscordClient(token).request<{ url: string }>("GET", "/gateway/bot");
    gatewayUrl = withQuery(r.url);
  } catch (e) {
    if (e instanceof ToolError && (e.code === "UNAUTHORIZED" || e.code === "MISSING_TOKEN")) {
      log("error", { code: e.code, message: errMsg(e) });
      process.exit(1);
    }
    log("error", { message: `GET /gateway/bot failed, using fallback: ${errMsg(e)}` });
  }

  // ---- connection ----
  let ws: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let acked = true;
  let backoff = 1;
  let stopping = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const canResume = () => !!(state.session_id && state.seq !== null && state.resume_gateway_url);
  const clearSession = () => {
    state.session_id = null;
    state.seq = null;
    state.resume_gateway_url = null;
    saveSoon();
  };
  const send = (p: GatewayPayload) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(p));
  };
  const sendHeartbeat = () => send({ op: 1, d: state.seq });

  const stopHeartbeat = () => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  };

  /** Drop the current socket and schedule a reconnect with exponential backoff. */
  const drop = (reason: string) => {
    stopHeartbeat();
    const old = ws;
    ws = null;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try {
        old.close(RESUMABLE_CLOSE);
      } catch {}
    }
    if (stopping || reconnectTimer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, MAX_BACKOFF_SEC);
    log("reconnecting", { reason, in_seconds: delay, resume: canResume() });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay * 1000);
  };

  const startHeartbeat = (interval: number) => {
    stopHeartbeat();
    acked = true;
    const beat = () => {
      if (!acked) return drop("heartbeat_ack_timeout"); // zombie connection
      acked = false;
      sendHeartbeat();
      heartbeatTimer = setTimeout(beat, interval);
    };
    heartbeatTimer = setTimeout(beat, interval * Math.random());
  };

  const onDispatch = (t: string, d: any) => {
    if (t === "READY") {
      state.session_id = d.session_id;
      state.resume_gateway_url = withQuery(d.resume_gateway_url);
      state.bot_user_id = d.user.id;
      cfg.botUserId = d.user.id;
      backoff = 1;
      saveState();
      log("ready", { username: d.user.username, id: d.user.id, session_id: d.session_id });
      return;
    }
    if (t === "RESUMED") {
      backoff = 1;
      log("resumed", { seq: state.seq });
      return;
    }
    if (t !== "MESSAGE_CREATE") return;

    const m = d as MessageCreate;
    const reason = triggerReason(m, cfg);
    if (!reason || seen.has(m.id)) return;
    const line = JSON.stringify({
      reason,
      message_id: m.id,
      channel_id: m.channel_id,
      guild_id: m.guild_id,
      author_id: m.author.id,
      author_name: m.author.global_name || m.author.username,
      content: redact(truncateChars(m.content ?? "", MAX_CONTENT_CHARS)),
      timestamp: m.timestamp,
      detected_at: new Date().toISOString(),
    });
    appendFileSync(spoolPath, line + "\n"); // one write per line (O_APPEND)
    remember(m.id);
    saveState(); // spool first, then dedupe state: a crash in between duplicates rather than loses
    log("trigger", { message_id: m.id, channel_id: m.channel_id });
  };

  const onPayload = (p: GatewayPayload) => {
    if (typeof p.s === "number") {
      state.seq = p.s;
      saveSoon();
    }
    switch (p.op) {
      case 10: // Hello
        startHeartbeat(p.d.heartbeat_interval);
        if (canResume()) {
          send({ op: 6, d: { token, session_id: state.session_id, seq: state.seq } });
        } else {
          send({
            op: 2,
            d: { token, intents: INTENTS, properties: { os: process.platform, browser: "muse-discord", device: "muse-discord" } },
          });
        }
        return;
      case 11: // Heartbeat ACK
        acked = true;
        return;
      case 1: // Heartbeat request
        sendHeartbeat();
        return;
      case 7: // Reconnect
        return drop("reconnect_requested");
      case 9: // Invalid Session
        if (!p.d) clearSession();
        return drop(p.d ? "invalid_session_resumable" : "invalid_session");
      case 0:
        return onDispatch(p.t ?? "", p.d);
    }
  };

  const connect = () => {
    const resuming = canResume();
    const url = resuming ? state.resume_gateway_url! : gatewayUrl;
    log("connecting", { url, resume: resuming });
    const sock = new WebSocket(url);
    ws = sock;
    sock.onmessage = (ev) => {
      try {
        onPayload(JSON.parse(String(ev.data)));
      } catch (e) {
        log("error", { message: `failed to handle payload: ${errMsg(e)}` });
      }
    };
    sock.onerror = () => log("error", { message: "websocket error" });
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      if (FATAL_CODES.has(ev.code)) {
        log("error", { message: "fatal gateway close", close_code: ev.code, reason: redact(ev.reason ?? "") });
        stopping = true;
        stopHeartbeat();
        saveState();
        process.exit(1);
      }
      if (SESSION_INVALID_CODES.has(ev.code)) clearSession();
      drop(`closed_${ev.code}`);
    };
  };

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (saveTimer) clearTimeout(saveTimer);
    stopHeartbeat();
    const old = ws;
    ws = null;
    try {
      old?.close(RESUMABLE_CLOSE); // keep the session resumable for the next start
    } catch {}
    saveState();
    log("stopped", { signal });
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => log("error", { message: `uncaught: ${errMsg(e)}` }));
  process.on("unhandledRejection", (e) => log("error", { message: `unhandled: ${errMsg(e)}` }));

  connect();
  return new Promise<never>(() => {});
}
