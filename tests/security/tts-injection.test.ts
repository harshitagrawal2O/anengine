// Regression test for the PowerShell TTS command-injection RCE.
// Proves that the env-var delivery used by voice.ts does NOT execute a $(...)
// payload, whereas the old interpolation-into-a-double-quoted-string did.
// Windows-only (the vuln is win32-specific); skipped elsewhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const isWin = process.platform === "win32";

test("env-var TTS delivery does not execute an injected payload", { skip: !isWin }, () => {
  const dir = mkdtempSync(resolve(tmpdir(), "aura-tts-"));
  const marker = resolve(dir, "safe.txt");
  if (existsSync(marker)) rmSync(marker);

  // Same construction as voice.ts's fixed Windows path.
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Write-Output $env:AURA_TTS_TEXT"], {
    stdio: "ignore",
    env: { ...process.env, AURA_TTS_TEXT: `hi $(Set-Content -LiteralPath "${marker}" -Value pwned)` },
  });

  assert.equal(existsSync(marker), false, "env-var payload must NOT execute");
  rmSync(dir, { recursive: true, force: true });
});

test("control: the OLD interpolation WOULD have executed it (proves the test is meaningful)", { skip: !isWin }, () => {
  const dir = mkdtempSync(resolve(tmpdir(), "aura-tts-"));
  const marker = resolve(dir, "vuln.txt");
  if (existsSync(marker)) rmSync(marker);

  const payload = `hi $(Set-Content -LiteralPath "${marker}" -Value pwned)`;
  const escaped = payload.replace(/"/g, '""'); // the old (insufficient) escaping
  spawnSync("powershell", ["-NoProfile", "-Command", `Write-Output "${escaped}"`], { stdio: "ignore" });

  assert.equal(existsSync(marker), true, "old interpolation should execute the payload");
  rmSync(dir, { recursive: true, force: true });
});
