// ── Edge-PRISM calibration wired into live gate (2026-05-04) ────────────────
// Before: shouldIntervene used static c_fa/c_fn from SOUL.md on every call.
// After:  calibrateCosts() (./calibration.ts) reads per-context (skill × hour-bucket)
//         accept/dismiss history from skill_runs and adapts c_fa/c_fn before τ.
// GateDecision now carries calibration_status + n_samples for audit traceability.
// ─────────────────────────────────────────────────────────────────────────────

import type { Soul, SoulContext } from "../soul.js";
import type { TwinPatterns } from "../twin.js";
import type { ScoreBreakdown } from "../score/compute.js";
import { calibrateCosts, toHourBucket } from "./calibration.js";
import { fuseNeed, type FusionResult } from "./fusion.js";

export type GateContext = {
  now: Date;
  score: ScoreBreakdown;
  next_event_min_until: number | null;
  next_event_title: string | null;
};

export type ProposedAction = {
  skill: string;
  text: string;
  importance?: "low" | "normal" | "high" | "critical";
};

export type GateDecision = {
  intervene: boolean;
  mode: "fast" | "slow";
  p_need: number;
  p_accept: number;
  c_fa: number;        // calibrated (or static if bootstrapping)
  c_fn: number;        // calibrated (or static if bootstrapping)
  tau: number;         // threshold = c_fa / (c_fa + c_fn); gate fires when utility > tau
  utility: number;     // p_need × p_accept
  context_label: SoulContext;
  reason: string;
  calibration_status: "calibrated" | "bootstrapping";
  n_samples: number;   // labelled samples used; < MIN_SAMPLES means static fallback
  fusion: FusionResult; // Extension 5: cross-modal fusion metadata
};

const MARGIN = 0.05;

function inQuietHours(now: Date, soul: Soul): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [sH, sM] = soul.quiet_hours.start.split(":").map(Number);
  const [eH, eM] = soul.quiet_hours.end.split(":").map(Number);
  const start = sH * 60 + sM;
  const end = eH * 60 + eM;
  return start > end ? minutes >= start || minutes < end : minutes >= start && minutes < end;
}

import { isInQuietBlock } from "../db.js";

function classifyContext(ctx: GateContext, soul: Soul): SoulContext {
  if (isInQuietBlock(ctx.now).active) return "quiet_hours"; // user-imposed DND wins
  if (inQuietHours(ctx.now, soul)) return "quiet_hours";
  const t = ctx.next_event_title?.toLowerCase() ?? "";
  if (t.includes("focus") || t.includes("deep work")) return "focus_block";
  if (ctx.next_event_min_until !== null && ctx.next_event_min_until <= 60) return "pre_meeting";
  const h = ctx.now.getHours();
  if ((h >= 7 && h <= 9) || (h >= 17 && h <= 19)) return "commute";
  return "default";
}

// p_need: how likely the user actually needs this nudge right now.
// Uses cross-modal attention fusion (Extension 5) across calendar density,
// physical activity, notification burden, HRV stress, and time urgency.
function estimateNeed(
  action: ProposedAction,
  ctx: GateContext,
  score: ScoreBreakdown,
): FusionResult {
  return fuseNeed(ctx.now, ctx.next_event_min_until, score.total);
}

// p_accept: if AURA spoke now, how likely is the user to accept this nudge?
// Pulled from TWIN's per-skill historical acceptance rate, dampened by recent fatigue.
function estimateAccept(
  action: ProposedAction,
  ctx: GateContext,
  twin: TwinPatterns,
): number {
  const base = twin.acceptance_rate[action.skill] ?? 0.6;
  // Fatigue penalty: each recent notification trims acceptance by 5%, capped at 50%.
  const fatigue = Math.min(0.5, twin.notif_24h * 0.05);
  return Math.max(0.05, base - fatigue);
}

export function shouldIntervene(
  action: ProposedAction,
  ctx: GateContext,
  soul: Soul,
  twin: TwinPatterns,
  score: ScoreBreakdown,
): GateDecision {
  const context_label = classifyContext(ctx, soul);

  // Static cost weights from SOUL.md for this SoulContext (false_alarm, missed_help).
  const staticWeights = soul.cost_weights[context_label] ?? soul.cost_weights.default;

  // Edge-PRISM calibration: adjust c_fa and c_fn using per-context accept/dismiss history.
  // The context key is skill × hour-bucket (e.g. "morning_brief × morning").
  // Falls back to staticWeights transparently if fewer than MIN_SAMPLES runs exist.
  const bucket = toHourBucket(ctx.now.getHours());
  const cal = calibrateCosts(action.skill, bucket, staticWeights);

  const fusion = estimateNeed(action, ctx, score);
  let p_need = fusion.p_need;
  // Critical/high importance can override the fused estimate upward.
  if (action.importance === "critical") p_need = Math.max(p_need, 0.9);
  if (action.importance === "high")     p_need = Math.max(p_need, 0.6);
  const p_accept = estimateAccept(action, ctx, twin);

  const c_fa = cal.c_fa;
  const c_fn = cal.c_fn;

  // τ (tau): gate fires only when utility = p_need × p_accept exceeds this threshold.
  // With calibrated costs, τ adapts to the user's revealed preferences over time:
  // frequent dismissals → higher c_fa → higher τ → gate speaks less often.
  // Guard against a degenerate 0/0 → NaN if both calibrated costs ever hit zero
  // (a NaN τ makes every comparison below false, silently disabling the gate).
  const costSum = c_fa + c_fn;
  const tau = costSum > 0 ? c_fa / costSum : 0.5;
  const utility = p_need * p_accept;

  const calibration_status = cal.status;
  const n_samples = cal.n_samples;

  // Critical messages bypass the gate entirely (still recorded in the audit log).
  if (action.importance === "critical") {
    return {
      intervene: true,
      mode: "fast",
      p_need,
      p_accept,
      c_fa,
      c_fn,
      tau,
      utility,
      context_label,
      reason: "critical override",
      calibration_status,
      n_samples,
      fusion,
    };
  }

  if (utility > tau + MARGIN) {
    return {
      intervene: true,
      mode: "fast",
      p_need,
      p_accept,
      c_fa,
      c_fn,
      tau,
      utility,
      context_label,
      reason: `fast accept: utility ${utility.toFixed(3)} > tau+margin ${(tau + MARGIN).toFixed(3)}`,
      calibration_status,
      n_samples,
      fusion,
    };
  }
  if (utility < tau - MARGIN) {
    return {
      intervene: false,
      mode: "fast",
      p_need,
      p_accept,
      c_fa,
      c_fn,
      tau,
      utility,
      context_label,
      reason: `fast reject: utility ${utility.toFixed(3)} < tau-margin ${(tau - MARGIN).toFixed(3)}`,
      calibration_status,
      n_samples,
      fusion,
    };
  }

  // Borderline: slow-mode counterfactual.
  // "If I stay silent and the predicted bad outcome happens, what's the regret?"
  const regret_if_silent = p_need * c_fn;
  const cost_if_speak = (1 - p_accept) * c_fa;
  const intervene = regret_if_silent > cost_if_speak;
  return {
    intervene,
    mode: "slow",
    p_need,
    p_accept,
    c_fa,
    c_fn,
    tau,
    utility,
    context_label,
    reason: `slow: regret_if_silent ${regret_if_silent.toFixed(3)} ${
      intervene ? ">" : "<="
    } cost_if_speak ${cost_if_speak.toFixed(3)}`,
    calibration_status,
    n_samples,
    fusion,
  };
}
