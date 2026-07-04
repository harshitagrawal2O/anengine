# AURA — project context for Claude Code

AURA started as a Samsung PRISM hackathon submission (a proactive on-device
assistant) and is now being evolved into a **local, JARVIS-style agent**: a
brain that reasons with a local Llama model, controls real tools/devices,
learns from feedback, and is fully voice-driven. Read this file before making
changes — it's the fast path to full context.

## North Star (user's words)

Control all edge devices / other machines on the network and get work done on
them; reinforcement-style learning so it improves on its own; run locally on
Llama (Ollama), auto-scaling to whatever hardware it's on; fully voice
controlled; internet-connected knowledge base (RAG); eventually a hologram
visualization of what it's doing.

**Honest framing:** movie-JARVIS general intelligence isn't achievable. The
*experience* — reasons, acts, controls devices, learns, is web-grounded, is
visualized — is buildable in phases. Hologram is hardware-gated (needs a
physical display). True open-ended self-improvement is a research frontier;
what we build is an online calibration + memory loop, not that.

## Roadmap (in order — each phase builds on the last)

1. **Brain** — local-Llama agent loop. ✅ **DONE**, see below.
2. **Hands** — device control (Home Assistant / MQTT / OS / other machines on
   the network). **NOT STARTED — likely next.**
3. **Library** — web fetch + local vector RAG for a real knowledge base.
4. **Voice** — full-duplex, always-listening control (today it's push-to-talk +
   wake word in the PWA, not continuous).
5. **Learning** — turn Edge-PRISM calibration into a real reward+memory loop.
6. **Hologram** — a render/state feed → physical display hardware. Do this last.

## What's built (Phase 1 — The Brain)

- `src/agent/host.ts` — detects CPU/RAM/GPU (`detectHost`, cached via
  `detectHostCached`) and picks a Llama tier: tiny/small/medium/large/xl
  (`recommendModel`). CPU-only sizes off `RAM/3` (conservative — snappy, not
  just "fits"); GPU sizes off VRAM. `OLLAMA_MODEL` env var always overrides.
  Hit `GET /api/host` to see what it picked and why (`plan.reason`).
- `src/agent/tools.ts` — ~19 tools wrapping existing skills/gateways (status,
  weather, wiki, timers, notes, calendar, volume, lock, open app/url,
  screenshot, run morning brief, host info). Every call is HMAC-audit-logged.
  **Tools marked `sensitive: true` (lock/open/screenshot/volume) are BLOCKED
  unless the caller passes `allowSensitive: true`** — this is the safety
  boundary between "LLM can look things up" and "LLM can act on the world."
  Don't weaken this without deliberately deciding to.
- `src/agent/loop.ts` — the ReAct loop: `runAgent(goal, lang, opts)`. Local
  model plans one JSON step at a time (`{"tool":...}` or `{"final":...}`),
  calls tools via `callTool`, feeds the observation back, repeats up to
  `maxSteps` (default 6). Has a repeat-loop guard (same tool+args called >2×
  aborts) and frames tool output as **untrusted data** in the prompt (basic
  prompt-injection defense — a web/tool result can't issue new instructions).
- Server: `POST /api/agent` (`{goal, lang, allow_sensitive}` — falls back to
  the deterministic intent router in `pi-engine/intent.ts` when Ollama is
  unreachable) and `GET /api/host`.

**This machine's detected profile (for reference, will differ on the new
laptop):** i7-1250U, 16GB RAM, Intel Iris Xe (no GPU) → auto-picked
`llama3.2:3b`. On a machine with a real GPU, `/api/host` will pick something
bigger automatically — no code change needed, just pull the model it names.

## Production hardening already done

A full audit (security/robustness/correctness/data/deploy/testing, each
finding adversarially verified) found 30 issues; **all 30 are fixed** and
covered by tests. Highlights, because they constrain how you extend this:

- **Loopback by default.** Server binds `127.0.0.1`. Boot **refuses to start**
  if `HOST` is non-loopback without `AURA_API_KEY` set, and refuses to start
  in `NODE_ENV=production` with the default `AUDIT_HMAC_SECRET`. See
  `validateBootConfig()` in `src/index.ts` — don't bypass it.
- **CORS is an explicit allowlist**, not origin-reflection (`src/server.ts`).
- **TTS is injection-safe** — text is passed to the OS speech engine via env
  var, never interpolated into a shell/PowerShell command string. There's a
  regression test (`tests/security/tts-injection.test.ts`) with a positive
  control proving the old approach *was* exploitable — if you touch
  `src/gateway/voice.ts`, re-run that test.
- **Audit chain is HMAC-signed over `kind` + `payload`** (not just payload) —
  `GET /api/audit` verifies it. `/api/simulate` (demo data) is disabled in
  production and never touches `audit_log`.
- **Any new tool you add to `src/agent/tools.ts`**: if it has a real-world side
  effect that's hard to undo, set `sensitive: true`. If it's just a read or a
  reversible DB write (notes, timers, calendar), `sideEffect: true` is enough.

## Stack + conventions

- Node.js 22.5+ (uses `node:sqlite` `DatabaseSync` — **not** better-sqlite3, no
  `.transaction()`, use `db.exec("BEGIN")`/`COMMIT`/`ROLLBACK`).
- TypeScript, `tsc --strict`, run via `tsx` (no build step, no `dist/`).
- Express server (`src/server.ts`), SQLite (`src/db.ts`, WAL mode, migrations
  via the `MIGRATIONS` array — add new columns/tables there, don't hand-edit
  the schema in place).
- Tests: `node --test` via `tsx`, in `tests/`. Any test touching the DB must
  `import "./helpers/testenv.ts"` **first** (points `AURA_DB_PATH` at a temp
  file so tests never touch the real `data/aura.db`).
- 4 config primitives the non-agent skills read: `SOUL.md`, `HEARTBEAT.yaml`,
  `TWIN.md`, `src/skills/*`.

## Commands

```bash
npm install
cp .env.example .env        # fill in AUDIT_HMAC_SECRET at minimum
npm run typecheck            # tsc --strict, must be 0 errors before you're done
npm test                     # node:test — must stay green
npm run eval                  # deterministic 60-day PRISM eval, writes eval/results.json
npm run seed   # or: npm run reseed   (wipes + reseeds demo data)
npm run start                 # or: npm run dev  (hot reload)
```

Then: `curl localhost:3000/api/host` to see the detected hardware + chosen
model, and `curl -X POST localhost:3000/api/agent -d '{"goal":"..."}'  -H "Content-Type: application/json"` to drive the agent loop.

## New-laptop / Ollama setup

`OLLAMA_URL` and `OLLAMA_MODEL` are read from `.env` / `process.env`. Leave
`OLLAMA_MODEL` **empty** so `src/agent/host.ts` auto-picks based on this
machine's specs — check what it picked via `GET /api/host`, then
`ollama pull <that model tag>`. If you already know you want a bigger model
than the auto-picker suggests (it's deliberately conservative on CPU-only
boxes), set `OLLAMA_MODEL` explicitly to override.

## Where to look for more

- `IMPLEMENTATION_PLAN.md` — detailed system reference, API list, DB schema,
  file map (written for the original hackathon submission; mostly still
  accurate for the non-agent parts).
- `README.md` "Security & production hardening" section — the user-facing
  version of the hardening summary above.
- `src/pi-engine/` — the PRISM decision engine (gate/fusion/adversary/shadow)
  that decides when AURA speaks proactively; unrelated to the new agent loop
  but the agent and this engine will eventually need to cooperate (the agent
  acts on request; PRISM decides whether to interrupt unprompted).

## Do next

Phase 2 (**Hands** — device control) is the natural next step: add tools to
`src/agent/tools.ts` for a real device gateway (Home Assistant REST/MQTT is
the most standard starting point), following the same `sensitive`/audit
pattern as the existing OS tools. Ask the user which devices/network they
actually want controlled before building — don't guess a device inventory.
