// Intent router — small keyword/regex classifier. Turns a free-text transcript
// into a structured action. No LLM needed for the MVP. Extend by adding handlers.

import { db, isShuttingDown, localDayBounds, recordEvent } from "../db.js";
import { computeScore } from "../score/compute.js";
import { getWeather } from "../gateway/weather.js";
import {
  openApp,
  openFile,
  openUrl,
  webSearch,
  SHORTCUTS,
  type ActionResult,
} from "../gateway/actions.js";
import {
  setVolume,
  adjustVolume,
  muteVolume,
  unmuteVolume,
  lockScreen,
  takeScreenshot,
} from "../gateway/system.js";
import { wikiSummary, defineWord, tellJoke } from "../gateway/lookup.js";
import { speakWithRetry } from "../gateway/voice.js";
import { narrate } from "../gateway/ollama.js";
import { config } from "../config.js";
import { append as auditAppend } from "../audit/log.js";
import * as morningBrief from "../skills/morning_brief/index.js";
import * as commuteGuardian from "../skills/commute_guardian/index.js";
import { type Lang } from "../i18n.js";
import { getSystemState, formatContextForLLM } from "./context.js";

const MAX_MEMORY = 5;

function getMemory(): Array<{ role: "user" | "aura"; text: string }> {
  const rows = db.prepare("SELECT role, text FROM chat_history ORDER BY ts DESC LIMIT ?")
    .all(MAX_MEMORY * 2) as Array<{ role: string; text: string }>;
  return rows.reverse().map(r => ({ role: r.role as "user" | "aura", text: r.text }));
}

function addToMemory(role: "user" | "aura", text: string) {
  db.prepare("INSERT INTO chat_history (ts, role, text) VALUES (?, ?, ?)")
    .run(new Date().toISOString(), role, text);
  // Keep the table clean: delete everything beyond the last 30 messages
  db.prepare("DELETE FROM chat_history WHERE id NOT IN (SELECT id FROM chat_history ORDER BY ts DESC LIMIT 30)").run();
}

export type IntentResult = {
  intent: string;
  reply: string;
  action?: ActionResult;
  side_effect?: Record<string, unknown>;
};

function strip(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(hey |ok |okay |hi |hello )?aura[,\s]*/i, "")
    .replace(/[.?!]$/g, "")
    .trim();
}
function clean(s: string): string {
  return s.replace(/(can you|could you|please|would you|i want to|i'd like to)\s+/g, "").trim();
}
function findShortcut(text: string): ActionResult | null {
  for (const key of Object.keys(SHORTCUTS).sort((a, b) => b.length - a.length)) {
    if (text.includes(key)) return SHORTCUTS[key]();
  }
  return null;
}
function ensureQuietBlock(minutes: number, reason: string): void {
  const start = new Date();
  const end = new Date(start.getTime() + minutes * 60 * 1000);
  db.prepare("INSERT INTO quiet_blocks (start_ts, end_ts, reason) VALUES (?, ?, ?)").run(
    start.toISOString(),
    end.toISOString(),
    reason,
  );
}
function pickReply(lang: Lang, en: string, hi: string, kn: string): string {
  return lang === "hi" ? hi : lang === "kn" ? kn : en;
}

// ---- Safe math evaluator (digits + ops only). Never use eval on raw input.
function safeEvalMath(expr: string): number | null {
  const cleaned = expr
    .replace(/\bplus\b/gi, "+")
    .replace(/\bminus\b/gi, "-")
    .replace(/\btimes\b|\bx\b|\bmultiplied by\b/gi, "*")
    .replace(/\bdivided by\b|\bover\b/gi, "/")
    .replace(/[^0-9+\-*/().\s]/g, "");
  if (!/[0-9]/.test(cleaned)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const n = Function(`"use strict";return (${cleaned})`)();
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ---- Timer scheduler (in-process)
function scheduleTimer(label: string, minutes: number): void {
  const end = new Date(Date.now() + minutes * 60 * 1000);
  const res = db
    .prepare("INSERT INTO timers (label, end_ts, fired) VALUES (?, ?, 0)")
    .run(
    label,
    end.toISOString(),
  );
  const timerId = Number(res.lastInsertRowid);
  setTimeout(async () => {
    if (isShuttingDown()) {
      auditAppend("timer_deferred", { label, minutes, reason: "shutdown" });
      return;
    }
    const message = `Timer up: ${label}.`;
    const spoken = await speakWithRetry(message);
    db.prepare("UPDATE timers SET fired = 1 WHERE id = ?").run(timerId);
    recordEvent("timer_fired", { label, minutes, spoken: spoken.spoken, attempts: spoken.attempts });
    auditAppend("timer_fired", { label, minutes, spoken: spoken.spoken, attempts: spoken.attempts });
  }, minutes * 60 * 1000);
}

export async function route(transcriptRaw: string, lang: Lang = "en"): Promise<IntentResult> {
  const transcript = clean(strip(transcriptRaw));
  addToMemory("user", transcriptRaw);

  const log = (r: IntentResult): IntentResult => {
    addToMemory("aura", r.reply);
    auditAppend("intent", { transcript: transcriptRaw, ...r });
    return r;
  };

  // ---- DND ----
  // Note: "mute" is intentionally NOT here — it controls audio (see Volume below).
  // DND is for "don't disturb / quiet / leave me alone / silence me".
  const dnd = transcript.match(
    /(don'?t disturb|do not disturb|leave me alone|silence me|be quiet|quiet)\s*(me)?\s*(for)?\s*(\d+)?\s*(min|minute|minutes|hour|hours|hr|hrs)?/i,
  );
  if (dnd) {
    const num = Number(dnd[4] ?? 30);
    const unit = (dnd[5] ?? "min").toLowerCase();
    const minutes = unit.startsWith("hour") || unit.startsWith("hr") ? num * 60 : num;
    ensureQuietBlock(minutes, transcriptRaw);
    return log({
      intent: "dnd",
      reply: pickReply(
        lang,
        `Muted for ${minutes} minutes.`,
        `${minutes} मिनट तक चुप रहूँगी।`,
        `${minutes} ನಿಮಿಷ ಸುಮ್ಮನಿರುತ್ತೇನೆ.`,
      ),
    });
  }

  // ---- Time / date ----
  if (/^(time|what time|whats the time|what'?s the time)/.test(transcript)) {
    const t = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return log({ intent: "time", reply: pickReply(lang, `It's ${t}.`, `अभी ${t} बजे हैं।`, `ಈಗ ${t}.`) });
  }
  if (/^(date|what date|today|what day|whats the date|what'?s the date)/.test(transcript)) {
    const d = new Date().toLocaleDateString([], {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    return log({ intent: "date", reply: pickReply(lang, `Today is ${d}.`, `आज ${d} है।`, `ಇಂದು ${d}.`) });
  }

  // ---- Math (Only if it looks like a pure calculation or starts with math keywords) ----
  const mathMatch = transcript.match(/^(calculate|compute|solve|what is|whats|what'?s)\s+(.+)/);
  const isPureMath = /^[\d+\-*/().\s]+$/.test(transcript) && /[+\-*/]/.test(transcript);
  
  if (mathMatch || isPureMath) {
    const expr = mathMatch ? mathMatch[2] : transcript;
    const result = safeEvalMath(expr);
    if (result !== null) {
      return log({
        intent: "math",
        reply: pickReply(lang, `${result}.`, `उत्तर ${result} है।`, `ಉತ್ತರ ${result}.`),
        side_effect: { result },
      });
    }
  }

  // ---- Notes ----
  const noteMatch = transcript.match(/^(note|remember|save note|take a note)[:\s]+(.+)/);
  if (noteMatch) {
    const body = noteMatch[2];
    db.prepare("INSERT INTO notes (ts, body) VALUES (?, ?)").run(new Date().toISOString(), body);
    return log({
      intent: "note_save",
      reply: pickReply(lang, `Noted: ${body}.`, `लिख लिया: ${body}।`, `ಬರೆದುಕೊಂಡೆ: ${body}.`),
    });
  }
  if (/^(what are my notes|read notes|list notes|my notes)/.test(transcript)) {
    const rows = db
      .prepare("SELECT body FROM notes ORDER BY id DESC LIMIT 5")
      .all() as Array<{ body: string }>;
    if (rows.length === 0) {
      return log({
        intent: "note_list",
        reply: pickReply(lang, "No notes yet.", "अभी कोई नोट नहीं।", "ಯಾವುದೇ ಟಿಪ್ಪಣಿಗಳಿಲ್ಲ."),
      });
    }
    const list = rows.map((r, i) => `${i + 1}. ${r.body}`).join(". ");
    return log({ intent: "note_list", reply: list });
  }

  // ---- Timer ----
  // Accepts both word orders: "set a 5 minute timer", "set a timer for 5 minutes",
  // "start 30 second timer for tea". Duration is extracted from anywhere in the
  // phrase; an optional label is whatever follows "for <X>" that is NOT the duration.
  const durMatch = transcript.match(/(\d+)\s*(min|minute|minutes|sec|second|seconds)\b/);
  const wantsTimer =
    /\btimer\b/.test(transcript) ||
    /(set|start)\s+(a\s+)?\d+\s*(min|minute|minutes|sec|second|seconds)\b/.test(transcript);
  if (wantsTimer && durMatch) {
    const n = Number(durMatch[1]);
    const unit = durMatch[2].toLowerCase();
    const unitWord = unit.startsWith("sec") ? "sec" : "min";
    const minutes = unit.startsWith("sec") ? n / 60 : n;
    // Label = text after "for X" where X is not the duration phrase itself.
    const labelMatch = transcript.match(
      /\bfor\s+(?!\d+\s*(?:min|minute|minutes|sec|second|seconds)\b)(.+)$/,
    );
    const label = labelMatch ? labelMatch[1].trim() : "timer";
    scheduleTimer(label, minutes);
    const tail = label !== "timer" ? ` (${label})` : "";
    return log({
      intent: "timer",
      reply: pickReply(
        lang,
        `Timer set for ${n} ${unitWord}${tail}.`,
        `${n} ${unitWord} का टाइमर सेट किया${tail}।`,
        `${n} ${unitWord} ಟೈಮರ್ ಸೆಟ್ ಮಾಡಿದೆ${tail}.`,
      ),
    });
  }

  // ---- Unit conversion ----
  // "convert 10 km to miles", "10 kg to lb", "20 c to f". Plurals are trimmed
  // (miles → mile) so they match convertUnits()'s normaliser.
  const conv = transcript.match(
    /(?:convert\s+)?(-?\d+(?:\.\d+)?)\s*([a-z°]+)\s+(?:to|in|into)\s+([a-z°]+)/,
  );
  if (conv) {
    const n = Number(conv[1]);
    const from = conv[2].replace(/s$/, "");
    const to = conv[3].replace(/s$/, "");
    const result = convertUnits(n, from, to);
    if (result !== null) {
      const rounded = Math.round(result * 100) / 100;
      return log({
        intent: "convert",
        reply: pickReply(
          lang,
          `${conv[1]} ${conv[2]} is ${rounded} ${conv[3]}.`,
          `${conv[1]} ${conv[2]} = ${rounded} ${conv[3]}।`,
          `${conv[1]} ${conv[2]} = ${rounded} ${conv[3]}.`,
        ),
        side_effect: { result: rounded, from: conv[2], to: conv[3] },
      });
    }
  }

  // ---- Volume ----
  if (/(volume up|louder|turn it up)/.test(transcript)) {
    const r = adjustVolume(15);
    return log({ intent: "volume_up", reply: `Volume ${r.pct}.` });
  }
  if (/(volume down|quieter|turn it down)/.test(transcript)) {
    const r = adjustVolume(-15);
    return log({ intent: "volume_down", reply: `Volume ${r.pct}.` });
  }
  if (/(\bmute\b|silence the speakers)/.test(transcript)) {
    muteVolume();
    return log({ intent: "mute", reply: pickReply(lang, "Muted.", "म्यूट कर दिया।", "ಮ್ಯೂಟ್ ಮಾಡಿದೆ.") });
  }
  if (/(unmute|turn sound back on)/.test(transcript)) {
    unmuteVolume();
    return log({ intent: "unmute", reply: pickReply(lang, "Unmuted.", "अनम्यूट कर दिया।", "ಅನ್‌ಮ್ಯೂಟ್ ಮಾಡಿದೆ.") });
  }
  const setVol = transcript.match(/(set\s+)?volume\s+(?:to\s+)?(\d+)/);
  if (setVol) {
    const r = setVolume(Number(setVol[2]));
    return log({ intent: "volume_set", reply: `Volume set to ${r.pct}.` });
  }

  // ---- Lock screen / screenshot ----
  if (/lock (the )?screen|lock my mac|lock laptop/.test(transcript)) {
    lockScreen();
    return log({ intent: "lock", reply: pickReply(lang, "Locking.", "लॉक कर रही हूँ।", "ಲಾಕ್ ಮಾಡುತ್ತಿದ್ದೇನೆ.") });
  }
  if (/(take|grab) a screenshot|screencap/.test(transcript)) {
    const r = takeScreenshot();
    return log({
      intent: "screenshot",
      reply: r.ok ? `Screenshot tool open. Saved to Desktop.` : "Couldn't take a screenshot.",
    });
  }

  // ---- Wikipedia ----
  const wiki = transcript.match(
    /^(tell me about|wikipedia|wiki|who is|what is|whats|what'?s|who'?s)\s+(.+)/,
  );
  // Self-referential topics ("tell me about yourself/you/aura") belong to the
  // identity handler below — don't look them up on Wikipedia.
  if (wiki && !/^(yourself|you|aura|me|myself)\b/.test(wiki[2])) {
    const topic = wiki[2];
    const r = await wikiSummary(topic);
    if (r.ok) return log({ intent: "wiki", reply: r.text, side_effect: { url: r.url } });
  }

  // ---- Define ----
  const defmatch = transcript.match(/^(define|what does (.+) mean|definition of)\s+(.+)/);
  if (defmatch) {
    const word = (defmatch[2] ?? defmatch[3]).split(/\s+/)[0];
    const r = await defineWord(word);
    return log({ intent: "define", reply: r.text });
  }

  // ---- Joke ----
  if (/(tell me a joke|make me laugh|joke)/.test(transcript)) {
    const r = await tellJoke();
    return log({ intent: "joke", reply: r.text });
  }

  // ---- Open shortcuts ----
  const shortcut = findShortcut(transcript);
  if (shortcut) return log({ intent: "shortcut", reply: shortcut.message, action: shortcut });

  // ---- Open URL ----
  const openUrlMatch = transcript.match(
    /^(open|pull up|launch|go to|visit)\s+(https?:\/\/\S+|[\w-]+\.[\w./?#=&-]+)/,
  );
  if (openUrlMatch) {
    const url = openUrlMatch[2].replace(/\s+dot\s+/g, ".").replace(/\s+slash\s+/g, "/");
    const action = openUrl(url);
    return log({ intent: "open_url", reply: action.message, action });
  }

  // ---- Knowledge / Routine / Health questions (Pass to LLM) ----
  if (
    /^(what do you know|tell me about|how am i|what'?s my|status|how'?s my day|routine|habit|pattern|readiness)/.test(
      transcript,
    )
  ) {
     // Skip regex section and let LLM at the bottom handle it.
  } else {
    // ---- Open app ----
    const openAppMatch = transcript.match(
      /^(open|launch|start)\s+(spotify|notion|slack|chrome|safari|notes|calendar|mail|messages|finder|terminal|vs code|vscode|visual studio code|cursor|zoom|arc|obsidian|figma)\b/,
    );
    if (openAppMatch) {
      const action = openApp(openAppMatch[2]);
      return log({ intent: "open_app", reply: action.message, action });
    }
  }

  // ---- Search (Explicit) ----
  const search = transcript.match(
    /^(search|google|look up|find|when is|when'?s|where is|where'?s)\s+(.+)/,
  );
  if (search) {
    const q = search[2];
    const action = webSearch(q);
    return log({ intent: "search", reply: action.message, action });
  }

  // ---- Status / Score ----
  if (/(score|readiness|how am i|how'?s my day|how is my day)/.test(transcript)) {
    const score = computeScore();
    return log({
      intent: "score",
      reply: pickReply(
        lang,
        `Your day-readiness is ${score.total} out of 100.`,
        `आपकी आज की तैयारी ${score.total} में से 100 है।`,
        `ಇಂದಿನ ಸಿದ್ಧತೆ ${score.total} ಶೇಕಡಾ.`,
      ),
      side_effect: { score: score.total },
    });
  }

  // ---- Meetings ----
  if (/(next meeting|next event|whats next|what'?s next|agenda)/.test(transcript)) {
    const next = db
      .prepare(
        "SELECT title, start_ts FROM calendar WHERE start_ts > datetime('now') ORDER BY start_ts ASC LIMIT 1",
      )
      .get() as { title: string; start_ts: string } | undefined;
    if (!next) {
      return log({
        intent: "next_event",
        reply: pickReply(lang, "Nothing else today.", "आज कोई और मीटिंग नहीं।", "ಇಂದು ಬೇರೆ ಸಭೆಗಳಿಲ್ಲ."),
      });
    }
    const minUntil = Math.round((new Date(next.start_ts).getTime() - Date.now()) / 60000);
    return log({
      intent: "next_event",
      reply: pickReply(
        lang,
        `Next: ${next.title} in ${minUntil} minutes.`,
        `अगला: ${next.title}, ${minUntil} मिनट में।`,
        `ಮುಂದಿನದು: ${next.title}, ${minUntil} ನಿಮಿಷದಲ್ಲಿ.`,
      ),
    });
  }

  if (/(meetings today|all my meetings|today'?s schedule)/.test(transcript)) {
    const now = new Date();
    const todayBounds = localDayBounds(now);
    const rows = db
      .prepare(
        "SELECT title, start_ts FROM calendar WHERE start_ts >= ? AND start_ts <= ? ORDER BY start_ts ASC",
      )
      .all(todayBounds.start, todayBounds.end) as Array<{ title: string; start_ts: string }>;
    if (!rows.length) {
      return log({ intent: "meetings_today", reply: pickReply(lang, "No meetings today.", "आज कोई मीटिंग नहीं।", "ಇಂದು ಸಭೆಗಳಿಲ್ಲ.") });
    }
    const list = rows
      .map((r) => `${new Date(r.start_ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} ${r.title}`)
      .join(", ");
    return log({ intent: "meetings_today", reply: list });
  }

  // ---- Clear Calendar ----
  if (/(clear calendar|delete all meetings|reset my schedule)/.test(transcript)) {
    db.prepare("DELETE FROM calendar").run();
    return log({
      intent: "clear_calendar",
      reply: pickReply(lang, "Calendar cleared.", "कैलेंडर साफ कर दिया।", "ಕ್ಯಾಲೆಂಡರ್ ಅಳಿಸಲಾಗಿದೆ."),
    });
  }

  // ---- Add Event ----
  const addEventMatch = transcript.match(/^(add|schedule|put|remind me about)\s+(.+?)\s+(at|on|for)\s+(.+)/);
  if (addEventMatch) {
    const title = addEventMatch[2].trim();
    const timeStr = addEventMatch[4].trim();
    let date = new Date();
    if (timeStr.includes("tomorrow")) date = new Date(Date.now() + 24 * 3600000);
    const timeMatch = timeStr.match(/(\d+)(?::(\d+))?\s*(am|pm)?/i);
    if (timeMatch) {
      let h = parseInt(timeMatch[1]);
      const m = parseInt(timeMatch[2] || "0");
      const ampm = (timeMatch[3] || "").toLowerCase();
      if (ampm === "pm" && h < 12) h += 12;
      if (ampm === "am" && h === 12) h = 0;
      date.setHours(h, m, 0, 0);
      db.prepare("INSERT INTO calendar (start_ts, end_ts, title) VALUES (?, ?, ?)")
        .run(date.toISOString(), new Date(date.getTime() + 3600000).toISOString(), title);
      const displayTime = `${h % 12 || 12}:${m.toString().padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
      return log({
        intent: "calendar_add",
        reply: pickReply(lang, `Scheduled: ${title} for ${displayTime}.`, `शेड्यूल किया: ${title}, ${displayTime} के लिए।`, `ನಿಗದಿಪಡಿಸಲಾಗಿದೆ: ${title}, ${displayTime} ಕ್ಕ್ಕೆ.`),
      });
    }
  }

  // ---- Reminder (untimed) ----
  // Timed reminders ("remind me about X at 5pm") are caught above by Add Event.
  // Anything left ("remind me to call mom") is saved as a reminder note.
  const remindMatch = transcript.match(/^remind me (?:to|about|that)\s+(.+)/);
  if (remindMatch) {
    const body = `Reminder: ${remindMatch[1]}`;
    db.prepare("INSERT INTO notes (ts, body) VALUES (?, ?)").run(new Date().toISOString(), body);
    return log({
      intent: "reminder",
      reply: pickReply(
        lang,
        `I'll remind you: ${remindMatch[1]}.`,
        `मैं याद दिलाऊँगी: ${remindMatch[1]}।`,
        `ನಾನು ನೆನಪಿಸುತ್ತೇನೆ: ${remindMatch[1]}.`,
      ),
    });
  }

  // ---- Steps ----
  if (/(how many steps|step count|walking distance)/.test(transcript)) {
    const today = localDayBounds(new Date());
    const row = db.prepare("SELECT SUM(count) as total FROM steps WHERE date = ?")
      .get(today.start.split("T")[0]) as { total: number } | undefined;
    const count = row?.total || 0;
    return log({
      intent: "health_stats",
      reply: pickReply(lang, `You've taken ${count} steps today.`, `आज आपने ${count} कदम चले हैं।`, `ಇಂದು ನೀವು ${count} ಹೆಜ್ಜೆಗಳನ್ನು ನಡೆದಿದ್ದೀರಿ.`),
    });
  }

  if (/(weather|rain|temperature|hot|cold)/.test(transcript)) {
    const w = await getWeather();
    return log({
      intent: "weather",
      reply: pickReply(lang, `It's ${Math.round(w.temp_c)} degrees.`, `तापमान ${Math.round(w.temp_c)} डिग्री है।`, `${Math.round(w.temp_c)} ಡಿಗ್ರಿ ಇದೆ.`),
      side_effect: { weather: w },
    });
  }

  // ---- Trigger skills (Explicit) ----
  if (transcript === "run brief" || transcript === "give me a brief" || transcript === "morning brief now") {
    const r = await morningBrief.run({ dry_run: false, lang });
    return log({
      intent: "run_morning_brief",
      reply: r.message?.text ?? "Nothing new to report.",
    });
  }

  // ---- Identity ----
  if (/(who are you|what'?s your name|whats your name|tell me about yourself|what are you)/.test(transcript)) {
    return log({
      intent: "identity",
      reply: pickReply(lang, "I'm AURA. Your proactive digital twin.", "मैं AURA हूँ। आपकी डिजिटल ट्विन।", "ನಾನು AURA. ನಿಮ್ಮ ಡಿಜಿಟಲ್ ಟ್ವಿನ್."),
    });
  }

  // ---- Greetings ----
  if (/^(hi|hello|hey|sup|yo)$/.test(transcript)) {
    return log({
      intent: "greeting",
      reply: pickReply(lang, "I'm here. What's on your mind?", "मैं यहाँ हूँ। क्या बात है?", "ನಾನು ಇಲ್ಲಿದ್ದೇನೆ. ಏನು ಸಮಾಚಾರ?"),
    });
  }

  // ---- Main LLM Brain (Gemini/Ollama) ----
  if (config.ollama.url || config.gemini.apiKey) {
    const state = getSystemState();
    const contextStr = formatContextForLLM(state);
    const memory = getMemory();
    const memoryStr = memory
      .map((m) => `${m.role === "user" ? "User" : "AURA"}: ${m.text}`)
      .join("\n");

    const langInstr =
      lang === "hi"
        ? "Reply in Hindi (Devanagari)."
        : lang === "kn"
          ? "Reply in Kannada (ಕನ್ನಡ)."
          : "Reply in English.";

    const r = await narrate({
      system: `You are AURA, a world-class proactive life assistant. 
${langInstr}
Personality: Professional, empathetic, and deeply integrated into the user's patterns.

KNOWLEDGE BASE:
${contextStr}

CONVERSATION HISTORY:
${memoryStr}

MISSION:
- Answer questions about the user's habits, routines (from TWIN.md), health, and schedule.
- Be concise (under 200 chars).
- If you can't perform an action, explain why and offer an alternative (like taking a note).
- Never say you are an AI. You are AURA.`,
      user: transcriptRaw,
      fallback: "I'm processing a lot of data right now—could you try that again in a second?",
    });

    if (r.text && r.text.length > 2) {
      return log({ intent: "llm_answer", reply: r.text });
    }
  }

  // ---- Final Fallback (Search) ----
  const action = webSearch(transcriptRaw);
  return log({
    intent: "fallback_search",
    reply: pickReply(lang, "Let me look that up for you.", "गूगल पर देखती हूँ।", "ನಾನು ಹುಡುಕುತ್ತೇನೆ."),
    action,
  });
}

// ---- Unit converter (small, offline) ----
function convertUnits(n: number, from: string, to: string): number | null {
  const norm = (u: string): string => {
    if (["mile"].includes(u)) return "mile";
    if (["lb", "pound"].includes(u)) return "lb";
    if (["celsius"].includes(u)) return "c";
    if (["fahrenheit"].includes(u)) return "f";
    if (["inche", "in"].includes(u)) return "in";
    if (["foot", "ft", "feet"].includes(u)) return "ft";
    return u;
  };
  const f = norm(from);
  const t = norm(to);
  const toMeters: Record<string, number> = {
    km: 1000, mile: 1609.344, m: 1, cm: 0.01, in: 0.0254, ft: 0.3048,
  };
  if (toMeters[f] && toMeters[t]) return (n * toMeters[f]) / toMeters[t];
  const toKg: Record<string, number> = { kg: 1, lb: 0.453592 };
  if (toKg[f] && toKg[t]) return (n * toKg[f]) / toKg[t];
  if ((f === "kmh" && t === "mph")) return n * 0.621371;
  if (f === "mph" && t === "kmh") return n / 0.621371;
  if (f === "c" && t === "f") return (n * 9) / 5 + 32;
  if (f === "f" && t === "c") return ((n - 32) * 5) / 9;
  return null;
}
