// Import this FIRST in any test that touches the DB. It points AURA at a
// throwaway SQLite file (unique per test process) so tests never read or mutate
// the real data/aura.db. Node's test runner runs each file in its own process,
// so a per-pid path keeps files isolated.
import { tmpdir } from "node:os";
import { resolve } from "node:path";

process.env.AURA_DB_PATH = resolve(tmpdir(), `aura-test-${process.pid}.db`);
process.env.VOICE_ENABLED = "0"; // never actually vocalize during tests
process.env.NODE_ENV = "test";
