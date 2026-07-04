import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

mkdirSync(dirname(config.paths.db), { recursive: true });

export const db = new DatabaseSync(config.paths.db);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

type Migration = { version: number; name: string; up: () => void };

const SCHEMA_VERSION = 1;
const MIGRATIONS: Migration[] = [];
let shuttingDown = false;

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
  CREATE INDEX IF NOT EXISTS notifications_ts_idx ON notifications(ts);

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
  CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log(ts);

  CREATE TABLE IF NOT EXISTS scheduler_state (
    tick_id TEXT PRIMARY KEY,
    last_run TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prewarm_cache (
    skill TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    verdict TEXT NOT NULL
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

  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chat_history_ts_idx ON chat_history(ts);

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

  CREATE TABLE IF NOT EXISTS schema_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

function applyMigrations(): void {
  const schemaRow = db
    .prepare("SELECT version FROM schema_meta WHERE id = 1")
    .get() as { version: number } | undefined;
  let current = schemaRow?.version ?? 0;

  if (!schemaRow) {
    db.prepare("INSERT INTO schema_meta (id, version, updated_at) VALUES (1, ?, ?)")
      .run(0, new Date().toISOString());
  }

  if (current > SCHEMA_VERSION) {
    console.warn(`[db] schema version ahead of code: ${current} > ${SCHEMA_VERSION}`);
    return;
  }

  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  if (pending.length > 0) {
    db.exec("BEGIN");
    try {
      for (const m of pending) {
        m.up();
        current = m.version;
        db.prepare("UPDATE schema_meta SET version = ?, updated_at = ? WHERE id = 1")
          .run(current, new Date().toISOString());
        console.log(`[db] migration applied: v${m.version} ${m.name}`);
      }
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch {}
      throw err;
    }
  }

  if (current < SCHEMA_VERSION) {
    db.prepare("UPDATE schema_meta SET version = ?, updated_at = ? WHERE id = 1")
      .run(SCHEMA_VERSION, new Date().toISOString());
  }
}

applyMigrations();

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
  // Galaxy Watch HRV stress signal (normalised 0-1, written by companion or /api/hrv).
  hrv_stress: "NaN",
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

export function recordNotification(source: string): void {
  db.prepare("INSERT INTO notifications (ts, source, cleared) VALUES (?, ?, 0)").run(
    new Date().toISOString(),
    source,
  );
}

export function setShuttingDown(state: boolean): void {
  shuttingDown = state;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function localDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function localDayBounds(d: Date): { start: string; end: string } {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

// ── Database maintenance ──────────────────────────────────────────────────────
// Called once per tick by the scheduler to keep the DB lean.
// Retention windows are generous enough that nothing useful is lost,
// but short enough that the file stays fast on-device (< 50 MB typical).
export function pruneCaches(now: Date = new Date()): {
  prewarm: number;
  events: number;
  audit: number;
  notifications: number;
} {
  const nowIso = now.toISOString();
  const twoHoursAgo   = new Date(now.getTime() - 2   * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30  * 24 * 60 * 60 * 1000).toISOString();
  const ninetyDaysAgo = new Date(now.getTime() - 90  * 24 * 60 * 60 * 1000).toISOString();

  // Prewarm cache: verdicts expire after 2 hours (prewarmed reasoning is stale past that).
  const prewarm = db
    .prepare("DELETE FROM prewarm_cache WHERE ts < ?")
    .run(twoHoursAgo).changes as number;

  // Events table: keep 30 days (used by TWIN learner for pattern detection).
  const events = db
    .prepare("DELETE FROM events WHERE ts < ?")
    .run(thirtyDaysAgo).changes as number;

  // Audit log: keep 90 days (longer for compliance / demo replay).
  const audit = db
    .prepare("DELETE FROM audit_log WHERE ts < ?")
    .run(ninetyDaysAgo).changes as number;

  // Notifications: keep 30 days.
  const notifications = db
    .prepare("DELETE FROM notifications WHERE ts < ?")
    .run(thirtyDaysAgo).changes as number;

  return { prewarm, events, audit, notifications };
}

