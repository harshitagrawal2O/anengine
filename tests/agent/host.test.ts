import { test } from "node:test";
import assert from "node:assert/strict";
import { recommendModel, type HostSpecs } from "../../src/agent/host.js";

function host(overrides: Partial<HostSpecs> = {}): HostSpecs {
  return {
    platform: "linux",
    cpu_model: "test",
    cpu_cores: 8,
    total_ram_gb: 16,
    free_ram_gb: 8,
    gpu: { vendor: "unknown", name: "none", vram_gb: 0 },
    detected_at: new Date().toISOString(),
    ...overrides,
  };
}

test("CPU-only 16GB box → small tier (snappy 3B)", () => {
  const p = recommendModel(host({ total_ram_gb: 16 }));
  assert.equal(p.tier, "small");
  assert.equal(p.model, "llama3.2:3b");
});

test("CPU-only 6GB box → tiny tier", () => {
  const p = recommendModel(host({ total_ram_gb: 6 }));
  assert.equal(p.tier, "tiny");
});

test("NVIDIA 8GB VRAM → medium (8B)", () => {
  const p = recommendModel(host({ gpu: { vendor: "nvidia", name: "RTX", vram_gb: 8 } }));
  assert.equal(p.tier, "medium");
});

test("NVIDIA 24GB VRAM → large", () => {
  const p = recommendModel(host({ gpu: { vendor: "nvidia", name: "RTX 4090", vram_gb: 24 } }));
  assert.equal(p.tier, "large");
});

test("NVIDIA 48GB VRAM → xl (70B)", () => {
  const p = recommendModel(host({ gpu: { vendor: "nvidia", name: "A6000", vram_gb: 48 } }));
  assert.equal(p.tier, "xl");
  assert.equal(p.model, "llama3.3:70b");
});

test("integrated GPU is ignored; sizing falls back to RAM", () => {
  const p = recommendModel(host({ total_ram_gb: 16, gpu: { vendor: "intel", name: "Iris Xe", vram_gb: 0 } }));
  assert.equal(p.tier, "small");
});

test("OLLAMA_MODEL override wins and is flagged", () => {
  const p = recommendModel(host(), "mistral:7b");
  assert.equal(p.model, "mistral:7b");
  assert.equal(p.source, "env-override");
});
