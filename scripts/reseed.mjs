// Cross-platform reseed: delete the SQLite db files, then run the seeder.
// Replaces the old `rm -f ...` shell script, which failed on Windows (the
// project's primary toolchain).
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const f of ["data/aura.db", "data/aura.db-wal", "data/aura.db-shm"]) {
  try {
    rmSync(resolve(root, f), { force: true });
  } catch { /* ignore */ }
}

// Run the TypeScript seeder via tsx (a runtime dependency). shell:true so the
// tsx.cmd shim resolves on Windows.
const r = spawnSync("tsx", ["src/data/seed.ts"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});
process.exit(r.status ?? 0);
