import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA_VERSION = "1";

export interface ReadState {
  channel_id: string;
  guild_id: string | null;
  last_read_message_id: string;
  updated_at: string;
}

export class StateDB {
  private db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS read_state (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT,
        last_read_message_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.setMeta("schema_version", SCHEMA_VERSION);
  }

  getMeta(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(key);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  getReadState(channelId: string): ReadState | null {
    return (
      this.db
        .query<ReadState, [string]>("SELECT * FROM read_state WHERE channel_id = ?")
        .get(channelId) ?? null
    );
  }

  getAllReadStates(): Map<string, ReadState> {
    const rows = this.db.query<ReadState, []>("SELECT * FROM read_state").all();
    return new Map(rows.map((r) => [r.channel_id, r]));
  }

  /**
   * Advance the watermark. If the given id is older than the current one, keep the current one (never move backwards).
   * Returns the resulting watermark.
   */
  advance(channelId: string, guildId: string | null, messageId: string): string {
    const tx = this.db.transaction(() => {
      const current = this.getReadState(channelId);
      if (current && BigInt(current.last_read_message_id) >= BigInt(messageId)) {
        return current.last_read_message_id;
      }
      this.db
        .query(
          `INSERT INTO read_state (channel_id, guild_id, last_read_message_id, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(channel_id) DO UPDATE SET
             guild_id = COALESCE(excluded.guild_id, read_state.guild_id),
             last_read_message_id = excluded.last_read_message_id,
             updated_at = excluded.updated_at`,
        )
        .run(channelId, guildId, messageId, new Date().toISOString());
      return messageId;
    });
    return tx();
  }

  close(): void {
    this.db.close();
  }
}
