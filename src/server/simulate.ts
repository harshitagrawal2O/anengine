import express from "express";
import { db, localDateString, localDayBounds, recordEvent } from "../db.js";
import { append as auditAppend } from "../audit/log.js";
import { computeScore } from "../score/compute.js";

const router = express.Router();

// ── Helper: atomic multi-statement execution using WAL journal mode ───────────
// Node's DatabaseSync doesn't have .transaction() — use explicit BEGIN/COMMIT.
// ROLLBACK on any error to keep the DB consistent.
function runAtomic(fn: () => void): void {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * POST /api/simulate/reset
 * Clear all telemetry (steps, HRV, skill_runs, events, calendar, timers)
 * but preserve settings. Useful before a fresh demo session.
 */
router.post("/reset", (_req, res) => {
  try {
    runAtomic(() => {
      db.exec("DELETE FROM steps");
      db.exec("DELETE FROM skill_runs");
      // NOTE: audit_log is intentionally NOT cleared — it is an append-only,
      // HMAC-chained tamper-evident record. Wiping it would break the chain's
      // whole purpose. The reset itself is recorded as an audit entry below.
      db.exec("DELETE FROM events");
      db.exec("DELETE FROM calendar");
      db.exec("DELETE FROM timers");
      db.exec("DELETE FROM quiet_blocks");
      db.exec("DELETE FROM prewarm_cache");
      // Keep settings — resetting HRV to NaN so the watch channel re-establishes cleanly.
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
      ).run("hrv_stress", "NaN", new Date().toISOString());
    });
    auditAppend("sim_reset", {});
    res.json({ ok: true, message: "Telemetry cleared (audit log preserved)." });
  } catch (err) {
    res.status(500).json({ error: "Reset failed", detail: (err as Error).message });
  }
});

/**
 * POST /api/simulate/scenario/busy
 * Adds 6 meetings for today, sets high HRV stress, injects low step count.
 * Demonstrates AURA under pressure — readiness score drops, gate fires more.
 */
router.post("/scenario/busy", (_req, res) => {
  const now = new Date();
  const date = localDateString(now);
  const bounds = localDayBounds(now);

  try {
    runAtomic(() => {
      db.prepare("DELETE FROM calendar WHERE start_ts >= ? AND start_ts <= ?").run(
        bounds.start,
        bounds.end,
      );

      const meetings: [string, number][] = [
        ["Team Sync",        0],
        ["Investor Pitch",  60],
        ["Design Review",  120],
        ["Lunch (Working)", 180],
        ["Product Strategy", 240],
        ["Sprint Planning", 300],
      ];

      const insertEvent = db.prepare(
        "INSERT INTO calendar (start_ts, end_ts, title, location) VALUES (?, ?, ?, ?)",
      );
      for (const [title, offsetMin] of meetings) {
        const start = new Date(now.getTime() + offsetMin * 60000);
        const end   = new Date(start.getTime() + 30 * 60000);
        insertEvent.run(start.toISOString(), end.toISOString(), title, "Virtual");
      }

      // High HRV stress
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
      ).run("hrv_stress", "0.85", now.toISOString());

      // Very low steps today — only 1 partial hour recorded
      db.prepare("DELETE FROM steps WHERE date = ?").run(date);
      const prevHour = Math.max(0, now.getHours() - 1);
      db.prepare("INSERT OR IGNORE INTO steps (date, hour, count) VALUES (?, ?, ?)").run(
        date, prevHour, 120,
      );
    });

    const score = computeScore(now);
    res.json({ ok: true, scenario: "busy_monday", readiness: score.total });
  } catch (err) {
    res.status(500).json({ error: "Scenario failed", detail: (err as Error).message });
  }
});

/**
 * POST /api/simulate/scenario/relaxed
 * No meetings, high steps, low stress.
 * Demonstrates AURA staying quiet — readiness is high, gate suppresses noise.
 */
router.post("/scenario/relaxed", (_req, res) => {
  const now = new Date();
  const date = localDateString(now);
  const bounds = localDayBounds(now);

  try {
    runAtomic(() => {
      db.prepare("DELETE FROM calendar WHERE start_ts >= ? AND start_ts <= ?").run(
        bounds.start,
        bounds.end,
      );
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
      ).run("hrv_stress", "0.15", now.toISOString());

      db.prepare("DELETE FROM steps WHERE date = ?").run(date);
      const insertStep = db.prepare(
        "INSERT OR IGNORE INTO steps (date, hour, count) VALUES (?, ?, ?)",
      );
      const currentHour = now.getHours();
      for (let h = 8; h <= currentHour; h++) {
        insertStep.run(date, h, 800 + Math.floor(Math.random() * 400));
      }
    });

    const score = computeScore(now);
    res.json({ ok: true, scenario: "relaxed_weekend", readiness: score.total });
  } catch (err) {
    res.status(500).json({ error: "Scenario failed", detail: (err as Error).message });
  }
});

/**
 * POST /api/simulate/steps
 * Body: { count?: number, hour?: number, date?: string }
 * Inject a step count for a specific hour. Defaults to current hour + 500 steps.
 */
router.post("/steps", (req, res) => {
  const now  = new Date();
  const d    = typeof req.body?.date  === "string" ? req.body.date  : localDateString(now);
  const h    = typeof req.body?.hour  === "number" ? req.body.hour  : now.getHours();
  const c    = typeof req.body?.count === "number" ? Math.max(0, Math.floor(req.body.count)) : 500;

  if (h < 0 || h > 23) {
    res.status(400).json({ error: "hour must be 0-23" });
    return;
  }

  try {
    // Use INSERT OR REPLACE so repeated calls accumulate (useful for incremental simulation).
    db.prepare(
      "INSERT INTO steps (date, hour, count) VALUES (?, ?, ?) ON CONFLICT(date, hour) DO UPDATE SET count = count + excluded.count",
    ).run(d, h, c);
    recordEvent("sim_steps", { date: d, hour: h, count: c });
    res.json({ ok: true, added: { date: d, hour: h, count: c } });
  } catch (err) {
    res.status(500).json({ error: "Step injection failed", detail: (err as Error).message });
  }
});

/**
 * POST /api/simulate/hrv
 * Body: { stress: number }  (0.0 = fully relaxed, 1.0 = max stressed)
 * Directly writes the normalised stress score, bypassing the RMSSD conversion.
 */
router.post("/hrv", (req, res) => {
  const raw = req.body?.stress;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    res.status(400).json({ error: "stress must be a finite number between 0 and 1" });
    return;
  }
  const val = Math.max(0, Math.min(1, raw));
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
  ).run("hrv_stress", String(val), new Date().toISOString());
  recordEvent("sim_hrv", { stress: val });
  res.json({ ok: true, hrv_stress: val });
});

export default router;
