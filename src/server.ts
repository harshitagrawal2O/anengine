import express from "express";
import { config } from "./config.js";
import { checkOllamaHealth, type OllamaHealth } from "./gateway/ollama.js";
import { computeScore } from "./score/compute.js";
import { db, DEFAULT_SETTINGS, ALLOWED_SETTING_KEYS } from "./db.js";
import { tail as auditTail, verifyChain, append as auditAppend } from "./audit/log.js";
import { runTickOnce } from "./scheduler.js";
import * as morningBrief from "./skills/morning_brief/index.js";
import * as commuteGuardian from "./skills/commute_guardian/index.js";
import { loadSoul } from "./soul.js";
import { loadTwin } from "./twin.js";
import { learn, learnAndPersist } from "./twin/learn.js";
import { isVoiceEnabled, setVoiceEnabled, speak } from "./gateway/voice.js";
import { route as routeIntent } from "./pi-engine/intent.js";
import { isInQuietBlock } from "./db.js";
import { isLang, type Lang } from "./i18n.js";
import { startDemo, stopDemo, getDemoStatus } from "./demo/runner.js";
import { shouldIntervene, type GateContext, type ProposedAction } from "./pi-engine/gate.js";

// ── Ollama health cache (15-second TTL so the dashboard poll doesn't hammer Ollama) ──
let _healthCache: { ollama: "online" | "offline"; model: string | null; last_check: string } = {
  ollama: "offline",
  model: null,
  last_check: new Date().toISOString(),
};
let _healthCacheExpires = 0;

async function getCachedHealth() {
  if (Date.now() < _healthCacheExpires) return _healthCache;
  const h: OllamaHealth = await checkOllamaHealth();
  _healthCache = {
    ollama: h.online ? "online" : "offline",
    model: h.model,
    last_check: h.checked_at,
  };
  _healthCacheExpires = Date.now() + 15_000;
  return _healthCache;
}

// Wrap async route handlers so thrown errors / rejected promises route to
// Express's error pipeline instead of crashing the process. Without this, any
// throw inside an async handler becomes an unhandled rejection.
type AsyncHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>;
const wrap = (fn: AsyncHandler): express.RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

// Strict positive-integer parse for path params. Accepts "1".."9007199254740991";
// rejects "abc", "-1", "1.5", "" and overflow.
function parseId(s: unknown): number | null {
  if (typeof s !== "string" || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}

function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 10 || s.length > 40) return false;
  const t = Date.parse(s);
  return Number.isFinite(t);
}

export function createServer(): express.Express {
  const app = express();
  // Cap request bodies — prevents trivial memory exhaustion.
  app.use(express.json({ limit: "256kb" }));
  app.use(express.static(config.paths.publicDir));

  // Pretty URLs: / is the landing page, /simple is the PWA, /dev is the dev dashboard.
  app.get("/", (_req, res) => {
    res.sendFile("landing.html", { root: config.paths.publicDir });
  });
  app.get("/simple", (_req, res) => {
    res.sendFile("simple.html", { root: config.paths.publicDir });
  });
  app.get("/dev", (_req, res) => {
    res.sendFile("dev.html", { root: config.paths.publicDir });
  });
  app.get("/activity", (_req, res) => {
    res.sendFile("activity.html", { root: config.paths.publicDir });
  });

  app.get("/health", wrap(async (_req, res) => {
    res.json(await getCachedHealth());
  }));

  app.get("/api/score", (_req, res) => {
    res.json(computeScore());
  });

  app.get("/api/calendar", (_req, res) => {
    const rows = db
      .prepare(
        "SELECT id, start_ts, end_ts, title, location FROM calendar ORDER BY start_ts ASC LIMIT 50",
      )
      .all();
    res.json(rows);
  });

  app.post("/api/calendar", (req, res) => {
    const { start_ts, end_ts, title, location } = req.body ?? {};
    if (!isIsoDate(start_ts) || !isIsoDate(end_ts) || typeof title !== "string" || !title.trim()) {
      res.status(400).json({ error: "start_ts, end_ts (ISO 8601), title (non-empty string) required" });
      return;
    }
    if (Date.parse(start_ts) >= Date.parse(end_ts)) {
      res.status(400).json({ error: "start_ts must be before end_ts" });
      return;
    }
    if (location !== undefined && location !== null && typeof location !== "string") {
      res.status(400).json({ error: "location must be a string when provided" });
      return;
    }
    db.prepare(
      "INSERT INTO calendar (start_ts, end_ts, title, location) VALUES (?, ?, ?, ?)",
    ).run(start_ts, end_ts, title.trim(), location ?? null);
    res.json({ ok: true });
  });

  app.delete("/api/calendar/:id", (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "id must be a positive integer" });
      return;
    }
    db.prepare("DELETE FROM calendar WHERE id = ?").run(id);
    res.json({ ok: true });
  });

  app.get("/api/audit", (_req, res) => {
    res.json({ verified: verifyChain(), entries: auditTail(50) });
  });

  app.get("/api/twin", (_req, res) => {
    res.json(loadTwin());
  });

  app.get("/api/soul", (_req, res) => {
    res.json(loadSoul());
  });

  app.post("/api/tick", wrap(async (_req, res) => {
    await runTickOnce();
    res.json({ ok: true });
  }));

  app.post("/api/run/morning_brief", wrap(async (req, res) => {
    const dry_run = !!req.body?.dry_run;
    const lang: Lang = isLang(req.body?.lang) ? req.body.lang : "en";
    const result = await morningBrief.run({ dry_run, lang });
    res.json(result);
  }));

  app.post("/api/run/commute_guardian", wrap(async (req, res) => {
    const dry_run = !!req.body?.dry_run;
    const lang: Lang = isLang(req.body?.lang) ? req.body.lang : "en";
    const result = await commuteGuardian.run({ dry_run, lang });
    res.json(result);
  }));

  app.get("/api/skill_runs", (_req, res) => {
    const rows = db
      .prepare(
        "SELECT id, ts, skill, accepted, dismissed, payload FROM skill_runs ORDER BY id DESC LIMIT 30",
      )
      .all();
    res.json(rows);
  });

  app.post("/api/skill_runs/:id/feedback", (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "id must be a positive integer" });
      return;
    }
    const action = req.body?.action;
    if (action !== "accept" && action !== "dismiss") {
      res.status(400).json({ error: "action must be accept or dismiss" });
      return;
    }
    const accepted = action === "accept" ? 1 : 0;
    const dismissed = action === "dismiss" ? 1 : 0;
    const result = db.prepare(
      "UPDATE skill_runs SET accepted = ?, dismissed = ? WHERE id = ?",
    ).run(accepted, dismissed, id);
    if (result.changes === 0) {
      res.status(404).json({ error: "skill_run not found" });
      return;
    }
    auditAppend("user_feedback", { skill_run_id: id, action });
    // Re-learn so the gate's next decision uses the updated acceptance rate.
    const patterns = learnAndPersist();
    res.json({ ok: true, learned: patterns.acceptance });
  });

  app.post("/api/learn", (_req, res) => {
    const patterns = learnAndPersist();
    res.json(patterns);
  });

  // Read-only: returns the most recent learned patterns without re-running the
  // learner. Used by the dashboard's auto-refresh so we don't spam the disk.
  app.get("/api/twin/patterns", (_req, res) => {
    res.json(learn());
  });

  app.get("/api/voice", (_req, res) => {
    res.json({ enabled: isVoiceEnabled() });
  });

  app.post("/api/voice", (req, res) => {
    setVoiceEnabled(!!req.body?.enabled);
    res.json({ enabled: isVoiceEnabled() });
  });

  app.post("/api/voice/test", (req, res) => {
    const text = String(req.body?.text ?? "AURA voice check.").slice(0, 2000);
    const result = speak(text);
    res.json({ ...result, text });
  });

  app.post("/api/say", wrap(async (req, res) => {
    // Cap transcript length so a runaway client can't queue megabytes of TTS.
    const transcript = String(req.body?.transcript ?? "").trim().slice(0, 2000);
    if (!transcript) {
      res.status(400).json({ error: "transcript required" });
      return;
    }
    const langRaw = req.body?.lang;
    const lang: Lang = isLang(langRaw) ? langRaw : "en";
    const result = await routeIntent(transcript, lang);
    // Speak the reply through the macOS channel too (in case the user is near the laptop).
    speak(result.reply);
    res.json(result);
  }));

  app.get("/api/quiet", (_req, res) => {
    res.json(isInQuietBlock());
  });

  // ---- Settings (user-managed via UI) ----
  app.get("/api/settings", (_req, res) => {
    const all = (db
      .prepare("SELECT key, value FROM settings")
      .all() as Array<{ key: string; value: string }>);
    const obj: Record<string, string> = {};
    for (const r of all) obj[r.key] = r.value;
    // Merge with defaults so first-call returns sensible values. Single source
    // of truth is db.ts so the GET defaults never drift from the POST allowlist.
    res.json({ ...DEFAULT_SETTINGS, ...obj });
  });

  app.post("/api/settings", (req, res) => {
    const updates = req.body;
    if (updates === null || typeof updates !== "object" || Array.isArray(updates)) {
      res.status(400).json({ error: "body must be an object" });
      return;
    }
    const ts = new Date().toISOString();
    const accepted: Record<string, string> = {};
    const rejected: string[] = [];
    // Use Object.keys (own enumerable) to avoid prototype pollution via __proto__.
    for (const k of Object.keys(updates)) {
      if (!ALLOWED_SETTING_KEYS.has(k)) { rejected.push(k); continue; }
      const v = (updates as Record<string, unknown>)[k];
      // Reject non-stringifiable types — we don't want "[object Object]" persisted.
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        rejected.push(k);
        continue;
      }
      const stored = String(v).slice(0, 1000);
      db.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      ).run(k, stored, ts);
      accepted[k] = stored;
    }
    auditAppend("settings_updated", { accepted, rejected });
    res.json({ ok: true, accepted, rejected });
  });

  // ---- Activity stats: per-day counts + acceptance ----
  app.get("/api/activity", (req, res) => {
    // Validate days: positive integer, capped to 365 so an attacker can't
    // request a billion-day window and lock the SQLite scan.
    const raw = req.query?.days;
    const parsed = raw === undefined ? 7 : Number(raw);
    const days = Number.isFinite(parsed) && parsed >= 1 && parsed <= 365
      ? Math.floor(parsed)
      : 7;
    const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    const totals = db
      .prepare(
        `SELECT skill, COUNT(*) AS sent,
                COALESCE(SUM(accepted), 0) AS accepted,
                COALESCE(SUM(dismissed), 0) AS dismissed
         FROM skill_runs
         WHERE ts >= ?
         GROUP BY skill
         ORDER BY sent DESC`,
      )
      .all(since) as Array<{ skill: string; sent: number; accepted: number; dismissed: number }>;
    const byDay = db
      .prepare(
        `SELECT date(ts) AS day, COUNT(*) AS sent,
                COALESCE(SUM(accepted), 0) AS accepted,
                COALESCE(SUM(dismissed), 0) AS dismissed
         FROM skill_runs
         WHERE ts >= ?
         GROUP BY day
         ORDER BY day ASC`,
      )
      .all(since) as Array<{ day: string; sent: number; accepted: number; dismissed: number }>;
    const totalSent = totals.reduce((s, x) => s + x.sent, 0);
    const totalAccepted = totals.reduce((s, x) => s + x.accepted, 0);
    const totalDismissed = totals.reduce((s, x) => s + x.dismissed, 0);
    const totalLabeled = totalAccepted + totalDismissed;
    res.json({
      days,
      summary: {
        sent: totalSent,
        accepted: totalAccepted,
        dismissed: totalDismissed,
        acceptance_rate: totalLabeled === 0 ? null : Number((totalAccepted / totalLabeled).toFixed(2)),
      },
      by_skill: totals,
      by_day: byDay,
    });
  });

  // ---- Auto-demo: AURA narrates and triggers her own pitch.
  app.post("/api/demo/start", (_req, res) => {
    const status = getDemoStatus();
    if (status.running) {
      res.status(409).json({ error: "demo already running", status });
      return;
    }
    // Fire-and-forget; client polls /api/demo/state for progress. We catch the
    // promise so a thrown demo step doesn't become an unhandled rejection.
    startDemo().catch((err) => {
      console.error("[demo] startDemo failed:", err);
      auditAppend("demo_error", { error: (err as Error)?.message ?? String(err) });
    });
    res.json({ ok: true, status: getDemoStatus() });
  });

  app.post("/api/demo/stop", (_req, res) => {
    stopDemo();
    res.json({ ok: true, status: getDemoStatus() });
  });

  app.get("/api/demo/state", (_req, res) => {
    res.json(getDemoStatus());
  });

  // Raw narration (used by client-driven demos that want to push text into the orb's "last said").
  app.post("/api/narrate", (req, res) => {
    const text = String(req.body?.text ?? "").trim().slice(0, 2000);
    if (!text) {
      res.status(400).json({ error: "text required" });
      return;
    }
    speak(text);
    db.prepare(
      "INSERT INTO skill_runs (ts, skill, accepted, dismissed, payload) VALUES (?, ?, ?, ?, ?)",
    ).run(new Date().toISOString(), "narrate", null, null, JSON.stringify({ text }));
    res.json({ ok: true });
  });

  // Convenience endpoint for the Simple page: returns the last sent notification
  // and the next scheduled tick window so the UI can show "next: morning_brief @ 06:30".
  app.get("/api/last", (_req, res) => {
    // Match the JSON key '"text":' (not the substring "text", which would match
    // payloads with words like "context"). Backslash-escape the quotes since
    // SQLite LIKE doesn't treat them specially but the literal needs them.
    const lastNotif = db
      .prepare(
        `SELECT ts, skill, payload FROM skill_runs WHERE payload LIKE '%"text":%' ORDER BY id DESC LIMIT 1`,
      )
      .get() as { ts: string; skill: string; payload: string } | undefined;
    let lastText: string | null = null;
    if (lastNotif) {
      try {
        lastText = JSON.parse(lastNotif.payload).text ?? null;
      } catch {}
    }
    const next = db
      .prepare("SELECT title, start_ts FROM calendar WHERE start_ts > datetime('now') ORDER BY start_ts ASC LIMIT 1")
      .get() as { title: string; start_ts: string } | undefined;
    res.json({
      last_message: lastText
        ? {
            skill: lastNotif!.skill,
            ts: lastNotif!.ts,
            text: lastText,
          }
        : null,
      next_event: next
        ? {
            title: next.title,
            min_until: Math.round(
              (new Date(next.start_ts).getTime() - Date.now()) / 60000,
            ),
          }
        : null,
      voice_enabled: isVoiceEnabled(),
    });
  });

  app.post("/api/gate/test", (req, res) => {
    const now = new Date();
    const score = computeScore(now);
    const next = db
      .prepare("SELECT title, start_ts FROM calendar WHERE start_ts > ? ORDER BY start_ts ASC LIMIT 1")
      .get(now.toISOString()) as { title: string; start_ts: string } | undefined;
    const nextMinUntil = next
      ? Math.round((new Date(next.start_ts).getTime() - now.getTime()) / 60000)
      : null;
    const action: ProposedAction = {
      skill: req.body?.skill ?? "morning_brief",
      text: req.body?.text ?? "test",
      importance: req.body?.importance ?? "normal",
    };
    const ctx: GateContext = {
      now,
      score,
      next_event_min_until: nextMinUntil,
      next_event_title: next?.title ?? null,
    };
    const decision = shouldIntervene(action, ctx, loadSoul(), loadTwin());
    res.json({ decision, score: { total: score.total }, context: ctx });
  });

  // Global error handler — catches both sync throws and rejected promises
  // routed via wrap(). Without this, async failures crash the daemon. Must be
  // declared LAST so it sees errors from every preceding route.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[server] unhandled error:", err);
    try {
      auditAppend("server_error", { message });
    } catch { /* never let auditing recursion crash the handler */ }
    if (res.headersSent) return;
    res.status(500).json({ error: "internal_error", message });
  });

  return app;
}
