import { createHmac } from "node:crypto";
import { db } from "../db.js";
import { config } from "../config.js";

const GENESIS = "0".repeat(64);

function sign(prevHash: string, payload: string, ts: string): string {
  return createHmac("sha256", config.audit.secret)
    .update(prevHash)
    .update("|")
    .update(ts)
    .update("|")
    .update(payload)
    .digest("hex");
}

const lastHashStmt = db.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1");
const insertStmt = db.prepare(
  "INSERT INTO audit_log (ts, kind, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?)",
);

export function append(kind: string, payload: unknown): { hash: string; prev_hash: string } {
  const ts = new Date().toISOString();
  const body = JSON.stringify(payload);
  const last = lastHashStmt.get() as { hash: string } | undefined;
  const prev = last?.hash ?? GENESIS;
  const hash = sign(prev, body, ts);
  insertStmt.run(ts, kind, body, prev, hash);
  return { hash, prev_hash: prev };
}

type AuditRow = {
  id: number;
  ts: string;
  kind: string;
  payload: string;
  prev_hash: string;
  hash: string;
};

export function verifyChain(): { ok: boolean; broken_at?: number } {
  const rows = db
    .prepare("SELECT id, ts, payload, prev_hash, hash FROM audit_log ORDER BY id ASC")
    .all() as AuditRow[];
  let prev = GENESIS;
  for (const row of rows) {
    if (row.prev_hash !== prev) return { ok: false, broken_at: row.id };
    const expect = sign(prev, row.payload, row.ts);
    if (expect !== row.hash) return { ok: false, broken_at: row.id };
    prev = row.hash;
  }
  return { ok: true };
}

export function tail(n = 50): Array<{
  id: number;
  ts: string;
  kind: string;
  payload: unknown;
  hash: string;
}> {
  const rows = db
    .prepare("SELECT id, ts, kind, payload, hash FROM audit_log ORDER BY id DESC LIMIT ?")
    .all(n) as Array<Omit<AuditRow, "prev_hash">>;
  return rows.map((r) => {
    let payload: unknown;
    try {
      payload = JSON.parse(r.payload);
    } catch {
      // Corrupt or non-JSON payload — surface as a string so the audit endpoint
      // keeps working. The hash chain still verifies independently.
      payload = { _unparseable: true, raw: r.payload };
    }
    return { ...r, payload };
  });
}
