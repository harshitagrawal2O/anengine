import { config } from "./config.js";
import { db } from "./db.js";
import { startScheduler } from "./scheduler.js";
import { createServer } from "./server.js";
import { append as auditAppend, verifyChain } from "./audit/log.js";
import { seed } from "./data/seed.js";
import { countCalibratedContexts } from "./pi-engine/calibration.js";
import { checkOllamaHealth } from "./gateway/ollama.js";

function maybeSeed(): void {
  const row = db.prepare("SELECT COUNT(*) AS c FROM calendar").get() as
    | { c: number }
    | undefined;
  if (!row || row.c === 0) {
    console.log("[init] empty DB, seeding demo data...");
    seed();
  }
}

function main(): void {
  console.log("AURA daemon starting...");
  console.log(`  db:    ${config.paths.db}`);
  console.log(`  soul:  ${config.paths.soul}`);
  console.log(`  beat:  ${config.paths.heartbeat}`);
  console.log(`  twin:  ${config.paths.twin}`);

  maybeSeed();
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
  app.listen(config.port, () => {
    console.log(`AURA dashboard:  http://localhost:${config.port}`);
    void checkOllamaHealth().then((h) => {
      if (h.online) {
        console.log(`Ollama: ONLINE — model ${h.model ?? config.ollama.model} loaded`);
      } else {
        console.log("Ollama: OFFLINE — Shadow AURA will be SUPPRESSED, not consulted");
      }
    });
  });
}

main();
