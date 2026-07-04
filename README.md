# AURA
Last updated: May 8, 2026 (Final Submission Build)

> **The assistant that talks first.** Backed by a 2026 decision-theoretic framework. Runs on your laptop. Speaks only when staying silent would be worse.

[![PRISM](https://img.shields.io/badge/built_on-PRISM_2026-a855f7)](https://arxiv.org/abs/2602.01532)
[![On-Device](https://img.shields.io/badge/on--device-100%25-22c55e)](#privacy)
[![Languages](https://img.shields.io/badge/languages-EN_·_हिं_·_ಕ-ec4899)](#multilingual)
![License](https://img.shields.io/badge/license-MIT-orange)

---

## What it is

AURA is a **proactive personal agent** with a single defining behavior: **she decides when to speak first, instead of waiting for you to ask.**

Most assistants are wrong in opposite directions:
- 🚨 **Notification spammers** interrupt you constantly.
- 🪨 **Voice assistants** (Siri, ChatGPT, Alexa) stay silent until you wake them.

AURA sits in the missing middle. Every potential nudge runs through a cost-sensitive decision-theoretic gate (PRISM, 2026), an always-on adversarial critic, and — when borderline — a slow-mode counterfactual review. Result: **88% fewer notifications than always-speak baselines, F1 +101%.**

The pitch in one line:

> *"We use code to think. We use the LLM to communicate."*

---

## Try it (~30 seconds)

```bash
npm install
npm run dev
```

Optional tunnel (for external UIs):

```bash
npm run tunnel
```

Then open:

| URL | What it is |
|---|---|
| **http://localhost:3000** | Landing page (visitor-facing) |
| **http://localhost:3000/simple** | The app (try this) |
| **http://localhost:3000/dev** | Backstage view (every gate decision, audit chain, calendar editor — judges love this) |
| **http://localhost:3000/activity** | Your weekly stats |
| **http://localhost:3000/metrics** | Prometheus-style metrics |

**Best 90 seconds:** open `/simple`, click the orange **🎭 AURA demoes herself** button, then sit back. AURA narrates her own pitch out loud, triggers her own scenarios, vetoes herself, and finishes in Hindi.

---

## 📂 Project Resources & Structure

For the convenience of mentors and judges, the key submission artifacts have been organized as follows:

| Resource | Path | Description |
|---|---|---|
| **Android APK** | [`release/aura-v1.0-release.apk`](./release/aura-v1.0-release.apk) | Production-ready TWA build for testing on Galaxy devices. |
| **Presentation** | [`docs/presentation/AURA_Hackathon_Presentation.pdf`](./docs/presentation/AURA_Hackathon_Presentation.pdf) | Final technical pitch deck. |
| **Demo Video** | [`demo/aura_technical_demo.mp4`](./demo/aura_technical_demo.mp4) | 4-minute technical walkthrough with live voice interaction. |
| **AI Disclosure** | [`docs/compliance/OpenClaw_AI_Disclosure.docx`](./docs/compliance/OpenClaw_AI_Disclosure.docx) | Mandatory AI usage disclosure for the Samsung PRISM hackathon. |
| **Demo Script** | [`DEMO_SCRIPT.md`](./DEMO_SCRIPT.md) | Narrated guide highlighting the "Amaze Factors" (PRISM Gate, HMAC Audit, etc.) |

### Core Codebase Structure
```text
.
├── release/              # Final Android APK (AURA thin-client)
├── docs/                 # PPT and Compliance documentation
├── demo/                 # Technical demonstration video
├── public/               # Frontend (Landing page, Simple App, Dev Dashboard)
├── src/                  # Core PRISM logic & Agent engine
│   ├── pi-engine/        # Proactive Intelligence (Gate, Critic, Audit)
│   ├── skills/           # Modular proactive capabilities
│   └── gateway/          # Communication layers (Voice, Telegram, WebSocket)
├── scratch/              # Demo seeding scripts (seed_demo.ts)
└── data/                 # Local SQLite database (aura.db)
```

---


## What's inside

### 🧠 The brain (research-backed)

| Layer | What it does | Cite |
|---|---|---|
| **PRISM gate** | Cost-sensitive selective intervention. Computes `p_need × p_accept > τ` for every potential nudge | Fu et al., 2026 ([arxiv 2602.01532](https://arxiv.org/abs/2602.01532)) |
| **Edge-PRISM calibration** *(our extension)* | On-device, per-context acceptance learning from your accept/dismiss feedback | This work |
| **Adversary critic** *(our extension)* | Always-on second opinion that vetoes weak nudges with stated reasons | This work |
| **Shadow AURA** | Slow-mode counterfactual when the gate is borderline | inspired by PRISM dual-process |
| **TWIN learner** | Computes wake time, routines, acceptance rates from event history | builds on smartphone behavioral inference (eB2, 2018) |
| **HMAC-chained audit log** | Every decision is signed and replayable | This work |

### 🛠 The agent (real product)

- **7 proactive skills** that fire on their own: morning brief · commute guardian · meeting reminder · hydration · stand-up break · end-of-day wrap · wind-down · plus on-demand
- **40+ voice commands**: timers, notes, math, unit conversion, Wikipedia, definitions, jokes, volume control, lock screen, screenshots, open URLs / files / apps, web search
- **"Hey AURA" wake word** — toggle it on, talk hands-free
- **Multilingual** — English, हिन्दी, ಕನ್ನಡ (voice in + voice out)
- **Local LLM fallback** — install Ollama, AURA answers freeform questions in her own voice, no cloud
- **Real product polish** — onboarding flow, settings drawer, weekly activity stats, persistent user preferences

### 📁 The 4 primitives

Everything AURA does is configured by **four small files**. 90% of behavior changes never touch the engine.

```
SOUL.md         ← rules + cost weights you write by hand
HEARTBEAT.yaml  ← when AURA acts (cron-like)
TWIN.md         ← what AURA learned about you (auto-generated)
src/skills/     ← what AURA can do (one folder per capability)
```

---

## How a notification is born

```
┌─────────────────────┐
│  HEARTBEAT.yaml     │  → tick fires
└─────────────────────┘
          ↓
┌─────────────────────┐
│  Skill              │  → "I'd like to say X"
└─────────────────────┘
          ↓
┌─────────────────────┐
│  PRISM gate         │  → p_need × p_accept > τ ?
│  (math, fast path)  │
└─────────────────────┘
          ↓                              ↓ borderline?
┌─────────────────────┐         ┌────────────────────┐
│  Adversary critic   │         │  Shadow AURA       │
│  (always)           │         │  (slow-mode LLM)   │
└─────────────────────┘         └────────────────────┘
          ↓
┌─────────────────────┐
│  Speak              │  → Telegram, voice, audit log
│  (or stay silent)   │
└─────────────────────┘
```

Every step writes to an HMAC-chained audit log. Open `/dev` to inspect any decision.

---

## Evaluation

We ran a 60-day synthetic stream of 2,796 potential nudge moments (10.8% ground-truth-useful) through 6 strategies. The run is **fully deterministic** — a fixed RNG seed (42) and a fixed date anchor mean these numbers reproduce byte-for-byte every time. See [`src/eval/harness.ts`](src/eval/harness.ts) and [`eval/results.json`](eval/results.json).

| Strategy | Nudges/day | False-alarm | F1 |
|---|---:|---:|---:|
| Always-speak | 46.6 | 100.0% | 0.196 |
| Never-speak | 0.0 | 0% | 0.000 |
| Fixed threshold | 12.1 | 22.0% | 0.344 |
| PRISM only (baseline) | 6.6 | 10.4% | 0.391 |
| + Edge-Calibration | 6.4 | 9.9% | 0.392 |
| **+ Adversary (us, full stack)** | **5.8** | **8.9%** | **0.393** |

**Headline:**
- vs always-speak: **88% fewer notifications, 91% lower false alarm, F1 +101%**
- vs fixed-threshold: **52% fewer notifications, 60% lower false alarm, F1 +14%**

### Layer-by-layer ablation

How much each PRISM layer contributes, isolating one change at a time (Δ vs the layer above):

| Layer added | Δ nudges/day | Δ false-alarm | Δ F1 |
|---|---:|---:|---:|
| Gate (PRISM) `[C→D]` | −5.47 | −11.6pp | +0.047 |
| + Edge-Calibration `[D→E]` | −0.27 | −0.5pp | +0.001 |
| + Adversary critic `[E→F]` | −0.53 | −1.0pp | +0.001 |

The decision-theoretic gate does the heavy lifting; calibration and the adversary each trim a further slice of false alarms on top. Printed by `npm run eval` and saved to `eval/results.json`.

Run it yourself (same numbers every time):

```bash
npm run eval
```

---

## How to change behavior

| You want to change... | Edit this |
|---|---|
| When AURA acts | [`HEARTBEAT.yaml`](./HEARTBEAT.yaml) |
| Tone, quiet hours, gate cost weights | [`SOUL.md`](./SOUL.md) |
| Add a new capability | New folder in [`src/skills/`](./src/skills/) |
| Score formula | [`src/score/compute.ts`](./src/score/compute.ts) |
| Gate logic | [`src/pi-engine/gate.ts`](./src/pi-engine/gate.ts) |
| Adversary objections | [`src/pi-engine/adversary.ts`](./src/pi-engine/adversary.ts) |
| Voice commands / intents | [`src/pi-engine/intent.ts`](./src/pi-engine/intent.ts) |
| Translations | [`src/i18n.ts`](./src/i18n.ts) |
| Switch from Telegram → WhatsApp | New file in [`src/gateway/`](./src/gateway/) |

User-facing changes (name, language, quiet hours, city) are in **Settings** (gear icon in `/simple`).

---

## Privacy

- **Zero outbound network** by default — Telegram and Ollama are both opt-in.
- **All state stays in `data/aura.db`** (local SQLite).
- **Audit log is HMAC-signed** with a key in your `.env`.
- For the demo: **turn off your WiFi**. AURA still works. That's the privacy proof.

### Security & production hardening

AURA runs untrusted-ish inputs (LLM output, voice text) close to the OS, so it ships with real guardrails:

- **Loopback by default.** The daemon binds `127.0.0.1` — not reachable off-box. Expose it with `HOST=0.0.0.0`, which then **requires** `AURA_API_KEY` (the process refuses to start otherwise).
- **Auth + scoped CORS.** Optional bearer-token auth (constant-time compared), enforced in production and whenever exposed. CORS is an explicit allowlist, not origin-reflection, so a random website can't drive your agent or read your data.
- **Agent tool safety.** The local-LLM agent can *request* OS actions, but sensitive/irreversible tools (lock screen, open app/URL, screenshot, volume) are **blocked unless you explicitly pass `allow_sensitive: true`** per request. Tool args are validated, repeat-loops are capped, and tool output is treated as untrusted data (prompt-injection defense).
- **Safe TTS.** Voice text is passed to the OS speech engine as inert data (never interpolated into a shell command).
- **Tamper-evident audit.** Every decision and tool call is HMAC-chained (covering action type + payload); `GET /api/audit` verifies the chain. The signing key must be non-default in production.
- **Fails fast & clean.** Boot validates config (secret, bind, port); fatal errors exit non-zero for a supervisor to restart; shutdown drains in-flight requests before closing the DB.

Set `NODE_ENV=production`, a private `AUDIT_HMAC_SECRET`, and `AURA_API_KEY` for a production deployment. See `.env.example` for every knob. Typecheck + tests run in CI (`npm run typecheck && npm test`).

---

## Multilingual

| Language | Voice in | Voice out | Notes |
|---|---|---|---|
| English | ✅ Web Speech | ✅ macOS `say` (Samantha) + browser TTS | best-supported |
| हिन्दी | ✅ Web Speech (hi-IN) | ✅ macOS Lekha + browser TTS | works out of the box on Mac |
| ಕನ್ನಡ | ⚠ Chrome only | ⚠ depends on installed voices | falls back to Hindi or English |

For *truly* great voice quality (premium-tier): macOS → System Settings → Accessibility → Spoken Content → System Voice → Manage Voices → download **Ava (Premium)** or **Allison (Premium)**.

---

## Samsung mapping (Phase 3)

| AURA component | Samsung surface |
|---|---|
| Local Ollama LLM | Samsung Neural SDK / Gauss-on-NPU |
| On-device-only + audit log | Knox + Personal Data Engine |
| 4-primitive config files | Galaxy AI personalization |
| Web simulator → .apk | Galaxy phone foreground service |
| 4-primitive architecture | Modular Bixby successor |

Phase 2 (today): brain on a laptop, .apk as a thin client over WiFi.
Phase 3 (next): same brain on the phone via Neural SDK. **Same architecture, different hardware.**

---

## CLI

```bash
npm run dev      # start the daemon (web + scheduler)
npm run reseed   # wipe DB and reseed 14 days of demo data
npm run learn    # recompute TWIN.md from history
npm run tick     # fire one scheduler tick
npm run eval     # run the 60-day evaluation harness
```

---

## Limitations + Future Work

**Be honest:**
- Ollama on a development laptop is the proxy for on-device LLM; the Samsung Neural SDK port requires partner access. The architecture is portable; the hardware bridge is Phase 3.
- Acceptance signal currently comes from `accepted/dismissed` UI buttons. A richer signal would integrate Galaxy Watch HRV via Samsung Health Data SDK as a stress co-signal.
- Synthetic behavioral traces in the eval harness; for the production case we'd want 30-day live captures from the team to fine-tune cost weights.

**Coming next:**
- **Anticipatory pre-warming** (Edge-PRISM Extension 4): predict high-uncertainty decision windows, schedule slow-mode reasoning during idle.
- **Cross-modal sensor fusion** for `p_need` (Extension 5): fuse calendar + motion + location into a single attention-fused signal, deployable via ExecuTorch on the NPU.
- **Galaxy Watch HRV** as a stress co-signal for `c_fa`.

---

## Citations

- **Fu et al.** *PRISM: Festina Lente Proactivity — Risk-Sensitive, Uncertainty-Aware Deliberation for Proactive Agents.* arXiv 2602.01532, 2026.
- **ProAgentBench** (2026): benchmark for proactive intervention timing.
- **PASK** (2026): *Toward Intent-Aware Proactive Agents with Long-Term Memory.*
- **Mem2ActBench** (2026): benchmark for memory-driven proactive action.
- **eB2** (2018): unsupervised behavioral pattern learning from smartphone sensors.
- **On-Device LLMs: State of the Union 2026** — Meta researchers on small local models.

---

## Built for

The Samsung PRISM hackathon, 2026. Project is named after the algorithm that powers it.

> *"AURA is what proactive AI looks like when you take the burden of interruption seriously. Built for Galaxy."*
