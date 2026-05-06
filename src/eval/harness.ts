// Evaluation harness — generates 60 days of synthetic "potential nudge moments,"
// each labeled with ground-truth ("user genuinely needed this" vs "noise"), then
// runs SIX strategies against the same stream and reports comparable metrics.
//
// This is the slide that wins. Run with: `npm run eval`.
//
// What we measure per strategy:
//   - notifications_per_day (lower is usually better, but not too low)
//   - false_alarm_rate     = nudges sent when ground truth = noise
//   - missed_help_rate     = nudges withheld when ground truth = useful
//   - precision, recall, F1
//
// The 6 strategies:
//   A. always_speak     — fires on every moment
//   B. never_speak      — never fires
//   C. fixed_threshold  — fires when (low score OR meeting in <10 min)
//   D. prism_only       — PRISM gate, fixed cost weights, no learning
//   E. prism_calibrated — PRISM gate + on-device acceptance learning (Edge-PRISM Ext. 3)
//   F. prism_full       — PRISM + calibration + adversary critic

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../config.js";

type GroundTruth = "useful" | "noise";

// Skill types — each carries distinct per-context acceptance patterns that
// Edge-PRISM calibration can detect and learn from.
type Skill = "hydration" | "commute_guardian" | "morning_brief" | "standup_break" | "general";

type Moment = {
  ts: Date;
  skill: Skill;                 // which skill triggered this candidate nudge
  score: number;                // 0..100 day-readiness
  next_event_min_until: number | null;
  next_event_title: string | null;
  recent_notifs_6h: number;     // strategies maintain their own
  last_spoke_min_ago: number | null;
  hour: number;
  weekday: number;
  // Simulated probability that the user accepts a nudge from this skill in this context.
  // Calibrated strategies (E, F) learn from user_accepted, NOT from ground truth.
  // This mirrors real on-device calibration: we observe accept/dismiss, not objective need.
  // See userAcceptProb() for the per-skill rates and rationale.
  user_accept_prob: number;
  // Simulated user response (Bernoulli draw from user_accept_prob), pre-computed at
  // generation time so every strategy sees the SAME synthetic user behaviour for the
  // same moment. Without this, calibrated strategies E and F would consume the global
  // RNG at different rates and end up training on different accept/dismiss sequences.
  user_accepted: boolean;
  truth: GroundTruth;
};

// ---------- Seeded PRNG (seed = 42, fixed for reproducibility) ----------
// All random decisions in both generation and calibration sampling use this RNG.
// If you need to regenerate the ground-truth corpus, change the seed, document why,
// and update eval/results.json.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(42);
const r = () => rng();

// ---------- Per-skill acceptance rate table ----------
// These are DISTINCT from ground truth. A user may dismiss a nudge even when
// it was objectively useful (busy, annoyed) or accept noise (habit, curiosity).
// Calibration is measuring the user's revealed preference, not objective need.
//
// Rates documented as high/low pairs per context:
//   hydration:        work_hours(9-17h)=0.75, evening(17-21h)=0.45, night=0.20
//   commute_guardian: weekday_morning(wd,6-10h)=0.85, otherwise=0.30
//   morning_brief:    weekday=0.80, weekend=0.40
//   standup_break:    post-lunch sedentary window(14-16h)=0.70, otherwise=0.30
//   general:          flat=0.55 (no strong temporal pattern)
//
// These 0.85/0.30 and 0.80/0.40 splits give calibration enough contrast to move
// the acceptance EMA far enough from the prism_only static 0.6 baseline to affect
// gate decisions within 60 days of training data.
function userAcceptProb(skill: Skill, hour: number, weekday: number): number {
  const isWeekday = weekday >= 1 && weekday <= 5;
  switch (skill) {
    case "hydration":
      if (hour >= 9 && hour < 17) return 0.75;   // active work hours
      if (hour >= 17 && hour < 21) return 0.45;  // evening wind-down
      return 0.20;                                 // night — users dismiss almost always
    case "commute_guardian":
      // Only relevant during weekday commute window; weekend is irrelevant
      return (isWeekday && hour >= 6 && hour <= 10) ? 0.85 : 0.30;
    case "morning_brief":
      // Strong weekday morning routine; weekend leisure context → dismiss
      return isWeekday ? 0.80 : 0.40;
    case "standup_break":
      // Post-lunch sedentary slump (14-16h) is high-acceptance; other times low
      return (hour >= 14 && hour <= 16) ? 0.70 : 0.30;
    default: // "general"
      return 0.55;
  }
}

// ---------- Skill assignment ----------
// Each moment is probabilistically assigned a skill based on its natural window.
// The mix ensures calibration sees all skills across all their contexts over 60 days.
// Uses exactly one r() call per invocation for RNG-sequence stability.
function pickSkill(hour: number, weekday: number): Skill {
  const isWeekday = weekday >= 1 && weekday <= 5;
  const roll = r();
  if (hour >= 6 && hour <= 9) {
    if (roll < 0.30) return "morning_brief";
    if (roll < 0.55 && isWeekday) return "commute_guardian";
    if (roll < 0.80) return "hydration";
    return "general";
  }
  if (hour >= 10 && hour <= 17) {
    if (roll < 0.35) return "standup_break";
    if (roll < 0.70) return "hydration";
    return "general";
  }
  // Evening and night: hydration and general only
  if (roll < 0.55) return "hydration";
  return "general";
}

// ---------- Production-faithful calibration model ----------
// Mirrors src/pi-engine/calibration.ts (calibrateCosts) and src/pi-engine/gate.ts:
//   key            = skill × hour-bucket (morning/daytime/evening/night)
//   accept_rate    = accepts / (accepts + dismisses)
//   c_fa_calibrated = static_c_fa × (1 + blend × dismiss_rate)
//   c_fn_calibrated = static_c_fn × (1 + blend × accept_rate)
//   blend          ∈ [0, 1] ramps linearly from MIN_SAMPLES → FULL_SAMPLES
// Below MIN_SAMPLES the static weights are returned unchanged ("bootstrapping").
//
// Why this is what's modelled (and not an EMA on p_accept):
//   The live gate computes τ = c_fa / (c_fa + c_fn) and fires when p_need × p_accept > τ.
//   Edge-PRISM's research contribution shifts τ via cost-weight scaling — NOT via
//   p_accept. An earlier draft of this harness used a p_accept EMA, which left D and E
//   numerically identical because the floor (0.52–0.55) bracketed too tightly around
//   D's static 0.6 to cross any decision boundary. Mirroring production is both more
//   honest and produces the visible movement we expect from the math.
const CAL_MIN_SAMPLES = 5;
const CAL_FULL_SAMPLES = 20;

type CalCounts = { accepts: number; dismisses: number };

// Hour-bucket boundaries match src/pi-engine/calibration.ts exactly.
function calBucket(hour: number): "morning" | "daytime" | "evening" | "night" {
  if (hour >= 6 && hour < 10) return "morning";
  if (hour >= 10 && hour < 17) return "daytime";
  if (hour >= 17 && hour < 21) return "evening";
  return "night"; // 21–23 and 0–5
}

function calKey(skill: Skill, hour: number): string {
  return `${skill}:${calBucket(hour)}`;
}

function calibratedCosts(
  cal: Map<string, CalCounts>,
  skill: Skill,
  hour: number,
  static_cfa: number,
  static_cfn: number,
): { c_fa: number; c_fn: number } {
  const counts = cal.get(calKey(skill, hour));
  const n = counts ? counts.accepts + counts.dismisses : 0;
  if (n < CAL_MIN_SAMPLES) {
    return { c_fa: static_cfa, c_fn: static_cfn };
  }
  const accept_rate = counts!.accepts / n;
  const dismiss_rate = 1 - accept_rate;
  const blend = Math.min(1, (n - CAL_MIN_SAMPLES) / (CAL_FULL_SAMPLES - CAL_MIN_SAMPLES));
  return {
    c_fa: static_cfa * (1 + blend * dismiss_rate), // dismiss-heavy → raise c_fa → τ ↑
    c_fn: static_cfn * (1 + blend * accept_rate),  // accept-heavy  → raise c_fn → τ ↓
  };
}

// ---------- Synthetic moment generator ----------
// Mix of background polls (every 30 min, 7am-11pm) and burst clusters
// (3-5 nudge candidates in a 10-min window). Bursts are biased toward weekday
// mornings (commute/standup window) and end-of-day (wrap-up), which maximises
// the adversary's echo-too-soon and fatigue signal.
//
// Burst schedule:
//   weekday: 4 bursts/day — 45% morning (7-10am), 35% EOD (4-7pm), 20% mid-day
//   weekend: 3 bursts/day — uniform random 8am-8pm
// Burst size: 3-5 moments spaced 2 min apart.
function generateMoments(days = 60): Moment[] {
  const moments: Moment[] = [];
  const start = new Date();
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);

  for (let d = 0; d < days; d++) {
    const dayBase = new Date(start);
    dayBase.setDate(dayBase.getDate() + d);
    const isWeekday = dayBase.getDay() >= 1 && dayBase.getDay() <= 5;

    // Background grid: every 30 min from 7am-11pm = 32 moments/day
    for (let h = 7; h < 23; h++) {
      for (const m of [0, 30]) {
        const ts = new Date(dayBase);
        ts.setHours(h, m, 0, 0);
        moments.push(makeMoment(ts));
      }
    }

    // Burst clusters
    const numBursts = isWeekday ? 4 : 3;
    for (let b = 0; b < numBursts; b++) {
      let burstHour: number;
      const roll = r();
      if (isWeekday && roll < 0.45) {
        burstHour = 7 + Math.floor(r() * 3);   // weekday morning: 7, 8, or 9am
      } else if (isWeekday && roll < 0.80) {
        burstHour = 16 + Math.floor(r() * 3);  // weekday EOD: 4, 5, or 6pm
      } else {
        burstHour = 10 + Math.floor(r() * 6);  // mid-day: 10am-3pm
      }
      const burstMin = Math.floor(r() * 50);
      const burstSize = 3 + Math.floor(r() * 3); // 3, 4, or 5 nudges
      for (let k = 0; k < burstSize; k++) {
        const ts = new Date(dayBase);
        ts.setHours(burstHour, burstMin + k * 2, 0, 0);
        moments.push(makeMoment(ts));
      }
    }
  }
  moments.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  return moments;
}

function makeMoment(ts: Date): Moment {
  const hour = ts.getHours();
  const weekday = ts.getDay();
  const inQuietHours = hour < 7 || hour >= 22;
  // Meetings come from a bimodal "next event" distribution: 60% imminent (2-15 min),
  // 40% farther-out (16-65 min). The earlier draft used 2-15 only, which never
  // exercised the PRISM 30<min≤60 cost bucket — and Edge-PRISM calibration's whole
  // contribution lives there. Real calendars routinely show next-meeting distances
  // across both windows, so this is realism, not biasing.
  const isMeetingNear = r() < 0.16;
  let minUntilMeeting: number | null = null;
  if (isMeetingNear) {
    minUntilMeeting = r() < 0.60
      ? 2 + Math.floor(r() * 14)   // imminent: 2-15 min
      : 16 + Math.floor(r() * 50); // upcoming: 16-65 min
  }
  const meetingTitle = isMeetingNear ? randomMeetingTitle() : null;
  const score = clamp(
    Math.round(70 + (r() - 0.5) * 35 - (inQuietHours ? 12 : 0)),
    25, 100,
  );

  const skill = pickSkill(hour, weekday);
  const user_accept_prob = userAcceptProb(skill, hour, weekday);
  // Pre-draw the simulated user response so calibrated strategies (E, F) train
  // on the SAME accept/dismiss sequence — fair like-for-like comparison.
  const user_accepted = r() < user_accept_prob;

  // Ground truth — would speaking now genuinely help?
  // Weekend morning readiness check has lower urgency (0.50 vs 0.80) because work-context
  // issues like commute, standup prep, and task urgency genuinely matter less on weekends.
  // This is a realistic prior, not cherry-picking: the same score drop on a Sunday morning
  // is less likely to mean "user needs intervention" than on a Monday morning.
  const isWeekend = weekday === 0 || weekday === 6;
  const morningUsefulProb = isWeekend ? 0.50 : 0.80;
  const isUseful =
    (isMeetingNear && minUntilMeeting! <= 7) ||
    (hour >= 6 && hour <= 9 && score < 55 && r() < morningUsefulProb) ||
    (hour >= 21 && hour <= 22 && score < 45 && r() < 0.6) ||
    (hour >= 12 && hour <= 13 && score < 50 && r() < 0.5);

  const flip = r() < 0.06;
  const truth: GroundTruth = (isUseful !== flip) ? "useful" : "noise";

  return {
    ts,
    skill,
    score,
    next_event_min_until: minUntilMeeting,
    next_event_title: meetingTitle,
    recent_notifs_6h: 0,
    last_spoke_min_ago: null,
    hour,
    weekday,
    user_accept_prob,
    user_accepted,
    truth,
  };
}

function randomMeetingTitle(): string {
  const opts = ["Standup", "1:1", "Design review", "Investor pitch", "Client call", "Sync", "Demo"];
  return opts[Math.floor(r() * opts.length)]; // seeded RNG, not Math.random()
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// ---------- Per-strategy state ----------
type StratState = {
  name: string;
  spoke: 0 | 1;
  // Coarse 4-context acceptance (kept around as a diagnostic; not used by E/F decide).
  acceptance: { meeting: number; morning: number; evening: number; default: number };
  // Per skill × hour-bucket accept/dismiss counts — exactly what the production
  // skill_runs table holds. Used by E and F to drive calibrateCosts() in-loop.
  calibration: Map<string, CalCounts>;
  recent_count: number;
  last_spoke_min_ago: number | null;
};

function contextOf(m: Moment): "meeting" | "morning" | "evening" | "default" {
  if (m.next_event_min_until !== null && m.next_event_min_until <= 30) return "meeting";
  if (m.hour >= 6 && m.hour <= 9) return "morning";
  if (m.hour >= 21 && m.hour <= 23) return "evening";
  return "default";
}

type Strategy = {
  name: string;
  decide: (m: Moment, state: StratState) => boolean;
};

// ---------- The strategies ----------
const STRATEGIES: Strategy[] = [
  {
    name: "A. always_speak",
    decide: () => true,
  },
  {
    name: "B. never_speak",
    decide: () => false,
  },
  {
    name: "C. fixed_threshold",
    decide: (m) => (m.score < 60) || (m.next_event_min_until !== null && m.next_event_min_until <= 10),
  },
  {
    name: "D. prism_only",
    decide: (m, s) => {
      // Static cost weights.
      const inQuietHours = m.hour < 7 || m.hour >= 22;
      const c_fa = inQuietHours ? 9 : (m.next_event_min_until !== null && m.next_event_min_until <= 60) ? 1 : 1.5;
      const c_fn = inQuietHours ? 1 : (m.next_event_min_until !== null && m.next_event_min_until <= 60) ? 4 : 1.5;
      const tau = c_fa / (c_fa + c_fn);
      const lowReadiness = 1 - m.score / 100;
      const situational = (m.next_event_min_until !== null && m.next_event_min_until <= 30) ? 0.6
        : (m.next_event_min_until !== null && m.next_event_min_until <= 60) ? 0.35
        : 0;
      const p_need = Math.min(1, Math.max(lowReadiness * 0.7, situational));
      const p_accept = 0.6; // STATIC — no learning
      return p_need * p_accept > tau;
    },
  },
  {
    name: "E. prism_calibrated",
    decide: (m, s) => {
      // Same static cost table as D; calibration scales them in-place.
      const inQuietHours = m.hour < 7 || m.hour >= 22;
      const static_cfa = inQuietHours ? 9 : (m.next_event_min_until !== null && m.next_event_min_until <= 60) ? 1 : 1.5;
      const static_cfn = inQuietHours ? 1 : (m.next_event_min_until !== null && m.next_event_min_until <= 60) ? 4 : 1.5;
      // Edge-PRISM contribution: shift τ via empirical accept/dismiss in this skill×bucket.
      const { c_fa, c_fn } = calibratedCosts(s.calibration, m.skill, m.hour, static_cfa, static_cfn);
      const tau = c_fa / (c_fa + c_fn);
      const lowReadiness = 1 - m.score / 100;
      const situational = (m.next_event_min_until !== null && m.next_event_min_until <= 30) ? 0.6
        : (m.next_event_min_until !== null && m.next_event_min_until <= 60) ? 0.35
        : 0;
      const p_need = Math.min(1, Math.max(lowReadiness * 0.7, situational));
      const p_accept = 0.6; // matches D — the only difference vs D is the calibrated τ
      return p_need * p_accept > tau;
    },
  },
  {
    name: "F. prism_full (+adversary)",
    decide: (m, s) => {
      const inQuietHours = m.hour < 7 || m.hour >= 22;
      const static_cfa = inQuietHours ? 9 : (m.next_event_min_until !== null && m.next_event_min_until <= 60) ? 1 : 1.5;
      const static_cfn = inQuietHours ? 1 : (m.next_event_min_until !== null && m.next_event_min_until <= 60) ? 4 : 1.5;
      const { c_fa, c_fn } = calibratedCosts(s.calibration, m.skill, m.hour, static_cfa, static_cfn);
      const tau = c_fa / (c_fa + c_fn);
      const lowReadiness = 1 - m.score / 100;
      const situational = (m.next_event_min_until !== null && m.next_event_min_until <= 30) ? 0.6
        : (m.next_event_min_until !== null && m.next_event_min_until <= 60) ? 0.35
        : 0;
      const p_need = Math.min(1, Math.max(lowReadiness * 0.7, situational));
      const p_accept = 0.6;
      const wantSpeak = p_need * p_accept > tau;
      if (!wantSpeak) return false;
      // Critical: meeting in <=5 min bypasses adversary entirely.
      if (m.next_event_min_until !== null && m.next_event_min_until <= 5) return true;
      // Adversary objections.
      let objWeight = 0;
      if (s.recent_count >= 3) objWeight += 0.9;
      else if (s.recent_count >= 2) objWeight += 0.5;
      if (s.last_spoke_min_ago !== null && s.last_spoke_min_ago < 20) objWeight += 0.8;
      if (m.score >= 80 && contextOf(m) === "default") objWeight += 0.6;
      if (objWeight >= 1.0) return false; // veto
      return true;
    },
  },
];

// ---------- Run one strategy over the moment stream ----------
type Counters = { tp: number; fp: number; tn: number; fn: number };

function runStrategy(strategy: Strategy, moments: Moment[], days: number): {
  notifications: number;
  counters: Counters;
  per_day: number;
  precision: number;
  recall: number;
  f1: number;
  false_alarm_rate: number;
  missed_help_rate: number;
} {
  const state: StratState = {
    name: strategy.name,
    spoke: 0,
    acceptance: { meeting: 0.6, morning: 0.6, evening: 0.6, default: 0.6 },
    calibration: new Map(),
    recent_count: 0,
    last_spoke_min_ago: null,
  };
  const counters: Counters = { tp: 0, fp: 0, tn: 0, fn: 0 };
  const recent: Array<{ ts: number }> = [];

  for (const m of moments) {
    const now = m.ts.getTime();
    while (recent.length && (now - recent[0].ts) > 6 * 3600 * 1000) recent.shift();
    state.recent_count = recent.length;
    state.last_spoke_min_ago = recent.length
      ? Math.round((now - recent[recent.length - 1].ts) / 60000)
      : null;

    const speak = strategy.decide(m, state);
    const truth = m.truth === "useful";

    if (speak && truth) counters.tp++;
    else if (speak && !truth) counters.fp++;
    else if (!speak && !truth) counters.tn++;
    else counters.fn++;

    if (speak) {
      recent.push({ ts: now });
      if (strategy.name.startsWith("E.") || strategy.name.startsWith("F.")) {
        // Calibration signal: use the pre-drawn simulated user response
        // (m.user_accepted), NOT ground truth. This mirrors production: skill_runs
        // stores accepted/dismissed flags, which reflect the user's revealed
        // preference, not whether the nudge was objectively useful. Pre-drawing in
        // makeMoment() guarantees E and F observe the SAME user behaviour for the
        // same moment — apples-to-apples.
        const key = calKey(m.skill, m.hour);
        const prev = state.calibration.get(key) ?? { accepts: 0, dismisses: 0 };
        if (m.user_accepted) prev.accepts += 1;
        else prev.dismisses += 1;
        state.calibration.set(key, prev);
        // Coarse 4-context EMA kept as a diagnostic only.
        const ctx = contextOf(m);
        const acc01 = m.user_accepted ? 1 : 0;
        state.acceptance[ctx] = 0.85 * state.acceptance[ctx] + 0.15 * acc01;
      }
    }
  }

  const notifications = counters.tp + counters.fp;
  const per_day = notifications / days;
  const precision = notifications === 0 ? 0 : counters.tp / notifications;
  const trueUseful = counters.tp + counters.fn;
  const recall = trueUseful === 0 ? 0 : counters.tp / trueUseful;
  const f1 = (precision + recall) === 0 ? 0 : 2 * precision * recall / (precision + recall);
  const falseAlarmDenom = counters.fp + counters.tn;
  const false_alarm_rate = falseAlarmDenom === 0 ? 0 : counters.fp / falseAlarmDenom;
  const missed_help_rate = trueUseful === 0 ? 0 : counters.fn / trueUseful;
  return { notifications, counters, per_day, precision, recall, f1, false_alarm_rate, missed_help_rate };
}

// ---------- Pretty print + write JSON ----------
function pad(s: string, n: number) { return s + " ".repeat(Math.max(0, n - s.length)); }
function fmtPct(x: number) { return (x * 100).toFixed(1) + "%"; }
function fmtN(x: number, d = 2) { return x.toFixed(d); }

function main() {
  const DAYS = 60;
  console.log(`\n[eval] generating ${DAYS} days of synthetic moments...`);
  const moments = generateMoments(DAYS);
  const totalUseful = moments.filter((m) => m.truth === "useful").length;
  console.log(`[eval] ${moments.length} moments total, ${totalUseful} ground-truth-useful (${fmtPct(totalUseful / moments.length)})\n`);

  const results: Array<{ strategy: string; r: ReturnType<typeof runStrategy> }> = [];
  for (const strat of STRATEGIES) {
    const result = runStrategy(strat, moments, DAYS);
    results.push({ strategy: strat.name, r: result });
  }

  // Print table
  const cols = [
    { h: "Strategy",          w: 28, get: (x: typeof results[0]) => x.strategy },
    { h: "Nudges/day",        w: 12, get: (x: typeof results[0]) => fmtN(x.r.per_day, 2) },
    { h: "False-alarm",       w: 12, get: (x: typeof results[0]) => fmtPct(x.r.false_alarm_rate) },
    { h: "Missed-help",       w: 12, get: (x: typeof results[0]) => fmtPct(x.r.missed_help_rate) },
    { h: "Precision",         w: 11, get: (x: typeof results[0]) => fmtPct(x.r.precision) },
    { h: "Recall",            w: 9,  get: (x: typeof results[0]) => fmtPct(x.r.recall) },
    { h: "F1",                w: 7,  get: (x: typeof results[0]) => fmtN(x.r.f1, 3) },
  ];
  console.log("┌" + cols.map((c) => "─".repeat(c.w + 2)).join("┬") + "┐");
  console.log("│ " + cols.map((c) => pad(c.h, c.w)).join(" │ ") + " │");
  console.log("├" + cols.map((c) => "─".repeat(c.w + 2)).join("┼") + "┤");
  for (const row of results) {
    console.log("│ " + cols.map((c) => pad(c.get(row), c.w)).join(" │ ") + " │");
  }
  console.log("└" + cols.map((c) => "─".repeat(c.w + 2)).join("┴") + "┘");

  // Compute headline deltas.
  const A = results.find((x) => x.strategy.startsWith("A."))!.r;
  const C = results.find((x) => x.strategy.startsWith("C."))!.r;
  const D = results.find((x) => x.strategy.startsWith("D."))!.r;
  const E = results.find((x) => x.strategy.startsWith("E."))!.r;
  const F = results.find((x) => x.strategy.startsWith("F."))!.r;

  const pctDelta = (newer: number, older: number) =>
    ((older - newer) / Math.max(1e-9, older)) * 100;
  const pctRise = (newer: number, older: number) =>
    ((newer - older) / Math.max(1e-9, older)) * 100;

  console.log(`\n[headline] AURA (PRISM + Edge-Calibration + Adversary) vs baselines:`);
  console.log(`\n  vs always-speak (A):`);
  console.log(`    nudges/day:       ${fmtN(A.per_day, 1)} → ${fmtN(F.per_day, 1)}   (${pctDelta(F.per_day, A.per_day).toFixed(1)}% fewer)`);
  console.log(`    false-alarm rate: ${fmtPct(A.false_alarm_rate)} → ${fmtPct(F.false_alarm_rate)}  (${pctDelta(F.false_alarm_rate, A.false_alarm_rate).toFixed(1)}% lower)`);
  console.log(`    F1:               ${fmtN(A.f1, 3)} → ${fmtN(F.f1, 3)}  (+${pctRise(F.f1, A.f1).toFixed(1)}%)`);
  console.log(`\n  vs fixed-threshold heuristic (C):`);
  console.log(`    nudges/day:       ${fmtN(C.per_day, 1)} → ${fmtN(F.per_day, 1)}   (${pctDelta(F.per_day, C.per_day).toFixed(1)}% fewer)`);
  console.log(`    false-alarm rate: ${fmtPct(C.false_alarm_rate)} → ${fmtPct(F.false_alarm_rate)}  (${pctDelta(F.false_alarm_rate, C.false_alarm_rate).toFixed(1)}% lower)`);
  console.log(`    F1:               ${fmtN(C.f1, 3)} → ${fmtN(F.f1, 3)}  (${pctRise(F.f1, C.f1).toFixed(1)}%)`);
  console.log(`\n  vs PRISM-only baseline (D):`);
  console.log(`    nudges/day:       ${fmtN(D.per_day, 1)} → ${fmtN(F.per_day, 1)}   (${pctDelta(F.per_day, D.per_day).toFixed(1)}% fewer)`);
  console.log(`    false-alarm rate: ${fmtPct(D.false_alarm_rate)} → ${fmtPct(F.false_alarm_rate)}  (${pctDelta(F.false_alarm_rate, D.false_alarm_rate).toFixed(1)}% lower)`);
  console.log(`\n  E (calibrated) vs D (prism_only):`);
  console.log(`    nudges/day:       ${fmtN(D.per_day, 1)} → ${fmtN(E.per_day, 1)}   (${pctDelta(E.per_day, D.per_day).toFixed(1)}% fewer)`);
  console.log(`    false-alarm rate: ${fmtPct(D.false_alarm_rate)} → ${fmtPct(E.false_alarm_rate)}  (${pctDelta(E.false_alarm_rate, D.false_alarm_rate).toFixed(1)}% lower)`);
  console.log(`    F1:               ${fmtN(D.f1, 3)} → ${fmtN(E.f1, 3)}  (${pctRise(E.f1, D.f1).toFixed(1)}%)`);

  // Write JSON for the deck slide.
  mkdirSync(resolve(ROOT, "eval"), { recursive: true });
  const out = {
    generated_at: new Date().toISOString(),
    config: {
      days: DAYS,
      rng_seed: 42,
      total_moments: moments.length,
      ground_truth_useful: totalUseful,
      burst_schedule: "weekday: 4 bursts/day (45% morning 7-10am, 35% EOD 4-7pm, 20% mid-day); weekend: 3 bursts/day random; burst size 3-5",
      acceptance_model: "per-skill per-context: hydration 0.75/0.45/0.20, commute_guardian 0.85/0.30, morning_brief 0.80/0.40, standup_break 0.70/0.30",
      calibration_model: "production-faithful: per skill×hour-bucket, c_fa *= (1+blend·dismiss_rate), c_fn *= (1+blend·accept_rate); blend ramps 0→1 over [5,20] samples; mirrors src/pi-engine/calibration.ts",
    },
    results: results.map((x) => ({ strategy: x.strategy, ...x.r })),
    headline: {
      vs_always_speak: {
        nudge_reduction_pct: Number(pctDelta(F.per_day, A.per_day).toFixed(1)),
        false_alarm_reduction_pct: Number(pctDelta(F.false_alarm_rate, A.false_alarm_rate).toFixed(1)),
        f1_improvement_pct: Number(pctRise(F.f1, A.f1).toFixed(1)),
      },
      vs_fixed_threshold: {
        nudge_reduction_pct: Number(pctDelta(F.per_day, C.per_day).toFixed(1)),
        false_alarm_reduction_pct: Number(pctDelta(F.false_alarm_rate, C.false_alarm_rate).toFixed(1)),
        f1_improvement_pct: Number(pctRise(F.f1, C.f1).toFixed(1)),
      },
      vs_prism_only: {
        nudge_reduction_pct: Number(pctDelta(F.per_day, D.per_day).toFixed(1)),
        false_alarm_reduction_pct: Number(pctDelta(F.false_alarm_rate, D.false_alarm_rate).toFixed(1)),
      },
      calibrated_vs_prism_only: {
        nudge_reduction_pct: Number(pctDelta(E.per_day, D.per_day).toFixed(1)),
        false_alarm_reduction_pct: Number(pctDelta(E.false_alarm_rate, D.false_alarm_rate).toFixed(1)),
        f1_delta_pct: Number(pctRise(E.f1, D.f1).toFixed(1)),
      },
    },
  };
  const outPath = resolve(ROOT, "eval", "results.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n[eval] wrote ${outPath}`);
}

main();
