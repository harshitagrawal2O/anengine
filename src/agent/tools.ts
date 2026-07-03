// ── Tool registry — the agent's "hands" ─────────────────────────────────────
//
// Each Tool wraps an existing AURA capability (a gateway, a skill, or a DB op)
// behind a uniform {name, description, params, run} contract so the local-Llama
// agent loop can discover and call it. New capabilities — device control, web
// RAG, controlling other machines on the network — slot in here as more tools
// without touching the loop.
//
// Every tool call is HMAC-audit-logged, so the agent is fully traceable: you can
// replay exactly what the brain decided to do and why.

import { db, recordEvent, isShuttingDown } from "../db.js";
import { append as auditAppend } from "../audit/log.js";
import { computeScore } from "../score/compute.js";
import { getWeather } from "../gateway/weather.js";
import { wikiSummary, defineWord, tellJoke } from "../gateway/lookup.js";
import { webSearch, openApp, openUrl } from "../gateway/actions.js";
import {
  setVolume,
  adjustVolume,
  muteVolume,
  unmuteVolume,
  lockScreen,
  takeScreenshot,
} from "../gateway/system.js";
import { speakWithRetry } from "../gateway/voice.js";
import * as morningBrief from "../skills/morning_brief/index.js";
import type { Lang } from "../i18n.js";
import { planBrain } from "./host.js";

export type ToolParam = {
  type: "string" | "number" | "boolean";
  description: string;
  required?: boolean;
};

export type ToolResult = { ok: boolean; summary: string; data?: unknown };

export type ToolContext = { lang: Lang };

export type Tool = {
  name: string;
  description: string;
  params: Record<string, ToolParam>;
  /** Pure reads are false; anything that changes the world / device is true. */
  sideEffect: boolean;
  /** Sensitive actions (lock, screenshot, run app) — surfaced for confirmation policies. */
  sensitive?: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
};

// ── helpers ──────────────────────────────────────────────────────────────────

function str(args: Record<string, unknown>, key: string, fallback = ""): string {
  const v = args[key];
  return typeof v === "string" ? v : v == null ? fallback : String(v);
}
function num(args: Record<string, unknown>, key: string, fallback = 0): number {
  const v = Number(args[key]);
  return Number.isFinite(v) ? v : fallback;
}

function scheduleTimer(label: string, minutes: number): void {
  const end = new Date(Date.now() + minutes * 60 * 1000);
  const res = db.prepare("INSERT INTO timers (label, end_ts, fired) VALUES (?, ?, 0)").run(label, end.toISOString());
  const id = Number(res.lastInsertRowid);
  setTimeout(
    async () => {
      if (isShuttingDown()) return;
      const spoken = await speakWithRetry(`Timer up: ${label}.`);
      db.prepare("UPDATE timers SET fired = 1 WHERE id = ?").run(id);
      recordEvent("timer_fired", { label, minutes, spoken: spoken.spoken });
      auditAppend("timer_fired", { label, minutes });
    },
    Math.max(0, minutes * 60 * 1000),
  );
}

// ── the tools ──────────────────────────────────────────────────────────────

export const TOOLS: Tool[] = [
  {
    name: "get_status",
    description: "Get the user's current day-readiness score, next calendar event, and recent context.",
    params: {},
    sideEffect: false,
    run: () => {
      const s = computeScore();
      const next = db
        .prepare("SELECT title, start_ts FROM calendar WHERE start_ts > ? ORDER BY start_ts ASC LIMIT 1")
        .get(new Date().toISOString()) as { title: string; start_ts: string } | undefined;
      const nextMin = next ? Math.round((new Date(next.start_ts).getTime() - Date.now()) / 60000) : null;
      return {
        ok: true,
        summary: `Readiness ${s.total}/100.${next ? ` Next: ${next.title} in ${nextMin} min.` : " No upcoming events."}`,
        data: { score: s.total, components: s.components, next_event: next?.title ?? null, next_event_min: nextMin },
      };
    },
  },
  {
    name: "get_weather",
    description: "Get the current local weather (temperature).",
    params: {},
    sideEffect: false,
    run: async () => {
      const w = await getWeather();
      return { ok: true, summary: `It's ${Math.round(w.temp_c)}°C.`, data: w };
    },
  },
  {
    name: "wikipedia",
    description: "Look up a factual summary of a topic, person, or thing from Wikipedia.",
    params: { topic: { type: "string", description: "What to look up", required: true } },
    sideEffect: false,
    run: async (args) => {
      const r = await wikiSummary(str(args, "topic"));
      return { ok: r.ok, summary: r.ok ? r.text : "No Wikipedia article found.", data: r };
    },
  },
  {
    name: "define",
    description: "Get the dictionary definition of a single word.",
    params: { word: { type: "string", description: "The word to define", required: true } },
    sideEffect: false,
    run: async (args) => {
      const r = await defineWord(str(args, "word").split(/\s+/)[0]);
      return { ok: true, summary: r.text, data: r };
    },
  },
  {
    name: "tell_joke",
    description: "Fetch a short joke to lighten the mood.",
    params: {},
    sideEffect: false,
    run: async () => {
      const r = await tellJoke();
      return { ok: true, summary: r.text };
    },
  },
  {
    name: "web_search",
    description: "Open a web search for a query when the answer isn't known locally.",
    params: { query: { type: "string", description: "The search query", required: true } },
    sideEffect: true,
    run: (args) => {
      const r = webSearch(str(args, "query"));
      return { ok: r.ok, summary: r.message, data: r };
    },
  },
  {
    name: "set_timer",
    description: "Start a countdown timer that speaks aloud when it finishes.",
    params: {
      minutes: { type: "number", description: "Duration in minutes", required: true },
      label: { type: "string", description: "Optional name for the timer" },
    },
    sideEffect: true,
    run: (args) => {
      const minutes = num(args, "minutes", 0);
      if (minutes <= 0) return { ok: false, summary: "Need a positive duration in minutes." };
      const label = str(args, "label", "timer") || "timer";
      scheduleTimer(label, minutes);
      return { ok: true, summary: `Timer set for ${minutes} min${label !== "timer" ? ` (${label})` : ""}.` };
    },
  },
  {
    name: "save_note",
    description: "Save a note or reminder for the user.",
    params: { text: { type: "string", description: "The note body", required: true } },
    sideEffect: true,
    run: (args) => {
      const body = str(args, "text");
      if (!body) return { ok: false, summary: "Nothing to save." };
      db.prepare("INSERT INTO notes (ts, body) VALUES (?, ?)").run(new Date().toISOString(), body);
      return { ok: true, summary: `Noted: ${body}.` };
    },
  },
  {
    name: "list_notes",
    description: "List the user's most recent saved notes.",
    params: {},
    sideEffect: false,
    run: () => {
      const rows = db.prepare("SELECT body FROM notes ORDER BY id DESC LIMIT 5").all() as Array<{ body: string }>;
      return {
        ok: true,
        summary: rows.length ? rows.map((r, i) => `${i + 1}. ${r.body}`).join("; ") : "No notes yet.",
        data: rows,
      };
    },
  },
  {
    name: "add_calendar_event",
    description: "Add an event to the user's calendar a given number of minutes from now.",
    params: {
      title: { type: "string", description: "Event title", required: true },
      in_minutes: { type: "number", description: "Minutes from now until the event starts", required: true },
    },
    sideEffect: true,
    run: (args) => {
      const title = str(args, "title");
      const inMin = num(args, "in_minutes", 0);
      if (!title) return { ok: false, summary: "Need an event title." };
      const start = new Date(Date.now() + inMin * 60000);
      const end = new Date(start.getTime() + 3600000);
      db.prepare("INSERT INTO calendar (start_ts, end_ts, title, location) VALUES (?, ?, ?, ?)").run(
        start.toISOString(),
        end.toISOString(),
        title,
        "",
      );
      return { ok: true, summary: `Scheduled "${title}" in ${inMin} min.` };
    },
  },
  {
    name: "set_volume",
    description: "Set the system audio volume to a specific level (0-100).",
    params: { level: { type: "number", description: "Volume 0-100", required: true } },
    sideEffect: true,
    sensitive: true,
    run: (args) => {
      const r = setVolume(num(args, "level", 50));
      return { ok: true, summary: `Volume set to ${r.pct}.`, data: r };
    },
  },
  {
    name: "adjust_volume",
    description: "Raise or lower the system volume by a delta (e.g. +15 or -15).",
    params: { delta: { type: "number", description: "Amount to change, e.g. 15 or -15", required: true } },
    sideEffect: true,
    sensitive: true,
    run: (args) => {
      const r = adjustVolume(num(args, "delta", 0));
      return { ok: true, summary: `Volume ${r.pct}.`, data: r };
    },
  },
  {
    name: "mute_audio",
    description: "Mute the system audio.",
    params: {},
    sideEffect: true,
    sensitive: true,
    run: () => {
      muteVolume();
      return { ok: true, summary: "Muted." };
    },
  },
  {
    name: "unmute_audio",
    description: "Unmute the system audio.",
    params: {},
    sideEffect: true,
    sensitive: true,
    run: () => {
      unmuteVolume();
      return { ok: true, summary: "Unmuted." };
    },
  },
  {
    name: "lock_screen",
    description: "Lock the computer screen.",
    params: {},
    sideEffect: true,
    sensitive: true,
    run: () => {
      lockScreen();
      return { ok: true, summary: "Locking the screen." };
    },
  },
  {
    name: "take_screenshot",
    description: "Take a screenshot of the screen.",
    params: {},
    sideEffect: true,
    sensitive: true,
    run: () => {
      const r = takeScreenshot();
      return { ok: r.ok, summary: r.ok ? "Screenshot taken." : "Couldn't take a screenshot." };
    },
  },
  {
    name: "open_app",
    description: "Open a desktop application by name (e.g. spotify, chrome, notion).",
    params: { name: { type: "string", description: "Application name", required: true } },
    sideEffect: true,
    sensitive: true,
    run: (args) => {
      const r = openApp(str(args, "name"));
      return { ok: r.ok, summary: r.message, data: r };
    },
  },
  {
    name: "open_url",
    description: "Open a URL in the browser.",
    params: { url: { type: "string", description: "The URL to open", required: true } },
    sideEffect: true,
    sensitive: true,
    run: (args) => {
      const r = openUrl(str(args, "url"));
      return { ok: r.ok, summary: r.message, data: r };
    },
  },
  {
    name: "run_morning_brief",
    description: "Generate and deliver the user's morning brief (agenda + readiness).",
    params: {},
    sideEffect: true,
    run: async (_args, ctx) => {
      const r = await morningBrief.run({ dry_run: false, lang: ctx.lang });
      return { ok: true, summary: r.message?.text ?? "Nothing new to report." };
    },
  },
  {
    name: "get_host_info",
    description: "Report what hardware and local model AURA's brain is running on.",
    params: {},
    sideEffect: false,
    run: () => {
      const { host, plan } = planBrain(process.env.OLLAMA_MODEL);
      return {
        ok: true,
        summary: `Running ${plan.model} (${plan.tier} tier) on ${host.cpu_model}, ${host.total_ram_gb}GB RAM, GPU: ${host.gpu.name}.`,
        data: { host, plan },
      };
    },
  },
];

export const TOOL_MAP: Map<string, Tool> = new Map(TOOLS.map((t) => [t.name, t]));

/** Execute a tool by name, audit-logging the call and its result. */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = TOOL_MAP.get(name);
  if (!tool) {
    auditAppend("agent_tool_unknown", { name, args });
    return { ok: false, summary: `Unknown tool: ${name}.` };
  }
  try {
    const result = await tool.run(args, ctx);
    auditAppend("agent_tool_call", { name, args, side_effect: tool.sideEffect, ok: result.ok, summary: result.summary });
    return result;
  } catch (e) {
    const summary = `Tool ${name} failed: ${(e as Error).message}`;
    auditAppend("agent_tool_error", { name, args, error: (e as Error).message });
    return { ok: false, summary };
  }
}

/** Compact tool catalogue for injection into the planner prompt. */
export function toolCatalogue(): string {
  return TOOLS.map((t) => {
    const params = Object.entries(t.params)
      .map(([k, p]) => `${k}${p.required ? "" : "?"}:${p.type}`)
      .join(", ");
    return `- ${t.name}(${params}) — ${t.description}`;
  }).join("\n");
}
