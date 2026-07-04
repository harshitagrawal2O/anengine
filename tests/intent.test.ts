import "./helpers/testenv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/pi-engine/intent.js";

// Covers the intent-router fixes: timer phrasing, unit conversion (was dead
// code), mute/unmute disambiguation, self-referential identity, and status.
const cases: Array<[string, string]> = [
  ["set a timer for 5 minutes", "timer"],
  ["set a 5 minute timer", "timer"],
  ["convert 10 km to miles", "convert"],
  ["10 kg to lb", "convert"],
  ["mute", "mute"],
  ["unmute", "unmute"],
  ["tell me about yourself", "identity"],
  ["who are you", "identity"],
  ["how is my day", "score"],
  ["remind me to call mom", "reminder"],
  ["what is 12 plus 30", "math"],
];

for (const [transcript, expected] of cases) {
  test(`"${transcript}" → ${expected}`, async () => {
    const r = await route(transcript, "en");
    assert.equal(r.intent, expected);
  });
}

test("unit conversion returns the right value", async () => {
  const r = await route("convert 10 km to miles", "en");
  assert.equal((r.side_effect as { result: number }).result, 6.21);
});
