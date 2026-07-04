// eod_wrap — intelligent end-of-day summary.
//
// Logic:
//   1. Count today's meetings (from calendar) and skill_runs (AURA's pings).
//   2. Count total steps for the day.
//   3. Check if tomorrow's calendar is packed (≥ 3 events) → add prep hint.
//   4. Check for any uncompleted calendar events that should have happened
//      (past end_ts, no matching skill_run acceptance) → flag missed items.
//   5. Compute a "day quality" label from the readiness score.
//   6. Build a smart summary message covering all of the above.

import { runSkill, type SkillBaseResult } from "../_lib.js";
import { db, localDateString, localDayBounds } from "../../db.js";
import type { Lang } from "../../i18n.js";

// ── Data helpers ──────────────────────────────────────────────────────────────

type DaySummary = {
  meetings: number;
  steps: number;
  aura_pings: number;
  tomorrow_events: number;
  missed_events: number;
};

function buildDaySummary(now: Date): DaySummary {
  const today = localDateString(now);
  const tomorrowDate = new Date(now);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = localDateString(tomorrowDate);
  const todayBounds = localDayBounds(now);
  const tomorrowBounds = localDayBounds(tomorrowDate);

  const meetings = (
    db
        .prepare("SELECT COUNT(*) AS c FROM calendar WHERE start_ts >= ? AND start_ts <= ?")
        .get(todayBounds.start, todayBounds.end) as { c: number } | undefined
  )?.c ?? 0;

  const steps = (
    db
      .prepare("SELECT COALESCE(SUM(count), 0) AS c FROM steps WHERE date = ?")
      .get(today) as { c: number } | undefined
  )?.c ?? 0;

  // AURA pings: actual interventions sent today (not dry-runs).
  // Use the local-day ISO range, not SQLite date(ts) (which extracts the UTC
  // date and mismatches the local `today` near midnight / in non-UTC zones).
  const aura_pings = (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM skill_runs WHERE ts >= ? AND ts <= ? AND ((accepted IS NULL AND dismissed IS NULL) OR accepted = 1)",
      )
      .get(todayBounds.start, todayBounds.end) as { c: number } | undefined
  )?.c ?? 0;

  // Tomorrow's event density.
  const tomorrow_events = (
    db
        .prepare("SELECT COUNT(*) AS c FROM calendar WHERE start_ts >= ? AND start_ts <= ?")
        .get(tomorrowBounds.start, tomorrowBounds.end) as { c: number } | undefined
  )?.c ?? 0;

  // Missed events: calendar events whose end_ts is now past but had no accepted skill_run.
  const missed_events = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM calendar
         WHERE start_ts >= ? AND start_ts <= ? AND end_ts < ?
         AND id NOT IN (
           SELECT DISTINCT CAST(json_extract(payload, '$.event_id') AS INTEGER)
           FROM skill_runs
           WHERE skill = 'meeting_reminder' AND accepted = 1
           AND json_extract(payload, '$.event_id') IS NOT NULL
         )`,
      )
      .get(todayBounds.start, todayBounds.end, now.toISOString()) as { c: number } | undefined
  )?.c ?? 0;

  return { meetings, steps, aura_pings, tomorrow_events, missed_events };
}

function dayLabel(steps: number, meetings: number): string {
  if (steps > 8000 && meetings <= 4) return "excellent";
  if (steps > 5000) return "solid";
  if (meetings > 6) return "packed";
  if (steps < 2000) return "light on movement";
  return "good";
}

// ── Text builder ──────────────────────────────────────────────────────────────

function buildText(lang: Lang, s: DaySummary): string {
  const label = dayLabel(s.steps, s.meetings);
  const stepsStr = s.steps.toLocaleString();
  const tomorrowHint =
    s.tomorrow_events >= 3
      ? lang === "hi"
        ? ` कल ${s.tomorrow_events} इवेंट हैं — तैयार रहें।`
        : lang === "kn"
          ? ` ನಾಳೆ ${s.tomorrow_events} ಕಾರ್ಯಕ್ರಮಗಳಿವೆ — ಸಿದ್ಧರಾಗಿ.`
          : ` Tomorrow has ${s.tomorrow_events} events — prep tonight.`
      : "";
  const missedHint =
    s.missed_events > 0
      ? lang === "hi"
        ? ` ${s.missed_events} ईवेंट छूट गए।`
        : lang === "kn"
          ? ` ${s.missed_events} ಕಾರ್ಯಕ್ರಮ ತಪ್ಪಿದೆ.`
          : ` ${s.missed_events} event${s.missed_events > 1 ? "s" : ""} slipped through.`
      : "";

  if (lang === "hi") {
    return `आज: ${s.meetings} मीटिंग, ${stepsStr} कदम, AURA ने ${s.aura_pings} बार मदद की।${missedHint} ${label} दिन।${tomorrowHint}`;
  }
  if (lang === "kn") {
    return `ಇಂದು: ${s.meetings} ಸಭೆಗಳು, ${stepsStr} ಹೆಜ್ಜೆಗಳು, AURA ${s.aura_pings} ಬಾರಿ ಸಹಾಯ ಮಾಡಿದೆ.${missedHint} ${label} ದಿನ.${tomorrowHint}`;
  }
  return `Day wrap: ${s.meetings} meeting${s.meetings !== 1 ? "s" : ""}, ${stepsStr} steps, ${s.aura_pings} AURA ping${s.aura_pings !== 1 ? "s" : ""}.${missedHint} ${label.charAt(0).toUpperCase() + label.slice(1)} day.${tomorrowHint}`;
}

// ── Skill entry point ─────────────────────────────────────────────────────────

export async function run(
  opts: { dry_run?: boolean; now?: Date; lang?: Lang; prewarm?: boolean } = {},
): Promise<SkillBaseResult> {
  const now = opts.now ?? new Date();
  const summary = buildDaySummary(now);

  return runSkill(
    {
      skill: "eod_wrap",
      importance: "normal",
      buildText: ({ lang }) => buildText(lang, summary),
      systemPrompt:
        "You are AURA wrapping up the user's day. Summarize it warmly and concisely (2–3 sentences). " +
        "Include the meeting count, step count, and any tomorrow preparation hint from the context. " +
        "End with a one-word day quality adjective. Be encouraging, not clinical.",
    },
    opts,
  );
}
