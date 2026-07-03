/*
 * Narration substitution mechanism
 * ─────────────────────────────────
 * Before the demo loop starts, prefetchGateValues() seeds `liveValues` by running
 * meeting_reminder in dry-run mode with a temporary calendar event (same context
 * the demo creates: Investor pitch, 3 min away).  Every "say" step calls
 * substitute() which replaces {placeholder} tokens with the captured values before
 * the text is spoken or recorded.
 *
 * Probabilities are formatted to 2 decimal places; scores to integers.
 * If a live value cannot be computed (gate returned zeroes), a range expression
 * ("in the high range") is substituted and a warning is logged.
 *
 * SIMULATION_CONSTANTS is populated at module load from eval/results.json so that
 * research-derived claims in the narration ({false_alarm_reduction_vs_always_speak},
 * {nudges_per_day_aura}, etc.) always reflect the most recent eval run rather than
 * a hardcoded guess.  If the file is missing or malformed, DEFAULT_FALLBACKS (equal
 * to the last committed eval values) are used and a warning is printed.
 *
 * After the demo, printComparisonReport() reads the first real (non-dry-run)
 * gate_decision entry written for meeting_reminder during the run and prints a
 * MATCH / MISMATCH row for each narrated numeric field, letting a judge verify
 * that narrated numbers came from the live gate.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../config.js";
import { db, recordEvent } from "../db.js";
import { speak } from "../gateway/voice.js";
import { append as auditAppend } from "../audit/log.js";
import { learnAndPersist } from "../twin/learn.js";
import { computeScore } from "../score/compute.js";
import * as morningBrief from "../skills/morning_brief/index.js";
import * as commuteGuardian from "../skills/commute_guardian/index.js";
import * as meetingReminder from "../skills/meeting_reminder/index.js";
import { DEMO_SCRIPT, type DemoStep } from "./script.js";

// ── Eval-derived constants ────────────────────────────────────────────────────

/**
 * Known-good fallback values matching the last committed eval/results.json.
 * Used when the file is missing or cannot be parsed; values are identical to
 * what would be loaded from the file, so demo behaviour is unchanged.
 * Update this object whenever the committed eval results change significantly.
 */
const DEFAULT_FALLBACKS: Record<string, string> = {
  false_alarm_reduction_vs_always_speak:    "91",  // 91.1 % → rounded
  false_alarm_reduction_vs_fixed_threshold: "60",  // 59.7 % → rounded
  nudges_per_day_aura:                       "6",  // 5.82  → rounded
  nudges_per_day_always_speak:              "47",  // 46.60 → rounded
  f1_improvement_pct_vs_always_speak:      "101",  // 100.8 % → rounded
};

// Range-expression fallbacks used when a SPECIFIC key is absent inside a valid
// results.json (e.g., a strategy was removed).  Chosen to read naturally before
// "percent" in the narration template so no grammatical patch is needed.
const RANGE_EXPRESSIONS: Record<string, string> = {
  false_alarm_reduction_vs_always_speak:    "over 85",
  false_alarm_reduction_vs_fixed_threshold: "over 55",
  nudges_per_day_aura:                      "around 6",
  nudges_per_day_always_speak:              "around 41",
  f1_improvement_pct_vs_always_speak:       "over 100",
};

type EvalJson = {
  generated_at?: string;
  headline: {
    vs_always_speak?: { false_alarm_reduction_pct?: number; f1_improvement_pct?: number };
    vs_fixed_threshold?: { false_alarm_reduction_pct?: number };
  };
  results?: Array<{ strategy: string; per_day: number }>;
};

function safeRound(val: unknown, key: string): string {
  if (typeof val === "number" && isFinite(val)) return String(Math.round(val));
  console.warn(`[demo] eval/results.json: '${key}' missing or non-numeric — using range expression`);
  return RANGE_EXPRESSIONS[key] ?? DEFAULT_FALLBACKS[key] ?? "unknown";
}

/**
 * Read eval/results.json once at module load and return integer-rounded string
 * values for all narration placeholders that come from the eval harness.
 * Falls back to DEFAULT_FALLBACKS if the file is absent or malformed.
 */
function readEvalConstants(): Record<string, string> {
  const evalPath = resolve(ROOT, "eval", "results.json");
  let raw: string;
  let mtime: string;
  try {
    raw = readFileSync(evalPath, "utf-8");
    mtime = statSync(evalPath).mtime.toISOString();
  } catch {
    console.warn(
      "[demo] WARNING: eval/results.json missing — narration using fallback constants. " +
      "Run `npm run eval` to refresh.",
    );
    return { ...DEFAULT_FALLBACKS };
  }

  let json: EvalJson;
  try {
    json = JSON.parse(raw) as EvalJson;
  } catch (e) {
    console.warn(
      `[demo] WARNING: eval/results.json is malformed — narration using fallback constants. ` +
      `Run \`npm run eval\` to refresh. (${(e as Error).message})`,
    );
    return { ...DEFAULT_FALLBACKS };
  }

  const rowA = json.results?.find((r) => r.strategy.startsWith("A."));
  const rowF = json.results?.find((r) => r.strategy.startsWith("F."));

  const vals: Record<string, string> = {
    false_alarm_reduction_vs_always_speak:
      safeRound(json.headline?.vs_always_speak?.false_alarm_reduction_pct,
                "false_alarm_reduction_vs_always_speak"),
    false_alarm_reduction_vs_fixed_threshold:
      safeRound(json.headline?.vs_fixed_threshold?.false_alarm_reduction_pct,
                "false_alarm_reduction_vs_fixed_threshold"),
    nudges_per_day_aura:
      safeRound(rowF?.per_day, "nudges_per_day_aura"),
    nudges_per_day_always_speak:
      safeRound(rowA?.per_day, "nudges_per_day_always_speak"),
    f1_improvement_pct_vs_always_speak:
      safeRound(json.headline?.vs_always_speak?.f1_improvement_pct,
                "f1_improvement_pct_vs_always_speak"),
  };

  const ts = json.generated_at ?? mtime;
  console.log(`[demo] Demo constants loaded from eval/results.json (last run: ${ts})`);
  console.log("[demo] Eval-derived constants:");
  for (const [k, v] of Object.entries(vals)) {
    console.log(`  ${k.padEnd(44)}: ${v}`);
  }

  return vals;
}

// Loaded once at module import.  Restart the server (or re-import) to pick up
// new eval results after running `npm run eval`.
const SIMULATION_CONSTANTS: Record<string, string> = readEvalConstants();

// ── Substitution ──────────────────────────────────────────────────────────────

type LiveValues = Record<string, string>;

const RANGE_FALLBACK = "in the high range";

// Populated by prefetchGateValues() before the demo loop starts; reset each run.
let liveValues: LiveValues = { ...SIMULATION_CONSTANTS };

/** Replace {key} tokens in narration text with values from liveValues. */
function substitute(text: string): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (key in liveValues) return liveValues[key];
    console.warn(`[demo] No live value for placeholder {${key}} — leaving as-is`);
    return match;
  });
}

// ── Pre-fetch gate values ─────────────────────────────────────────────────────

/**
 * Run meeting_reminder in dry-run mode with a temporary calendar event that
 * mirrors what the demo will add (Investor pitch, 3 min away).  Captures the
 * live GateDecision fields and stores them in liveValues so narration
 * placeholders resolve to real numbers.  The temp event is deleted in all cases.
 */
async function prefetchGateValues(): Promise<void> {
  const TEMP_TITLE = "__AURA_DEMO_PREFETCH__";
  const startTs = new Date(Date.now() + 3 * 60 * 1000).toISOString();
  const endTs = new Date(Date.now() + 33 * 60 * 1000).toISOString();
  db.prepare(
    "INSERT INTO calendar (start_ts, end_ts, title, location) VALUES (?, ?, ?, ?)",
  ).run(startTs, endTs, TEMP_TITLE, "Demo");

  try {
    const result = await meetingReminder.run({ dry_run: true });
    const d = result.decision;
    const score = computeScore();

    if (d.p_need === 0 && d.p_accept === 0) {
      // Gate returned an early-exit decision (no event on deck or outside window).
      console.warn("[demo] Gate dry-run returned zeroes; using range expressions in narration.");
      liveValues = {
        ...SIMULATION_CONSTANTS,
        p_need: RANGE_FALLBACK,
        p_accept: RANGE_FALLBACK,
        c_fa: RANGE_FALLBACK,
        c_fn: RANGE_FALLBACK,
        threshold: RANGE_FALLBACK,
        crs_score: RANGE_FALLBACK,
      };
    } else {
      liveValues = {
        ...SIMULATION_CONSTANTS,
        p_need: d.p_need.toFixed(2),
        p_accept: d.p_accept.toFixed(2),
        c_fa: d.c_fa.toFixed(2),
        c_fn: d.c_fn.toFixed(2),
        threshold: d.tau.toFixed(2),
        crs_score: String(score.total),
      };
    }
  } catch (err) {
    console.warn("[demo] prefetchGateValues failed:", err);
    liveValues = {
      ...SIMULATION_CONSTANTS,
      p_need: RANGE_FALLBACK,
      p_accept: RANGE_FALLBACK,
      c_fa: RANGE_FALLBACK,
      c_fn: RANGE_FALLBACK,
      threshold: RANGE_FALLBACK,
      crs_score: RANGE_FALLBACK,
    };
  } finally {
    db.prepare("DELETE FROM calendar WHERE title = ?").run(TEMP_TITLE);
  }
}

// ── Comparison report ─────────────────────────────────────────────────────────

/**
 * After the demo completes, find the first real (non-dry-run) gate_decision for
 * meeting_reminder written after sinceId, then print a MATCH / MISMATCH table
 * comparing narrated values against the audit log entry.
 */
function printComparisonReport(narratedValues: LiveValues, sinceId: number): void {
  const rows = db
    .prepare(
      "SELECT id, payload FROM audit_log WHERE id > ? AND kind = 'gate_decision' ORDER BY id ASC",
    )
    .all(sinceId) as Array<{ id: number; payload: string }>;

  let auditPayload: Record<string, unknown> | null = null;
  for (const row of rows) {
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    if (p.skill === "meeting_reminder" && !p.dry_run) {
      auditPayload = p;
      break;
    }
  }

  const bar = "─".repeat(66);
  console.log(`\n${bar}`);
  console.log("Demo narration vs. audit log — live gate value comparison");
  console.log(bar);

  if (!auditPayload) {
    console.log("  No real gate_decision for meeting_reminder found after demo start.");
    console.log(`${bar}\n`);
    return;
  }

  const checks: Array<[string, string, unknown]> = [
    ["p_need",    narratedValues.p_need,    auditPayload.p_need],
    ["p_accept",  narratedValues.p_accept,  auditPayload.p_accept],
    ["threshold", narratedValues.threshold, auditPayload.threshold],
    ["c_fa",      narratedValues.c_fa,      auditPayload.c_fa],
    ["c_fn",      narratedValues.c_fn,      auditPayload.c_fn],
  ];

  for (const [name, narrated, auditRaw] of checks) {
    if (narrated === RANGE_FALLBACK) {
      console.log(`  ${name.padEnd(10)}: narrated as range (no live data) | Audit: ${auditRaw} | SKIPPED`);
      continue;
    }
    const auditStr =
      typeof auditRaw === "number" ? auditRaw.toFixed(2) : String(auditRaw ?? "N/A");
    const verdict = narrated === auditStr ? "MATCH" : "MISMATCH";
    console.log(`  ${name.padEnd(10)}: Narrated ${narrated} | Audit ${auditStr} | ${verdict}`);
  }

  console.log(`${bar}\n`);
}

// ── Demo status ───────────────────────────────────────────────────────────────

type Status = {
  running: boolean;
  step_index: number;
  total_steps: number;
  phase: string;
  highlight: string | null;
  highlight_label: string | null;
  started_at: string | null;
  finished_at: string | null;
};

const status: Status = {
  running: false,
  step_index: -1,
  total_steps: 0,
  phase: "idle",
  highlight: null,
  highlight_label: null,
  started_at: null,
  finished_at: null,
};

let abortRequested = false;

// ── Step helpers ──────────────────────────────────────────────────────────────

function recordNarration(text: string): number {
  const ts = new Date().toISOString();
  const ins = db
    .prepare("INSERT INTO skill_runs (ts, skill, accepted, dismissed, payload) VALUES (?, ?, ?, ?, ?)")
    .run(ts, "demo", null, null, JSON.stringify({ text, demo: true }));
  recordEvent("demo_narration", { text });
  return Number(ins.lastInsertRowid);
}

function clearEvents(matching?: string): number {
  const stmt = matching
    ? db.prepare("DELETE FROM calendar WHERE title LIKE ?")
    : db.prepare("DELETE FROM calendar");
  const r = matching ? stmt.run(`%${matching}%`) : stmt.run();
  return Number(r.changes);
}

function addEvent(title: string, minutesFromNow: number, durationMin = 30): void {
  const start = new Date(Date.now() + minutesFromNow * 60 * 1000);
  const end = new Date(start.getTime() + durationMin * 60 * 1000);
  db.prepare(
    "INSERT INTO calendar (start_ts, end_ts, title, location) VALUES (?, ?, ?, ?)",
  ).run(start.toISOString(), end.toISOString(), title, "Demo");
}

function lastSkillRunId(skill: string): number | null {
  const row = db
    .prepare("SELECT id FROM skill_runs WHERE skill = ? ORDER BY id DESC LIMIT 1")
    .get(skill) as { id: number } | undefined;
  return row?.id ?? null;
}

function applyFeedback(skill: string, action: "accept" | "dismiss"): void {
  const id = lastSkillRunId(skill);
  if (!id) return;
  db.prepare("UPDATE skill_runs SET accepted = ?, dismissed = ? WHERE id = ?").run(
    action === "accept" ? 1 : 0,
    action === "dismiss" ? 1 : 0,
    id,
  );
  auditAppend("user_feedback", { skill_run_id: id, action, source: "demo" });
  learnAndPersist();
}

// ── Step runner ───────────────────────────────────────────────────────────────

async function runStep(step: DemoStep): Promise<void> {
  switch (step.kind) {
    case "say": {
      // Substitute live gate values and eval-derived constants into {placeholder} tokens.
      const text = substitute(step.text);
      recordNarration(text);
      speak(text);
      // Estimated speech duration: ~75 ms/char + a small base + the configured pause.
      const speechMs = Math.min(12000, 800 + text.length * 75);
      await sleep(speechMs + (step.pauseMs ?? 0));
      break;
    }
    case "wait":
      await sleep(step.ms);
      break;
    case "add_event":
      addEvent(step.title, step.minutesFromNow, step.durationMin ?? 30);
      auditAppend("demo_action", { kind: "add_event", title: step.title });
      break;
    case "clear_events":
      clearEvents(step.matching);
      auditAppend("demo_action", { kind: "clear_events", matching: step.matching });
      break;
    case "trigger": {
      auditAppend("demo_action", { kind: "trigger", skill: step.skill });
      const runner =
        step.skill === "morning_brief"
          ? morningBrief.run
          : step.skill === "commute_guardian"
            ? commuteGuardian.run
            : meetingReminder.run;
      await runner({ dry_run: false });
      break;
    }
    case "feedback":
      applyFeedback(step.lastSkill, step.action);
      break;
    case "highlight":
      status.highlight = step.section;
      status.highlight_label = step.label ?? null;
      break;
    case "set_phase":
      status.phase = step.phase;
      status.highlight = null;
      status.highlight_label = null;
      break;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function startDemo(): Promise<void> {
  if (status.running) return;
  abortRequested = false;
  status.running = true;
  status.step_index = -1;
  status.total_steps = DEMO_SCRIPT.length;
  status.phase = "starting";
  status.highlight = null;
  status.highlight_label = null;
  status.started_at = new Date().toISOString();
  status.finished_at = null;
  auditAppend("demo_start", { steps: DEMO_SCRIPT.length });

  // Reset substitution map for this run: eval constants + live gate values.
  liveValues = { ...SIMULATION_CONSTANTS };
  await prefetchGateValues();

  // Capture the last audit ID *after* the prefetch so the comparison report
  // only inspects entries written by the actual demo steps (not the dry-run).
  const sinceRow = db
    .prepare("SELECT id FROM audit_log ORDER BY id DESC LIMIT 1")
    .get() as { id: number } | undefined;
  const sinceId = sinceRow?.id ?? 0;

  // Snapshot the substituted values now; twin updates mid-demo won't affect comparison.
  const narratedSnapshot = { ...liveValues };

  for (let i = 0; i < DEMO_SCRIPT.length; i++) {
    if (abortRequested) {
      auditAppend("demo_abort", { at_step: i });
      break;
    }
    status.step_index = i;
    try {
      await runStep(DEMO_SCRIPT[i]);
    } catch (e) {
      auditAppend("demo_error", { at_step: i, error: (e as Error).message });
      console.error("[demo] step failed:", e);
    }
  }

  status.running = false;
  status.finished_at = new Date().toISOString();
  status.phase = "done";
  auditAppend("demo_end", {});

  printComparisonReport(narratedSnapshot, sinceId);
}

export function stopDemo(): void {
  abortRequested = true;
}

export function getDemoStatus(): Status {
  return { ...status };
}
