// Faithful reproduction of voice.ts's Windows TTS via Node child_process.spawn.
// Control proves powershell launches via spawn; then OLD vs NEW show the vuln/fix.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const dir = "C:/Users/harsh/AppData/Local/Temp/claude/d--Samsung-Hack-samsung-hack-01/cdc1b2d6-16b5-43fb-b2f6-9eefc4afa98e/scratchpad";
const ctl = `${dir}/ctl_node.txt`;
const m1 = `${dir}/vuln_node.txt`;
const m2 = `${dir}/safe_node.txt`;
for (const m of [ctl, m1, m2]) if (existsSync(m)) rmSync(m);

const PS = process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const ps = existsSync(PS) ? PS : "powershell";

// ── CONTROL: does powershell run via spawn at all? ──
const c = spawnSync(ps, ["-NoProfile", "-Command", `Set-Content -Path '${ctl}' -Value ok`], { encoding: "utf8" });
console.log("control spawn status:", c.status, c.error ? `error: ${c.error.message}` : "");

// ── OLD vulnerable construction ──
const payloadOld = `hi $(Set-Content -Path '${m1}' -Value pwned)`;
const escaped = payloadOld.replace(/"/g, '""');
spawnSync(ps, ["-NoProfile", "-Command", `Write-Output "${escaped}"`], { stdio: "ignore" });

// ── NEW secure construction (env var, referenced as data) ──
const payloadNew = `hi $(Set-Content -Path '${m2}' -Value pwned)`;
spawnSync(ps, ["-NoProfile", "-NonInteractive", "-Command", "Write-Output $env:AURA_TTS_TEXT"], {
  stdio: "ignore",
  env: { ...process.env, AURA_TTS_TEXT: payloadNew },
});

console.log("CONTROL powershell ran            :", existsSync(ctl));
console.log("OLD interpolation executed payload:", existsSync(m1), existsSync(m1) ? "  <-- VULNERABLE" : "");
console.log("NEW env-var       executed payload:", existsSync(m2), existsSync(m2) ? "  <-- STILL VULN" : "  <-- safe");
for (const m of [ctl, m1, m2]) if (existsSync(m)) rmSync(m);
