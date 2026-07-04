import "./helpers/testenv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db.js";
import { append, verifyChain } from "../src/audit/log.js";

test("append builds a chain that verifies", () => {
  append("test_event_a", { x: 1 });
  append("test_event_b", { y: 2 });
  assert.equal(verifyChain().ok, true);
});

test("tampering with a payload breaks the chain", () => {
  append("test_payload", { value: "original" });
  const row = db.prepare("SELECT id FROM audit_log ORDER BY id DESC LIMIT 1").get() as { id: number };
  db.prepare("UPDATE audit_log SET payload = ? WHERE id = ?").run(JSON.stringify({ value: "forged" }), row.id);
  assert.equal(verifyChain().ok, false);
});

test("tampering with the 'kind' column breaks the chain (kind is signed)", () => {
  // Fresh DB row after the prior break won't re-verify, so assert on the specific
  // broken row: rewriting kind must invalidate the hash.
  const before = db.prepare("SELECT id, kind, hash FROM audit_log ORDER BY id ASC LIMIT 1").get() as {
    id: number; kind: string; hash: string;
  };
  db.prepare("UPDATE audit_log SET kind = ? WHERE id = ?").run(before.kind + "_forged", before.id);
  const result = verifyChain();
  assert.equal(result.ok, false);
  assert.equal(result.broken_at, before.id);
});
