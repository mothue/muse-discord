// Media download (attachments, emoji, avatars) into the working directory.
// CDN requests never carry the bot token.

import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { ToolError } from "./discord.ts";
import { resolveInsideCwd } from "./paths.ts";

export const CDN_BASE = process.env.DISCORD_CDN_BASE?.trim() || "https://cdn.discordapp.com";
// Discord renders Unicode emoji with Twemoji, so this matches what users see
export const TWEMOJI_BASE =
  process.env.TWEMOJI_BASE?.trim() || "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72";
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
/** Largest image returned inline over MCP */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
export const INLINE_IMAGE_TYPES = new Set(Object.values(MIME_BY_EXT));

export function mimeFor(path: string, fallback?: string | null): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? fallback ?? "application/octet-stream";
}

export interface Downloaded {
  /** Absolute path of the local file */
  path: string;
  bytes: number;
  content_type: string;
  cached: boolean;
}

let mediaDirCache: string | null = null;
function mediaDir(): string {
  mediaDirCache ??= resolveInsideCwd(process.env.DISCORD_MCP_MEDIA_DIR?.trim() || "./data/media", "DISCORD_MCP_MEDIA_DIR");
  return mediaDirCache;
}

/** Keep only safe filename characters. */
export function safeName(s: string): string {
  const cleaned = s.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "_").slice(0, 120);
  return cleaned || "file";
}

/** Download `url` to `<mediaDir>/<rel>` (immutable content: reuse if it already exists). */
export async function download(url: string, rel: string, contentTypeHint?: string | null): Promise<Downloaded> {
  const base = mediaDir();
  const dest = join(base, rel);
  if (relative(base, dest).startsWith("..")) throw new ToolError("INVALID_ARGUMENT", "invalid media path");
  if (existsSync(dest)) {
    return { path: dest, bytes: statSync(dest).size, content_type: mimeFor(dest, contentTypeHint), cached: true };
  }
  if (!/^https?:\/\//.test(url)) throw new ToolError("INVALID_ARGUMENT", "unsupported URL scheme");

  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": "muse-discord (media)" } });
  } catch (e) {
    throw new ToolError("NETWORK_ERROR", `download failed: ${(e as Error).message}`);
  }
  if (res.status === 404) throw new ToolError("NOT_FOUND", "media not found", 404);
  if (!res.ok) throw new ToolError("DISCORD_API_ERROR", `download failed: HTTP ${res.status}`, res.status);
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX_DOWNLOAD_BYTES) throw new ToolError("INVALID_ARGUMENT", `file too large (${len} bytes)`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) throw new ToolError("INVALID_ARGUMENT", `file too large (${buf.byteLength} bytes)`);

  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  writeFileSync(tmp, buf);
  renameSync(tmp, dest);
  const type = res.headers.get("content-type")?.split(";")[0]?.trim();
  return { path: dest, bytes: buf.byteLength, content_type: mimeFor(dest, contentTypeHint ?? type), cached: false };
}

// ---- emoji ----

export type ParsedEmoji =
  | { kind: "custom"; id: string; name: string | null; animated: boolean }
  | { kind: "unicode"; emoji: string };

/** Accepts `<:name:id>`, `<a:name:id>`, `name:id`, a bare id, or a Unicode emoji. */
export function parseEmoji(input: string): ParsedEmoji {
  const s = input.trim();
  let m = s.match(/^<(a?):([^:>]+):(\d+)>$/);
  if (m) return { kind: "custom", animated: m[1] === "a", name: m[2]!, id: m[3]! };
  m = s.match(/^:?([^:\s]+):(\d+)$/);
  if (m) return { kind: "custom", animated: false, name: m[1]!, id: m[2]! };
  if (/^\d{15,20}$/.test(s)) return { kind: "custom", animated: false, name: null, id: s };
  if (!s || /^[\x00-\x7f]+$/.test(s) || [...s].length > 16) throw new ToolError("INVALID_ARGUMENT", `not an emoji: ${input}`);
  return { kind: "unicode", emoji: s };
}

/** Twemoji file name: code points in hex joined by "-", dropping U+FE0F unless it is a ZWJ sequence. */
export function twemojiCode(emoji: string): string {
  const cps = [...emoji].map((c) => c.codePointAt(0)!);
  const zwj = cps.includes(0x200d);
  return cps
    .filter((c) => zwj || c !== 0xfe0f)
    .map((c) => c.toString(16))
    .join("-");
}

// ---- message splitting ----

const FENCE = /^```(\S*)/;

/**
 * Split text into chunks of at most `max` UTF-16 units. Prefers newline, then space boundaries,
 * never splits a surrogate pair, and closes/reopens ``` code blocks across chunks.
 */
export function splitMessage(text: string, max = 2000): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  let reopen = ""; // e.g. "```ts\n" when the previous chunk ended inside a code block

  while (rest.length > 0) {
    const room = max - reopen.length;
    let body: string;
    if (rest.length <= room) {
      body = rest;
      rest = "";
    } else {
      const budget = room - 4; // keep space for "\n```"
      const window = rest.slice(0, budget);
      let cut = window.lastIndexOf("\n");
      if (cut < budget * 0.5) cut = window.lastIndexOf(" ");
      if (cut < budget * 0.5) cut = budget;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--; // don't split a surrogate pair
      body = rest.slice(0, cut);
      rest = rest.slice(cut).replace(/^[\n ]/, "");
    }

    let chunk = reopen + body;
    // Track whether the chunk ends inside a fenced block
    let open: string | null = reopen ? reopen.slice(3, -1) : null;
    for (const line of body.split("\n")) {
      const f = line.match(FENCE);
      if (f) open = open === null ? f[1]! : null;
    }
    if (open !== null && rest.length > 0) {
      chunk += "\n```";
      reopen = "```" + open + "\n";
    } else {
      reopen = "";
    }
    if (chunk.trim()) chunks.push(chunk);
  }
  return chunks;
}
