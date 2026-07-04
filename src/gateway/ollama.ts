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

export async function narrate(req: LlmRequest): Promise<{ text: string; source: "ollama" | "gemini" | "fallback" }> {
  // 1. Try Ollama (Local)
  if (config.ollama.url) {
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
        signal: AbortSignal.timeout(45000), // Massive 45s timeout for slow local hardware
      });
      if (res.ok) {
        const json = (await res.json()) as { response?: string };
        const text = json.response?.trim();
        if (text) return { text, source: "ollama" };
      }
    } catch (e) {
      console.warn("[ollama] failed or timed out:", (e as Error).message);
    }
  }

  // 2. Try Gemini (Cloud Fallback)
  if (config.gemini.apiKey) {
    try {
      // Pass the API key as a header, not a URL query param — query strings leak
      // into access logs, proxies, and error messages.
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.gemini.apiKey },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: `System Instructions: ${req.system}\n\nUser Question and Context:\n${req.user}` }]
          }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 250,
          }
        }),
        signal: AbortSignal.timeout(20000), // 20s for cloud
      });
      if (res.ok) {
        const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) return { text, source: "gemini" };
      }
    } catch (e) {
      console.warn("[gemini] fallback failed:", (e as Error).message);
    }
  }

  // 3. Static Fallback (Last resort)
  return { 
    text: req.fallback || "I'm processing a bit slowly right now. Could you repeat that?", 
    source: "fallback" 
  };
}
