import { config } from "../config.js";

export type LlmRequest = {
  system: string;
  user: string;
  fallback: string;
};

export type OllamaHealth = {
  online: boolean;
  model: string | null;
  checked_at: string;
};

/**
 * Ping Ollama and return whether it's reachable and which model is loaded.
 * Uses a 3-second timeout so callers are never blocked long.
 */
export async function checkOllamaHealth(): Promise<OllamaHealth> {
  const checked_at = new Date().toISOString();
  if (!config.ollama.url) {
    return { online: false, model: null, checked_at };
  }
  try {
    const res = await fetch(`${config.ollama.url}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { online: false, model: null, checked_at };
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    const models = json.models ?? [];
    // Prefer the configured model; fall back to first available.
    const found = models.find((m) => m.name.startsWith(config.ollama.model));
    return {
      online: true,
      model: found?.name ?? models[0]?.name ?? null,
      checked_at,
    };
  } catch {
    return { online: false, model: null, checked_at };
  }
}

export async function narrate(req: LlmRequest): Promise<{ text: string; source: "ollama" | "fallback" }> {
  if (!config.ollama.url) {
    return { text: req.fallback, source: "fallback" };
  }
  try {
    const res = await fetch(`${config.ollama.url}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.ollama.model,
        system: req.system,
        prompt: req.user,
        stream: false,
        options: { temperature: 0.4 },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn("[ollama] not ok, falling back");
      return { text: req.fallback, source: "fallback" };
    }
    const json = (await res.json()) as { response?: string };
    const text = json.response?.trim();
    if (!text) return { text: req.fallback, source: "fallback" };
    return { text, source: "ollama" };
  } catch (e) {
    console.warn("[ollama] failed, falling back:", (e as Error).message);
    return { text: req.fallback, source: "fallback" };
  }
}
