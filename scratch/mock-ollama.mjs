// Minimal mock of the Ollama HTTP API, used to verify AURA's LLM integration
// contract end-to-end WITHOUT downloading a real model. It implements the two
// endpoints AURA calls — /api/tags (health) and /api/generate (narration) —
// and returns shapes identical to real Ollama. Run: node scratch/mock-ollama.mjs
import { createServer } from "node:http";

const PORT = 11434;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }));
      return;
    }
    if (req.url === "/api/generate") {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      const system = String(parsed.system ?? "");
      const prompt = String(parsed.prompt ?? "");
      const isShadow = /Shadow AURA|recommendation/i.test(system);
      const isAgent = /use TOOLS|ReAct|next JSON step/i.test(system + prompt);
      let response;
      if (isShadow) {
        response = JSON.stringify({ recommendation: "silent", confidence: 0.83, reasoning: "Borderline utility and the user is fine right now; staying silent has lower regret." });
      } else if (isAgent) {
        // Drive a genuine 2-step ReAct cycle: first call a tool, then, once an
        // Observation is in the scratchpad, return a final answer that uses it.
        response = /Observation:/i.test(prompt)
          ? JSON.stringify({ thought: "I have the live status; I can answer now.", final: "Here's your day at a glance — I just pulled it from your live status." })
          : JSON.stringify({ thought: "I should check the user's current status first.", tool: "get_status", args: {} });
      } else {
        response = "You're doing well today — readiness is solid and nothing urgent is on deck. Want me to keep an eye on your next meeting?";
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ response, done: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
});

server.listen(PORT, () => console.log(`[mock-ollama] listening on http://localhost:${PORT}`));
