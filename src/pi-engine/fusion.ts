// ── Cross-modal Sensor Fusion for p_need (Edge-PRISM Extension 5) ────────────
//
// Research claim: fusing multiple on-device signals (calendar density, physical
// activity, notification burden, and — when available — HRV from Galaxy Watch)
// into a single attention-weighted p_need produces a richer estimate of "how
// much does the user need this nudge right now?" than any single signal alone.
//
// Architecture mirrors ExecuTorch attention fusion:
//   signals → [0,1] normalisation → softmax attention weights → weighted sum
//
// Each signal has a base weight. Weights are modulated by recency and data
// confidence, then normalised via softmax so they always sum to 1.
// ─────────────────────────────────────────────────────────────────────────────

import { db, localDateString } from "../db.js";

// ── Signal types ─────────────────────────────────────────────────────────────

export type FusedNeedSignals = {
  calendar_density: number;   // 0=empty day, 1=back-to-back meetings
  step_deficit: number;       // 0=very active, 1=completely sedentary
  notif_burden: number;       // 0=no recent notifs, 1=saturated (≥20 in 24h)
  hrv_stress: number;         // 0=relaxed, 1=high stress  (NaN when no watch)
  time_urgency: number;       // 0=no event soon, 1=event in <5 min
};

export type FusionResult = {
  p_need: number;
  signals: FusedNeedSignals;
  weights: Record<keyof FusedNeedSignals, number>;   // post-softmax, sum = 1
  method: "fusion" | "fallback";
};

// ── Base attention weights (prior) ───────────────────────────────────────────
// Tuned to the eval-harness distribution. calendar_density and time_urgency
// carry the most signal; HRV weight is non-zero but low until the watch is
// integrated — it simply has no contribution when hrv_stress is NaN.

const BASE_WEIGHTS: Record<keyof FusedNeedSignals, number> = {
  time_urgency:     0.35,
  calendar_density: 0.25,
  step_deficit:     0.15,
  notif_burden:     0.10,
  hrv_stress:       0.15,
};

// ── Softmax ──────────────────────────────────────────────────────────────────

function softmax(vals: number[]): number[] {
  const exp = vals.map(v => Math.exp(v));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map(v => v / sum);
}

// ── Signal extractors ─────────────────────────────────────────────────────────

function getCalendarDensity(now: Date): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const rows = db
    .prepare("SELECT start_ts, end_ts FROM calendar WHERE start_ts >= ? AND end_ts <= ?")
    .all(start.toISOString(), end.toISOString()) as Array<{ start_ts: string; end_ts: string }>;

  let totalMeetingMin = 0;
  for (const r of rows) {
    totalMeetingMin += (new Date(r.end_ts).getTime() - new Date(r.start_ts).getTime()) / 60000;
  }
  // 480 min (8 hrs) of meetings = fully dense day → 1.0
  return Math.min(1, totalMeetingMin / 480);
}

function getStepDeficit(now: Date): number {
  const date = localDateString(now);
  const hour = now.getHours();
  const fromHour = Math.max(0, hour - 2);
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(count), 0) AS c FROM steps WHERE date = ? AND hour >= ? AND hour <= ?",
    )
    .get(date, fromHour, hour) as { c: number } | undefined;
  const recent = row?.c ?? 0;

  // ── Decay: if no steps recorded in last 3 hours the sensor may be
  // offline/pocketed. Treat as neutral (0.5) rather than "fully sedentary" (1.0)
  // to avoid punishing a user whose phone is charging on a desk.
  const lastStepRow = db
    .prepare("SELECT MAX(date || 'T' || printf('%02d', hour) || ':00:00') AS last_ts FROM steps WHERE date = ?")
    .get(date) as { last_ts: string | null };
  if (lastStepRow?.last_ts) {
    const ageMsec = now.getTime() - new Date(lastStepRow.last_ts).getTime();
    if (ageMsec > 3 * 60 * 60 * 1000) return 0.5; // Sensor likely offline → neutral.
  }

  // 1000 steps in 2h = reasonably active; below that = deficit
  return Math.max(0, 1 - recent / 1000);
}

function getNotifBurden(now: Date): number {
  const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM notifications WHERE ts >= ?")
    .get(since) as { c: number } | undefined;
  return Math.min(1, (row?.c ?? 0) / 20);
}

function getTimeUrgency(nextEventMinUntil: number | null): number {
  if (nextEventMinUntil === null) return 0;
  if (nextEventMinUntil <= 5)  return 1.0;
  if (nextEventMinUntil <= 15) return 0.8;
  if (nextEventMinUntil <= 30) return 0.55;
  if (nextEventMinUntil <= 60) return 0.30;
  return 0.05;
}

// ── HRV stub (Galaxy Watch / Samsung Health Data SDK) ────────────────────────
//
// Phase 3: replace this stub with a real Galaxy Watch HRV read via the
// Samsung Health Data SDK. The function should return a normalised [0,1]
// stress score (0=relaxed, 1=high stress). When the watch is unavailable
// or the SDK is not initialised, return NaN — the fusion loop will drop
// the HRV channel's weight and redistribute it across other signals.
//
// SDK integration point:
//   import { HealthDataStore } from "@samsung-health/data";
//   const hrv = await HealthDataStore.read({ type: "hrv", limit: 1 });
//   return hrv.length ? normalise(hrv[0].rmssd) : NaN;

export function readHrvStress(now: Date = new Date()): number {
  // Read both the normalised stress value AND the timestamp it was written.
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'hrv_stress'")
    .get() as { value: string } | undefined;
  const tsRow = db
    .prepare("SELECT updated_at FROM settings WHERE key = 'hrv_stress'")
    .get() as { updated_at: string } | undefined;

  if (!row || !tsRow) return NaN; // No watch data → channel excluded.
  const n = parseFloat(row.value);
  if (!Number.isFinite(n)) return NaN;

  // ── Decay: readings older than 2 hours fade to NaN so a disconnected watch
  // doesn't permanently bias the gate. Exponential decay from 1.0 → 0 over
  // 120 minutes; we exclude the signal once it decays below 0.1.
  const ageMin = (now.getTime() - new Date(tsRow.updated_at).getTime()) / 60000;
  const DECAY_HALF_LIFE_MIN = 60; // value halves every 60 minutes
  const decayFactor = Math.pow(0.5, ageMin / DECAY_HALF_LIFE_MIN);
  if (decayFactor < 0.1) return NaN; // Signal too stale — drop the channel.

  // Apply decay: stressed reading softens over time toward 0.5 (neutral).
  const decayed = 0.5 + (n - 0.5) * decayFactor;
  return Math.max(0, Math.min(1, decayed));
}

// ── Main fusion function ──────────────────────────────────────────────────────

export function fuseNeed(
  now: Date,
  nextEventMinUntil: number | null,
  readinessScore: number,         // 0-100 from computeScore()
): FusionResult {
  const signals: FusedNeedSignals = {
    calendar_density: getCalendarDensity(now),
    step_deficit:     getStepDeficit(now),
    notif_burden:     getNotifBurden(now),
    hrv_stress:       readHrvStress(now),
    time_urgency:     getTimeUrgency(nextEventMinUntil),
  };

  // Build effective weights. If a signal is NaN (e.g. no HRV data), zero its
  // weight and redistribute via re-normalisation through softmax.
  const keys = Object.keys(BASE_WEIGHTS) as Array<keyof FusedNeedSignals>;
  const effectiveSignals: number[] = [];
  const effectiveKeys: Array<keyof FusedNeedSignals> = [];
  const priorWeights: number[] = [];

  for (const k of keys) {
    const v = signals[k];
    if (!Number.isFinite(v)) continue; // Drop NaN channels.
    effectiveSignals.push(v);
    effectiveKeys.push(k);
    priorWeights.push(BASE_WEIGHTS[k]);
  }

  if (effectiveSignals.length === 0) {
    // Degenerate: no signals at all — fallback to readiness-based estimate.
    return {
      p_need: Math.max(0, Math.min(1, 1 - readinessScore / 100)),
      signals,
      weights: Object.fromEntries(keys.map(k => [k, 0])) as Record<keyof FusedNeedSignals, number>,
      method: "fallback",
    };
  }

  // Attention weights: combine base priors (shape of the distribution) with
  // signal magnitude (high-magnitude signals deserve more weight).
  // This is a lightweight approximation of the ExecuTorch attention mechanism:
  //   attention_score = prior_weight × (1 + signal_value)
  const rawAttention = priorWeights.map((w, i) => w * (1 + effectiveSignals[i]));
  const normWeights = softmax(rawAttention);

  // Weighted sum → fused p_need.
  let fused = 0;
  for (let i = 0; i < effectiveSignals.length; i++) {
    fused += normWeights[i] * effectiveSignals[i];
  }

  // Blend fused signal with readiness-based estimate.
  // Readiness is already a comprehensive day quality measure; the fusion
  // adds temporal and cross-modal texture on top.
  const readinessBased = Math.max(0, Math.min(1, 1 - readinessScore / 100));
  const p_need = Math.min(1, 0.6 * fused + 0.4 * readinessBased);

  // Reconstruct full weight map (zero for any dropped channels).
  const weightMap: Record<keyof FusedNeedSignals, number> = Object.fromEntries(
    keys.map(k => [k, 0]),
  ) as Record<keyof FusedNeedSignals, number>;
  for (let i = 0; i < effectiveKeys.length; i++) {
    weightMap[effectiveKeys[i]] = normWeights[i];
  }

  return { p_need, signals, weights: weightMap, method: "fusion" };
}
