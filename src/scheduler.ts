import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { config } from "./config.js";
import { db } from "./db.js";
import { append as auditAppend } from "./audit/log.js";
import * as morningBrief from "./skills/morning_brief/index.js";
import * as commuteGuardian from "./skills/commute_guardian/index.js";
import * as meetingReminder from "./skills/meeting_reminder/index.js";
import * as hydration from "./skills/hydration_reminder/index.js";
import * as standupBreak from "./skills/standup_break/index.js";
import * as eodWrap from "./skills/eod_wrap/index.js";
import * as windDown from "./skills/wind_down/index.js";
import { learnAndPersist } from "./twin/learn.js";

type Tick = {
  id: string;
  skill: string;
  when: string;
  cadence: "once_per_day" | "every_5_min" | "every_minute";
  dry_run?: boolean;
  description?: string;
};

type SkillRunner = (opts: { dry_run?: boolean; now?: Date }) => Promise<{
  score: { total: number };
  decision: { intervene: boolean };
}>;

// twin_learn isn't a "skill" in the user-facing sense, but it slots into the same scheduler.
const twinLearn: SkillRunner = async ({ now } = {}) => {
  const patterns = learnAndPersist(now ?? new Date());
  return {
    score: { total: 0 },
    decision: { intervene: false },
  };
};

const SKILLS: Record<string, SkillRunner> = {
  morning_brief: morningBrief.run as SkillRunner,
  commute_guardian: commuteGuardian.run as SkillRunner,
  meeting_reminder: meetingReminder.run as SkillRunner,
  hydration_reminder: hydration.run as SkillRunner,
  standup_break: standupBreak.run as SkillRunner,
  eod_wrap: eodWrap.run as SkillRunner,
  wind_down: windDown.run as SkillRunner,
  twin_learn: twinLearn,
};

function loadHeartbeat(): Tick[] {
  const raw = readFileSync(config.paths.heartbeat, "utf8");
  const parsed = parseYaml(raw) as { ticks: Tick[] };
  return parsed.ticks ?? [];
}

function inWindow(now: Date, when: string): boolean {
  if (when === "*") return true;
  const m = when.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
  if (!m) return false;
  const [sh, sm] = m[1].split(":").map(Number);
  const [eh, em] = m[2].split(":").map(Number);
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  return minutes >= start && minutes < end;
}

// Local-date stamp (YYYY-MM-DD) — once_per_day fires on the user's calendar day,
// not on UTC. Using toISOString().slice(0,10) means "day rollover at 00:00 UTC",
// which is wrong in any non-UTC timezone (e.g. UTC+9: a once_per_day brief
// scheduled for 06:30 local would only fire on calendar days that happen to
// roll over in UTC since the previous run).
function localDateStamp(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shouldFire(tick: Tick, now: Date, lastRun: Date | null): boolean {
  if (!inWindow(now, tick.when)) return false;
  if (!lastRun) return true;
  const elapsedMin = (now.getTime() - lastRun.getTime()) / 60000;
  switch (tick.cadence) {
    case "once_per_day":
      return localDateStamp(lastRun) !== localDateStamp(now);
    case "every_5_min":
      return elapsedMin >= 5;
    case "every_minute":
      return elapsedMin >= 1;
  }
}

const lastRunStmt = db.prepare("SELECT last_run FROM scheduler_state WHERE tick_id = ?");
const setLastRunStmt = db.prepare(
  "INSERT INTO scheduler_state (tick_id, last_run) VALUES (?, ?) ON CONFLICT(tick_id) DO UPDATE SET last_run = excluded.last_run",
);

export async function runTickOnce(now: Date = new Date()): Promise<void> {
  const ticks = loadHeartbeat();
  for (const tick of ticks) {
    const lastRow = lastRunStmt.get(tick.id) as { last_run: string } | undefined;
    const lastRun = lastRow ? new Date(lastRow.last_run) : null;
    if (!shouldFire(tick, now, lastRun)) continue;
    const skill = SKILLS[tick.skill];
    if (!skill) {
      console.warn(`[scheduler] no skill registered for ${tick.skill}`);
      continue;
    }
    console.log(
      `[scheduler] firing tick=${tick.id} skill=${tick.skill} dry_run=${tick.dry_run ?? false}`,
    );
    try {
      const result = await skill({ dry_run: tick.dry_run, now });
      auditAppend("tick_fired", {
        tick_id: tick.id,
        skill: tick.skill,
        dry_run: tick.dry_run ?? false,
        score_total: result.score.total,
        intervened: result.decision.intervene,
      });
      setLastRunStmt.run(tick.id, now.toISOString());
    } catch (err) {
      console.error(`[scheduler] tick ${tick.id} failed:`, err);
      auditAppend("tick_error", { tick_id: tick.id, error: (err as Error).message });
    }
  }
}

export function startScheduler(): void {
  console.log(
    `[scheduler] starting, tick interval = ${config.tickIntervalSec}s`,
  );
  // Fire once at startup so the dashboard has a fresh score immediately.
  // Catch rejections so a single bad tick doesn't kill the daemon.
  const safeTick = () => {
    runTickOnce().catch((err) => {
      console.error("[scheduler] runTickOnce failed:", err);
      try { auditAppend("scheduler_error", { error: (err as Error)?.message ?? String(err) }); } catch {}
    });
  };
  safeTick();
  setInterval(safeTick, config.tickIntervalSec * 1000);
}
