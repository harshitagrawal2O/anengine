// Verifies the Shadow AURA → LLM integration against whatever OLLAMA_URL points
// at (here, the mock). Builds a borderline (slow-mode) gate decision proposing
// "speak", and confirms Shadow consults the LLM, parses its JSON verdict, and
// applyShadow() overrides the decision when Shadow disagrees with high confidence.
import { shadowReview, applyShadow } from "../src/pi-engine/shadow.js";
import type { GateContext, GateDecision, ProposedAction } from "../src/pi-engine/gate.js";

const action: ProposedAction = { skill: "hydration_reminder", text: "Time for water", importance: "normal" };

const ctx = {
  now: new Date(),
  score: { total: 82 } as any,
  next_event_min_until: 75,
  next_event_title: "Design review",
} as GateContext;

// Borderline decision: the fast gate landed in slow mode and tentatively proposes SPEAK.
const decision: GateDecision = {
  intervene: true, mode: "slow", p_need: 0.34, p_accept: 0.55,
  c_fa: 1.5, c_fn: 1.5, tau: 0.5, utility: 0.187,
  context_label: "default", reason: "slow: borderline",
  calibration_status: "bootstrapping", n_samples: 0,
  fusion: { p_need: 0.34, signals: {} as any, weights: {} as any, method: "fusion" },
};

const verdict = await shadowReview(action, ctx, decision);
console.log("Shadow verdict:", JSON.stringify(verdict, null, 2));
const after = applyShadow(decision, verdict);
console.log("\nProposed before Shadow:", decision.intervene ? "SPEAK" : "SILENT");
console.log("Decision after Shadow :", after.intervene ? "SPEAK" : "SILENT");
console.log("Override applied      :", verdict.override);
console.log("Consulted (real LLM)  :", verdict.consulted, "| source:", verdict.source);
