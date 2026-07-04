import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const ROOT = resolve(__dirname, "..");

// The historical default audit secret. Kept as a constant so boot-time checks can
// detect when the chain would be signed with a publicly-known key (forgeable).
export const DEFAULT_AUDIT_SECRET = "dev-secret-change-me";

// Parse an integer env var with bounds; throw early on garbage so a typo can't
// silently turn into NaN (e.g. a NaN tick interval => tight DB-hammering loop).
function intEnv(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}="${raw}" — expected an integer in [${min}, ${max}].`);
  }
  return n;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const auditSecret = process.env.AUDIT_HMAC_SECRET ?? DEFAULT_AUDIT_SECRET;
// Default bind is loopback-only so the daemon isn't reachable off-box unless the
// operator explicitly opts in (HOST=0.0.0.0), which forces auth (see server.ts).
const host = process.env.HOST ?? "127.0.0.1";

export const config = {
  port: intEnv("PORT", 3000, 1, 65535),
  tickIntervalSec: intEnv("TICK_INTERVAL_SEC", 30, 5, 86400),
  host,
  isLoopbackOnly: LOOPBACK_HOSTS.has(host),
  isProd: process.env.NODE_ENV === "production",
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID ?? "",
  },
  ollama: {
    url: process.env.OLLAMA_URL ?? "",
    model: process.env.OLLAMA_MODEL ?? "llama3.2",
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? "",
    model: process.env.GEMINI_MODEL ?? "gemini-1.5-flash",
  },
  audit: {
    secret: auditSecret,
    secretIsDefault: auditSecret === DEFAULT_AUDIT_SECRET,
  },
  paths: {
    // AURA_DB_PATH lets ops point the SQLite file at a custom data dir, and lets
    // tests run against a throwaway database instead of the real one.
    db: process.env.AURA_DB_PATH ? resolve(process.env.AURA_DB_PATH) : resolve(ROOT, "data", "aura.db"),
    soul: resolve(ROOT, "SOUL.md"),
    heartbeat: resolve(ROOT, "HEARTBEAT.yaml"),
    twin: resolve(ROOT, "TWIN.md"),
    skills: resolve(ROOT, "src", "skills"),
    publicDir: resolve(ROOT, "public"),
  },
};
