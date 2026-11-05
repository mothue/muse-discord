import { describe, expect, test } from "bun:test";
import { StateDB } from "../src/db.ts";
import { Permissions, basePermissions, channelPermissions, snowflakeFromTime, type DGuild } from "../src/discord.ts";

describe("StateDB", () => {
  test("watermark uses BigInt comparison and never moves backwards", () => {
    const db = new StateDB(":memory:");
    // ids that Number cannot distinguish
    const a = "1513823779124416582";
    const b = "1513823779124416583";
    expect(db.advance("c", "g", b)).toBe(b);
    expect(db.advance("c", "g", a)).toBe(b);
    // compare numerically across lengths (string compare would say "9" > "10...")
    expect(db.advance("c", "g", "99999999999999999")).toBe(b);
    expect(db.getReadState("c")!.last_read_message_id).toBe(b);
    expect(db.getMeta("schema_version")).toBe("1");
  });
});

describe("permissions", () => {
  const guild: DGuild = {
    id: "1",
    name: "g",
    owner_id: "99",
    roles: [
      { id: "1", permissions: Permissions.VIEW_CHANNEL.toString() },
      { id: "2", permissions: Permissions.ADMINISTRATOR.toString() },
    ],
  };
  test("member overwrite overrides @everyone deny", () => {
    const member = { roles: [] };
    const base = basePermissions(guild, member, "5");
    const ch = {
      id: "10",
      type: 0,
      permission_overwrites: [
        { id: "1", type: 0 as const, allow: "0", deny: Permissions.VIEW_CHANNEL.toString() },
        { id: "5", type: 1 as const, allow: Permissions.VIEW_CHANNEL.toString(), deny: "0" },
      ],
    };
    expect(channelPermissions(base, ch, "1", member, "5") & Permissions.VIEW_CHANNEL).toBeTruthy();
    expect(channelPermissions(base, { ...ch, permission_overwrites: ch.permission_overwrites.slice(0, 1) }, "1", member, "5") & Permissions.VIEW_CHANNEL).toBeFalsy();
  });
  test("ADMINISTRATOR ignores overwrites", () => {
    const member = { roles: ["2"] };
    const base = basePermissions(guild, member, "5");
    const ch = { id: "10", type: 0, permission_overwrites: [{ id: "1", type: 0 as const, allow: "0", deny: Permissions.VIEW_CHANNEL.toString() }] };
    expect(channelPermissions(base, ch, "1", member, "5") & Permissions.VIEW_CHANNEL).toBeTruthy();
  });
});

test("snowflakeFromTime uses the Discord epoch", () => {
  expect(snowflakeFromTime(1420070400000)).toBe("0");
  expect(snowflakeFromTime(1420070400001)).toBe((1n << 22n).toString());
});

import { parseEmoji, splitMessage, twemojiCode } from "../src/media.ts";

describe("splitMessage", () => {
  test("short text is untouched", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });
  test("never exceeds the limit and keeps all text (hard cut without spaces)", () => {
    const s = "a".repeat(5000);
    const parts = splitMessage(s);
    expect(parts.every((p) => p.length <= 2000)).toBe(true);
    expect(parts.join("")).toBe(s);
  });
  test("does not split surrogate pairs", () => {
    const s = "😀".repeat(1500); // 3000 UTF-16 units
    const parts = splitMessage(s);
    expect(parts.every((p) => p.length <= 2000 && !/[\ud800-\udbff]$/.test(p))).toBe(true);
    expect(parts.join("")).toBe(s);
  });
  test("closes and reopens code fences across chunks", () => {
    const code = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const parts = splitMessage("intro\n```ts\n" + code + "\n```\noutro");
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(2000);
      expect((p.match(/^```/gm) ?? []).length % 2).toBe(0); // balanced in every chunk
    }
    expect(parts[1]!.startsWith("```ts\n")).toBe(true);
  });
});

describe("emoji parsing", () => {
  test("twemoji code points", () => {
    expect(twemojiCode("👍")).toBe("1f44d");
    expect(twemojiCode("❤️")).toBe("2764");
    expect(twemojiCode("👨‍💻")).toBe("1f468-200d-1f4bb");
    expect(twemojiCode("🇯🇵")).toBe("1f1ef-1f1f5");
  });
  test("custom emoji forms", () => {
    expect(parseEmoji("<a:dance:123456789012345678>")).toEqual({ kind: "custom", animated: true, name: "dance", id: "123456789012345678" });
    expect(parseEmoji(":party:123")).toEqual({ kind: "custom", animated: false, name: "party", id: "123" });
    expect(() => parseEmoji("abc")).toThrow();
  });
});
