import { writeFileSync } from "node:fs";
import { db } from "../db.js";
import { config } from "../config.js";

export type LearnedPatterns = {
  generated_at: string;
  wake_time: { median: string; trend: "earlier" | "later" | "stable"; confidence: number };
  sleep_duration: { median_min: number; recent_avg_min: number; trend: "down" | "up" | "stable" };
  routines: Array<{ time: string; activity: string; days_observed: number }>;
  acceptance: Record<string, { sent: number; accepted: number; dismissed: number; rate: number }>;
  notif_24h: number;
  burden_score: number;
};

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmtTimeFromMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Per day, scan steps from 5am onward and pick the first hour where steps cross
// the daily wake threshold (mean of low + high). Returns a list of wake-hour minutes per day.
function inferWakeMinutes(): { perDay: Array<{ date: string; wakeMin: number }>; recent: number[]; old: number[] } {
  const days = db
    .prepare("SELECT DISTINCT date FROM steps ORDER BY date DESC LIMIT 14")
    .all() as Array<{ date: string }>;
  const perDay: Array<{ date: string; wakeMin: number }> = [];
  for (const { date } of days) {
    const rows = db
      .prepare("SELECT hour, count FROM steps WHERE date = ? ORDER BY hour ASC")
      .all(date) as Array<{ hour: number; count: number }>;
    if (rows.length === 0) continue;
    const counts = rows.map((r) => r.count);
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    const threshold = min + (max - min) * 0.4;
    const first = rows.find((r) => r.count >= threshold && r.hour >= 5);
    if (first) perDay.push({ date, wakeMin: first.hour * 60 });
  }
  // Recent = last 5 days, old = days 6-14.
  const recent = perDay.slice(0, 5).map((d) => d.wakeMin);
  const old = perDay.slice(5).map((d) => d.wakeMin);
  return { perDay, recent, old };
}

function classifyTrend(recent: number, old: number, deltaUnit: number): "earlier" | "later" | "stable" {
  const diff = recent - old;
  if (Math.abs(diff) < deltaUnit) return "stable";
  return diff > 0 ? "later" : "earlier";
}

function sleepTrend(recent: number, old: number): "down" | "up" | "stable" {
  const diff = recent - old;
  if (Math.abs(diff) < 15) return "stable";
  return diff > 0 ? "up" : "down";
}

function inferRoutines(): Array<{ time: string; activity: string; days_observed: number }> {
  // Find peak step hours for the recent week and label them.
  const rows = db
    .prepare(
      `SELECT hour, AVG(count) AS avg_count, COUNT(*) AS days
       FROM steps
       WHERE date >= date('now', '-7 days')
       GROUP BY hour
       HAVING avg_count > 700
       ORDER BY hour ASC`,
    )
    .all() as Array<{ hour: number; avg_count: number; days: number }>;
  return rows.map((r) => {
    let activity = "active";
    if (r.hour >= 5 && r.hour < 9) activity = "morning routine / commute out";
    else if (r.hour >= 11 && r.hour < 14) activity = "lunch movement";
    else if (r.hour >= 17 && r.hour < 20) activity = "commute home / evening";
    return {
      time: `${String(r.hour).padStart(2, "0")}:00`,
      activity,
      days_observed: r.days,
    };
  });
}

function inferAcceptance(): LearnedPatterns["acceptance"] {
  const rows = db
    .prepare(
      `SELECT skill,
              COUNT(*) AS sent,
              COALESCE(SUM(accepted), 0) AS accepted,
              COALESCE(SUM(dismissed), 0) AS dismissed
       FROM skill_runs
       WHERE accepted IS NOT NULL OR dismissed IS NOT NULL
       GROUP BY skill`,
    )
    .all() as Array<{ skill: string; sent: number; accepted: number; dismissed: number }>;
  const out: LearnedPatterns["acceptance"] = {};
  for (const r of rows) {
    const labelled = r.accepted + r.dismissed;
    out[r.skill] = {
      sent: r.sent,
      accepted: r.accepted,
      dismissed: r.dismissed,
      rate: labelled > 0 ? Number((r.accepted / labelled).toFixed(2)) : 0.5,
    };
  }
  return out;
}

function recentNotifications(): number {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM notifications WHERE ts >= ?")
    .get(since) as { c: number } | undefined;
  return row?.c ?? 0;
}

export function learn(now: Date = new Date()): LearnedPatterns {
  const wake = inferWakeMinutes();
  const wakeMedianMin = median(wake.perDay.map((d) => d.wakeMin)) || 7 * 60;
  const recentMedian = median(wake.recent) || wakeMedianMin;
  const oldMedian = median(wake.old) || wakeMedianMin;
  const wakeTrend = classifyTrend(recentMedian, oldMedian, 15);
  const wakeConfidence = Math.min(1, wake.perDay.length / 10);

  const sleepRows = db
    .prepare("SELECT date, duration_min FROM sleep ORDER BY date DESC LIMIT 14")
    .all() as Array<{ date: string; duration_min: number }>;
  const sleepAll = sleepRows.map((r) => r.duration_min);
  const sleepRecent = sleepAll.slice(0, 5);
  const sleepOld = sleepAll.slice(5);
  const sleepRecentAvg =
    sleepRecent.length > 0 ? sleepRecent.reduce((a, b) => a + b, 0) / sleepRecent.length : 0;
  // With no older window yet, compare recent against itself so the trend reads
  // "stable" — not "up" (the old code compared against 0, so every user with
  // < 6 days of sleep history falsely trended upward).
  const sleepOldAvg =
    sleepOld.length > 0 ? sleepOld.reduce((a, b) => a + b, 0) / sleepOld.length : sleepRecentAvg;
  const sleep = {
    median_min: Math.round(median(sleepAll)),
    recent_avg_min: Math.round(sleepRecentAvg),
    trend: sleepTrend(sleepRecentAvg, sleepOldAvg),
  };

  return {
    generated_at: now.toISOString(),
    wake_time: {
      median: fmtTimeFromMinutes(wakeMedianMin),
      trend: wakeTrend,
      confidence: Number(wakeConfidence.toFixed(2)),
    },
    sleep_duration: sleep,
    routines: inferRoutines(),
    acceptance: inferAcceptance(),
    notif_24h: recentNotifications(),
    burden_score: Number(Math.min(1, recentNotifications() / 20).toFixed(2)),
  };
}

function renderTwinMarkdown(p: LearnedPatterns): string {
  const lines: string[] = [];
  lines.push("# TWIN — what AURA learned about you.");
  lines.push("");
  lines.push("This file is auto-generated by `src/twin/learn.ts` from your event history.");
  lines.push("Do not hand-edit. The numbers here feed p_need and p_accept in the PRISM gate.");
  lines.push("");
  lines.push(`Generated: ${p.generated_at}`);
  lines.push("");
  lines.push("## Wake time");
  lines.push(`median: "${p.wake_time.median}"`);
  lines.push(`trend: "${p.wake_time.trend}"`);
  lines.push(`confidence: ${p.wake_time.confidence}`);
  lines.push("");
  lines.push("## Sleep");
  lines.push(`median_min: ${p.sleep_duration.median_min}`);
  lines.push(`recent_avg_min: ${p.sleep_duration.recent_avg_min}`);
  lines.push(`trend: "${p.sleep_duration.trend}"`);
  lines.push("");
  lines.push("## Routines");
  if (p.routines.length === 0) {
    lines.push("(insufficient data)");
  } else {
    for (const r of p.routines) {
      lines.push(`- ${r.time} — ${r.activity}  (${r.days_observed} days)`);
    }
  }
  lines.push("");
  lines.push("## Acceptance history (per skill)");
  if (Object.keys(p.acceptance).length === 0) {
    lines.push("(no labelled runs yet)");
  } else {
    for (const [skill, a] of Object.entries(p.acceptance)) {
      lines.push(`${skill}:`);
      lines.push(`  sent: ${a.sent}`);
      lines.push(`  accepted: ${a.accepted}`);
      lines.push(`  dismissed: ${a.dismissed}`);
      lines.push(`  acceptance_rate: ${a.rate}`);
    }
  }
  lines.push("");
  lines.push("## Notification fatigue");
  lines.push(`Last 24h notifications sent: ${p.notif_24h}`);
  lines.push(`Current burden score: ${p.burden_score}`);
  lines.push("");
  return lines.join("\n");
}

export function learnAndPersist(now: Date = new Date()): LearnedPatterns {
  const patterns = learn(now);
  writeFileSync(config.paths.twin, renderTwinMarkdown(patterns));
  console.log(
    `[twin] learned: wake=${patterns.wake_time.median} (${patterns.wake_time.trend}, conf ${patterns.wake_time.confidence}), routines=${patterns.routines.length}, skills=${Object.keys(patterns.acceptance).length}`,
  );
  return patterns;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  learnAndPersist();
}
