import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { config } from "./config.js";

export type CostWeights = { false_alarm: number; missed_help: number };

export type SoulContext =
  | "default"
  | "quiet_hours"
  | "focus_block"
  | "pre_meeting"
  | "commute";

export type Soul = {
  raw: string;
  cost_weights: Record<SoulContext, CostWeights>;
  quiet_hours: { start: string; end: string };
  enabled_skills: string[];
};

function extractYamlBlock(raw: string, key: string): unknown {
  const lines = raw.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.trim().startsWith(`${key}:`));
  if (headerIdx === -1) return null;
  const block: string[] = [lines[headerIdx]];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.length === 0) continue;
    if (/^\s/.test(l)) {
      block.push(l);
      continue;
    }
    break;
  }
  return parseYaml(block.join("\n"));
}

// Match HH:MM strings, e.g. "22:00", "06:30". Anything else is treated as missing.
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function loadSoul(): Soul {
  const raw = readFileSync(config.paths.soul, "utf8");
  const cwBlock = extractYamlBlock(raw, "cost_weights") as
    | { cost_weights: Record<SoulContext, CostWeights> }
    | null;
  const cost_weights = cwBlock?.cost_weights ?? {
    default: { false_alarm: 1, missed_help: 1 },
    quiet_hours: { false_alarm: 9, missed_help: 1 },
    focus_block: { false_alarm: 6, missed_help: 1 },
    pre_meeting: { false_alarm: 1, missed_help: 4 },
    commute: { false_alarm: 1.5, missed_help: 3 },
  };

  // SOUL.md uses prose like "22:00 — 06:30" rather than YAML for quiet hours;
  // pull the first two HH:MM tokens that appear after a "Quiet hours" heading.
  // Falls back to safe defaults if the file omits them or uses a stray format.
  let quiet_hours = { start: "22:00", end: "06:30" };
  const qhSection = raw.split(/^##\s+/m).find((s) => /^quiet hours/i.test(s));
  if (qhSection) {
    const times = qhSection.match(/\b([01]\d|2[0-3]):[0-5]\d\b/g);
    if (times && times.length >= 2 && HHMM.test(times[0]) && HHMM.test(times[1])) {
      quiet_hours = { start: times[0], end: times[1] };
    }
  }

  return {
    raw,
    cost_weights,
    quiet_hours,
    enabled_skills: ["morning_brief"],
  };
}
