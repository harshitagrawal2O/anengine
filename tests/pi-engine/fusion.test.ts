import "../helpers/testenv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuseNeed } from "../../src/pi-engine/fusion.js";

test("p_need stays within [0,1]", () => {
  for (const [mins, score] of [[null, 100], [2, 20], [45, 60]] as const) {
    const r = fuseNeed(new Date(), mins, score);
    assert.ok(r.p_need >= 0 && r.p_need <= 1, `p_need=${r.p_need}`);
  }
});

test("active weights sum to 1 and the NaN HRV channel is dropped", () => {
  const r = fuseNeed(new Date(), 10, 70);
  const sum = Object.values(r.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `weights sum ${sum}`);
  // No watch data in the test DB → HRV channel excluded (weight 0).
  assert.equal(r.weights.hrv_stress, 0);
  assert.equal(r.method, "fusion");
});

test("imminent event drives higher urgency than a far-off one", () => {
  const soon = fuseNeed(new Date(), 3, 70).signals.time_urgency;
  const far = fuseNeed(new Date(), 120, 70).signals.time_urgency;
  assert.ok(soon > far);
});
