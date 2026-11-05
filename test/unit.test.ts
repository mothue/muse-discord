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
