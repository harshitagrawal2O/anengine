import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

mkdirSync(dirname(config.paths.db), { recursive: true });

export const db = new DatabaseSync(config.paths.db);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_ts_idx ON events(ts);
  CREATE INDEX IF NOT EXISTS events_kind_idx ON events(kind);

  CREATE TABLE IF NOT EXISTS calendar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_ts TEXT NOT NULL,
    end_ts TEXT NOT NULL,
    title TEXT NOT NULL,
    location TEXT
  );
  CREATE INDEX IF NOT EXISTS calendar_start_idx ON calendar(start_ts);

  CREATE TABLE IF NOT EXISTS sleep (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    duration_min INTEGER NOT NULL,
    quality REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    hour INTEGER NOT NULL,
    count INTEGER NOT NULL,
    UNIQUE(date, hour)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    source TEXT NOT NULL,
    cleared INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS skill_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    skill TEXT NOT NULL,
    accepted INTEGER,
    dismissed INTEGER,
    payload TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scheduler_state (
    tick_id TEXT PRIMARY KEY,
    last_run TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS quiet_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_ts TEXT NOT NULL,
    end_ts TEXT NOT NULL,
    reason TEXT
  );
  CREATE INDEX IF NOT EXISTS quiet_blocks_end_idx ON quiet_blocks(end_ts);

  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    body TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS timers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    end_ts TEXT NOT NULL,
    fired INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// Single source of truth for setting keys + defaults. Exported so server.ts
// can use the same allowlist for POST /api/settings and the same defaults for GET.
export const DEFAULT_SETTINGS: Record<string, string> = {
  user_name: "",
  preferred_lang: "en",
  preferred_voice: "",
  quiet_start: "22:00",
  quiet_end: "06:30",
  onboarded: "0",
  city: "Seoul",
};
export const ALLOWED_SETTING_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));

export function getSetting(key: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? DEFAULT_SETTINGS[key] ?? "";
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value, new Date().toISOString());
}

export function allSettings(): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{
    key: string;
    value: string;
  }>;
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function isInQuietBlock(now: Date = new Date()): { active: boolean; until?: string; reason?: string } {
  const row = db
    .prepare(
      "SELECT end_ts, reason FROM quiet_blocks WHERE start_ts <= ? AND end_ts > ? ORDER BY end_ts DESC LIMIT 1",
    )
    .get(now.toISOString(), now.toISOString()) as { end_ts: string; reason: string } | undefined;
  return row ? { active: true, until: row.end_ts, reason: row.reason } : { active: false };
}

export function recordEvent(kind: string, payload: unknown): void {
  db.prepare("INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)").run(
    new Date().toISOString(),
    kind,
    JSON.stringify(payload),
  );
}
