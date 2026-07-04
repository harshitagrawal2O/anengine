import { config } from "./config.js";
import { db, recordEvent, setShuttingDown } from "./db.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { createServer } from "./server.js";
import { append as auditAppend, verifyChain } from "./audit/log.js";
import { seed } from "./data/seed.js";
import { countCalibratedContexts } from "./pi-engine/calibration.js";
import { checkOllamaHealth } from "./gateway/ollama.js";
import { speakWithRetry } from "./gateway/voice.js";
import { safeSetTimeout } from "./util/time.js";
import type { Server } from "node:http";

// ── Boot-time production config validation ────────────────────────────────────
// Fail fast on misconfigurations that would be unsafe in production rather than
// booting into an insecure or forgeable state.
function validateBootConfig(): void {
  const apiKey = process.env.AURA_API_KEY ?? "";

  // Audit chain integrity: a publicly-known secret means anyone can forge entries.
  if (config.isProd && config.audit.secretIsDefault) {
    throw new Error(
      "AUDIT_HMAC_SECRET is the public default in production — the audit chain would be forgeable. Set a private secret.",
    );
  }
  if (config.audit.secretIsDefault) {
    console.warn(
      "[security] AUDIT_HMAC_SECRET is the public default — audit log is NOT tamper-evident. Set AUDIT_HMAC_SECRET.",
    );
  }

  // Auth: if the daemon is reachable off-box, it MUST require an API key.
  if (!config.isLoopbackOnly && !apiKey) {
    throw new Error(
      `Refusing to bind to non-loopback host "${config.host}" without AURA_API_KEY. ` +
        `Set AURA_API_KEY (so requests need Authorization: Bearer <key>), or bind to 127.0.0.1.`,
    );
  }
  if (config.isProd && !apiKey) {
    throw new Error("AURA_API_KEY must be set in production.");
  }
}

function maybeSeed(): void {
  const row = db.prepare("SELECT COUNT(*) AS c FROM calendar").get() as
    | { c: number }
    | undefined;
  if (!row || row.c === 0) {
    console.log("[init] empty DB, seeding demo data...");
    seed();
  }
}

function recoverTimers(): void {
  const now = new Date();
  const rows = db
    .prepare("SELECT id, label, end_ts FROM timers WHERE fired = 0")
    .all() as Array<{ id: number; label: string; end_ts: string }>;
  if (rows.length === 0) return;

  for (const row of rows) {
    const end = new Date(row.end_ts);
    const remainingMs = end.getTime() - now.getTime();
    if (remainingMs <= 0) {
      const message = `Timer up: ${row.label}.`;
      void speakWithRetry(message);
      db.prepare("UPDATE timers SET fired = 1 WHERE id = ?").run(row.id);
      recordEvent("timer_fired", { label: row.label, minutes: 0, recovered: true });
      auditAppend("timer_fired", { label: row.label, minutes: 0, recovered: true });
      auditAppend("timer_recovered", { id: row.id, label: row.label, overdue: true });
      continue;
    }
    // safeSetTimeout re-arms in <=24-day chunks so a recovered long-horizon timer
    // doesn't overflow setTimeout's 32-bit delay and fire immediately.
    safeSetTimeout(() => {
      const message = `Timer up: ${row.label}.`;
      void speakWithRetry(message);
      db.prepare("UPDATE timers SET fired = 1 WHERE id = ?").run(row.id);
      recordEvent("timer_fired", { label: row.label, minutes: Math.round(remainingMs / 60000), recovered: true });
      auditAppend("timer_fired", { label: row.label, minutes: Math.round(remainingMs / 60000), recovered: true });
      auditAppend("timer_recovered", { id: row.id, label: row.label, overdue: false });
    }, remainingMs, { unref: true });
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// On SIGTERM / SIGINT, AURA:
//   1. Stops accepting new HTTP connections.
//   2. Flushes the WAL journal to the main DB file.
//   3. Closes the SQLite database handle cleanly.
//   4. Logs the shutdown event to the audit chain.
// This prevents data loss if the process is killed by a container orchestrator,
// systemd, or Ctrl-C during development.
function setupGracefulShutdown(server: Server): void {
  let shutting_down = false;

  const shutdown = (signal: string) => {
    if (shutting_down) return; // prevent double-shutdown
    shutting_down = true;
    setShuttingDown(true);
    console.log(`\n[shutdown] ${signal} received — stopping AURA...`);

    // 1. Stop the tick loop so no new DB work starts during the drain.
    stopScheduler();

    // 2. Audit the shutdown event while the DB is still open.
    try {
      auditAppend("daemon_stop", { signal, pid: process.pid });
    } catch { /* best-effort — DB may already be locked */ }

    let closed = false;
    const closeDb = () => {
      if (closed) return;
      closed = true;
      // Flush WAL and close SQLite only AFTER in-flight requests have drained,
      // so a handler mid-query never hits a closed database.
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.close();
        console.log("[shutdown] Database flushed and closed.");
      } catch (err) {
        console.error("[shutdown] DB close error (non-fatal):", err);
      }
    };

    // 3. Stop accepting new connections; close the DB once existing ones finish.
    server.close(() => {
      console.log("[shutdown] HTTP server closed.");
      closeDb();
      process.exit(0);
    });

    // 4. Hard deadline: if requests don't drain in time, close DB and exit anyway.
    setTimeout(() => {
      console.log("[shutdown] Forced exit after timeout.");
      closeDb();
      process.exit(0);
    }, 5000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

// ── Uncaught error handlers ───────────────────────────────────────────────────
// After an uncaughtException the process is in an undefined state — continuing to
// run risks corrupt data and masks the failure from a supervisor. We log/audit,
// then exit with a non-zero code so the process manager (systemd/pm2/container)
// can restart us cleanly. Guarded so a throw during logging can't loop.
let fatalHandled = false;
function handleFatal(kind: string, err: unknown): void {
  if (fatalHandled) return;
  fatalHandled = true;
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(`[FATAL] ${kind}:`, e);
  try { auditAppend(kind, { message: e.message, stack: e.stack?.slice(0, 500) }); } catch {}
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
  // Small delay so stderr/audit flush before exit.
  setTimeout(() => process.exit(1), 100).unref();
}

process.on("uncaughtException", (err) => handleFatal("uncaught_exception", err));
process.on("unhandledRejection", (reason) => handleFatal("unhandled_rejection", reason));

function main(): void {
  console.log("AURA daemon starting...");
  validateBootConfig();
  console.log(`  db:    ${config.paths.db}`);
  console.log(`  soul:  ${config.paths.soul}`);
  console.log(`  beat:  ${config.paths.heartbeat}`);
  console.log(`  twin:  ${config.paths.twin}`);

  maybeSeed();
  recoverTimers();
  auditAppend("daemon_start", { version: "0.1.0", pid: process.pid });

  const verify = verifyChain();
  if (!verify.ok) {
    console.warn(`[audit] chain broken at id ${verify.broken_at} — continuing in dev mode`);
  } else {
    console.log("[audit] chain verified");
  }

  const calibratedN = countCalibratedContexts();
  console.log(`Edge-PRISM calibration: ACTIVE (${calibratedN} contexts loaded)`);

  startScheduler();

  const app = createServer();
  const server = app.listen(config.port, config.host, () => {
    console.log(`AURA dashboard:  http://${config.host}:${config.port}  (bound to ${config.host})`);
    void checkOllamaHealth().then((h) => {
      if (h.online) {
        console.log(`Ollama: ONLINE — model ${h.model ?? config.ollama.model} loaded`);
      } else {
        console.log("Ollama: OFFLINE — Shadow AURA will be SUPPRESSED, not consulted");
      }
    });
  });

  // Wire up graceful shutdown handlers.
  setupGracefulShutdown(server);
}

main();
