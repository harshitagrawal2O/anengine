// ── Host capability detection + adaptive local-model selection ───────────────
//
// "Make it generalised — based on specs it will run." This module inspects the
// machine AURA's brain is running on (CPU, RAM, GPU/VRAM) and picks the largest
// local Llama-class model that machine can realistically serve, then scales the
// context window to match. The same binary therefore runs a 1B model on a Pi and
// a 70B model on a workstation with no code change.
//
// Detection is best-effort and never throws: every probe is wrapped, times out
// fast, and falls back to RAM-based sizing so the agent always gets a plan.

import os from "node:os";
import { spawnSync } from "node:child_process";

export type GpuVendor = "nvidia" | "apple" | "amd" | "intel" | "unknown";

export type GpuInfo = {
  vendor: GpuVendor;
  name: string;
  vram_gb: number; // 0 for integrated GPUs — those fall back to RAM-based sizing
};

export type HostSpecs = {
  platform: NodeJS.Platform;
  cpu_model: string;
  cpu_cores: number; // logical cores
  total_ram_gb: number;
  free_ram_gb: number;
  gpu: GpuInfo;
  detected_at: string;
};

export type ModelTier = "tiny" | "small" | "medium" | "large" | "xl";

export type ModelPlan = {
  tier: ModelTier;
  model: string; // Ollama model tag to pull/run
  embed_model: string; // for the RAG "Library" layer (added later)
  num_ctx: number; // context window sized to the tier
  capability_gb: number; // the effective budget we sized against
  reason: string;
  source: "auto" | "env-override";
};

function tryCmd(cmd: string, args: string[]): string | null {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 4000, windowsHide: true });
    if (r.status === 0 && typeof r.stdout === "string" && r.stdout.trim()) return r.stdout.trim();
    return null;
  } catch {
    return null;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function detectGpu(platform: NodeJS.Platform): GpuInfo {
  // 1. NVIDIA on any OS — the most reliable signal, gives exact VRAM.
  const smi = tryCmd("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
  if (smi) {
    const [name, mb] = smi.split(/\r?\n/)[0].split(",").map((s) => s.trim());
    const vram = round1(Number(mb) / 1024);
    if (Number.isFinite(vram) && vram > 0) {
      return { vendor: "nvidia", name: name || "NVIDIA GPU", vram_gb: vram };
    }
  }

  // 2. Apple Silicon — unified memory is shared with the GPU (Metal). Treat ~70%
  //    of system RAM as the GPU budget.
  if (platform === "darwin") {
    const cpu = os.cpus()[0]?.model ?? "";
    if (/Apple/i.test(cpu)) {
      return { vendor: "apple", name: cpu, vram_gb: round1((os.totalmem() / 1e9) * 0.7) };
    }
  }

  // 3. Windows — name the controller so we can tell discrete from integrated.
  if (platform === "win32") {
    const out = tryCmd("powershell", [
      "-NoProfile",
      "-Command",
      "(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name",
    ]);
    if (out) {
      const name = out.split(/\r?\n/)[0].trim();
      const vendor: GpuVendor = /nvidia/i.test(name)
        ? "nvidia"
        : /amd|radeon/i.test(name)
          ? "amd"
          : /intel/i.test(name)
            ? "intel"
            : "unknown";
      return { vendor, name, vram_gb: 0 }; // integrated → 0, RAM-based sizing kicks in
    }
  }

  // 4. Linux without NVIDIA — lspci name only; rely on RAM.
  if (platform === "linux") {
    const lspci = tryCmd("sh", ["-c", "lspci | grep -i 'vga\\|3d\\|display' | head -1"]);
    if (lspci) {
      const name = lspci.replace(/^.*: /, "").trim();
      const vendor: GpuVendor = /amd|radeon/i.test(name) ? "amd" : /intel/i.test(name) ? "intel" : "unknown";
      return { vendor, name, vram_gb: 0 };
    }
  }

  return { vendor: "unknown", name: "unknown", vram_gb: 0 };
}

export function detectHost(): HostSpecs {
  const platform = os.platform();
  const cpus = os.cpus();
  return {
    platform,
    cpu_model: cpus[0]?.model?.trim() ?? "unknown",
    cpu_cores: cpus.length,
    total_ram_gb: round1(os.totalmem() / 1e9),
    free_ram_gb: round1(os.freemem() / 1e9),
    gpu: detectGpu(platform),
    detected_at: new Date().toISOString(),
  };
}

// Capability budget (GB) we size the model against:
//   - Discrete/unified GPU present → use VRAM (GPU inference, fast).
//   - Otherwise → RAM/3 (CPU inference is much slower and shares RAM with the OS;
//     the goal is a model that runs *snappily*, not just one that fits, so we
//     stay conservative and let bigger CPU boxes still climb the ladder).
function capabilityBudget(host: HostSpecs): number {
  if ((host.gpu.vendor === "nvidia" || host.gpu.vendor === "apple") && host.gpu.vram_gb > 0) {
    return host.gpu.vram_gb;
  }
  return round1(host.total_ram_gb / 3);
}

// Tier ladder. Every model here supports Ollama tool/JSON instruction-following,
// so the ReAct agent loop works across the whole range.
const LADDER: Array<{ min: number; tier: ModelTier; model: string; num_ctx: number }> = [
  { min: 40, tier: "xl", model: "llama3.3:70b", num_ctx: 8192 },
  { min: 16, tier: "large", model: "qwen2.5:14b", num_ctx: 8192 },
  { min: 8, tier: "medium", model: "llama3.1:8b", num_ctx: 8192 },
  { min: 4, tier: "small", model: "llama3.2:3b", num_ctx: 4096 },
  { min: 0, tier: "tiny", model: "llama3.2:1b", num_ctx: 2048 },
];

/**
 * Pick the local model for this host. An explicit OLLAMA_MODEL env var always
 * wins (manual override); otherwise we auto-size from the capability budget.
 */
export function recommendModel(host: HostSpecs, envModel?: string): ModelPlan {
  const budget = capabilityBudget(host);
  const rung = LADDER.find((r) => budget >= r.min) ?? LADDER[LADDER.length - 1];

  if (envModel && envModel.trim()) {
    return {
      tier: rung.tier,
      model: envModel.trim(),
      embed_model: "nomic-embed-text",
      num_ctx: rung.num_ctx,
      capability_gb: budget,
      reason: `OLLAMA_MODEL override (auto would pick ${rung.model} for ~${budget}GB budget)`,
      source: "env-override",
    };
  }

  const gpuNote =
    host.gpu.vram_gb > 0
      ? `${host.gpu.name} ${host.gpu.vram_gb}GB VRAM`
      : `${host.gpu.name} (integrated) → CPU inference on ${host.total_ram_gb}GB RAM`;

  return {
    tier: rung.tier,
    model: rung.model,
    embed_model: "nomic-embed-text",
    num_ctx: rung.num_ctx,
    capability_gb: budget,
    reason: `~${budget}GB budget (${gpuNote}) → ${rung.tier} tier`,
    source: "auto",
  };
}

/** Convenience: detect + recommend in one call. */
export function planBrain(envModel?: string): { host: HostSpecs; plan: ModelPlan } {
  const host = detectHost();
  return { host, plan: recommendModel(host, envModel) };
}
