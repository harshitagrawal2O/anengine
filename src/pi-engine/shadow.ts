// Shadow AURA — the slow-mode counterfactual review.
// When the PRISM gate is on the borderline (slow mode), Shadow AURA asks a second
// "voice" — the LLM — to argue both sides and recommend speak vs. silent. The
// gate's existing decision is the default; Shadow can override only with high
// confidence and a stated reason. Every shadow check is logged.

import { narrate } from "../gateway/ollama.js";
import { append as auditAppend } from "../audit/log.js";
import type { GateContext, GateDecision, ProposedAction } from "./gate.js";

export type ShadowVerdict = {
  consulted: boolean;
  override: boolean;
  agreed: boolean;
  recommendation: "speak" | "silent" | null;
  confidence: number;
  reasoning: string;
  source: "ollama" | "fallback";
};

const FALLBACK: ShadowVerdict = {
  consulted: false,
  override: false,
  agreed: true,
  recommendation: null,
  confidence: 0,
  reasoning: "Ollama not configured; Shadow AURA skipped.",
  source: "fallback",
};

function summarizeContext(action: ProposedAction, ctx: GateContext, gate: GateDecision): string {
  const next = ctx.next_event_min_until !== null
    ? `${ctx.next_event_title} in ${ctx.next_event_min_until} min`
    : "none";
  return [
    `Skill: ${action.skill}`,
    `Importance: ${action.importance ?? "normal"}`,
    `Day-readiness score: ${ctx.score.total}/100`,
    `Next event: ${next}`,
    `Context label: ${gate.context_label}`,
    `p_need: ${gate.p_need.toFixed(2)}`,
    `p_accept: ${gate.p_accept.toFixed(2)}`,
    `tau (threshold): ${gate.tau.toFixed(2)}`,
    `utility (p_need * p_accept): ${gate.utility.toFixed(3)}`,
    `Fast-gate proposal: ${gate.intervene ? "speak" : "silent"} (${gate.reason})`,
  ].join("\n");
}

function parseVerdict(raw: string): { recommendation: "speak" | "silent" | null; confidence: number; reasoning: string } {
  // Expected JSON format. If parsing fails, default to "no override".
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m?.[0] ?? raw) as {
      recommendation?: string;
      confidence?: number;
      reasoning?: string;
    };
    const rec =
      parsed.recommendation === "speak" || parsed.recommendation === "silent"
        ? parsed.recommendation
        : null;
    return {
      recommendation: rec,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0))),
      reasoning: String(parsed.reasoning ?? "(no reasoning given)").slice(0, 400),
    };
  } catch {
    return { recommendation: null, confidence: 0, reasoning: "Unparseable LLM output." };
  }
}

export async function shadowReview(
  action: ProposedAction,
  ctx: GateContext,
  gate: GateDecision,
): Promise<ShadowVerdict> {
  if (gate.mode !== "slow") return { ...FALLBACK, consulted: false, agreed: true };

  const llm = await narrate({
    system:
      "You are Shadow AURA, the second-opinion reviewer for a proactive agent. " +
      "Argue silently for both sides (speak vs stay silent) and pick the one with lower expected regret. " +
      'Reply with ONLY a JSON object: {"recommendation":"speak"|"silent","confidence":0..1,"reasoning":"<=200 chars"}.',
    user:
      "The fast gate is uncertain. Review and decide.\n\n" +
      summarizeContext(action, ctx, gate) +
      "\n\nRespond with the JSON.",
    fallback:
      '{"recommendation":"' +
      (gate.intervene ? "speak" : "silent") +
      '","confidence":0,"reasoning":"Ollama not available; deferring to fast gate."}',
  });

  const parsed = parseVerdict(llm.text);
  const proposed: "speak" | "silent" = gate.intervene ? "speak" : "silent";
  const agreed = parsed.recommendation === proposed || parsed.recommendation === null;
  // Override only if Shadow disagrees AND is highly confident.
  const override = !agreed && parsed.confidence >= 0.7;

  // consulted is true only when the LLM actually responded; fallback means Ollama was offline.
  const consulted = llm.source === "ollama";

  const verdict: ShadowVerdict = {
    consulted,
    override,
    agreed,
    recommendation: parsed.recommendation,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
    source: llm.source,
  };

  auditAppend("shadow_review", {
    skill: action.skill,
    fast_gate: proposed,
    shadow: verdict,
    ...(consulted ? {} : { shadow_skipped: "ollama_offline" }),
  });

  return verdict;
}

export function applyShadow(gate: GateDecision, verdict: ShadowVerdict): GateDecision {
  if (!verdict.override || verdict.recommendation === null) return gate;
  return {
    ...gate,
    intervene: verdict.recommendation === "speak",
    reason: `${gate.reason}; OVERRIDDEN by Shadow AURA (${verdict.confidence.toFixed(2)}): ${verdict.reasoning}`,
  };
}
