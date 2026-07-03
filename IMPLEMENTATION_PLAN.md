# AURA — Implementation Plan & System Reference

> **Last updated:** 2026-05-08 (audit pass — APK-WIP branch)
> **Project:** Samsung PRISM Hackathon — Proactive Ambient Agent
> **Branch:** `samsung_hack_01-apk-build-wip` (worktree of main)
> **Runtime:** Node.js 22+ (experimental SQLite), TypeScript 5.7, tsx
> **Status:** Backend ✅ COMPLETE. Frontend (PWA) ✅ COMPLETE. APK ✅ BUILT & SIGNED — see [`release/aura-v1.0-release.apk`](./release/aura-v1.0-release.apk) (package `com.ngrok.aura.twa`; signing cert SHA256 verified to match `public/.well-known/assetlinks.json`). ⚠️ The APK is hardcoded to a **build-time tunnel URL that is now dead** — to load it on a device you must rebuild against a live HTTPS endpoint (see §6.1) or deploy the backend to a stable host. This is the one true open item.

---

## ⚡ SUBMISSION CHECKLIST (Do these in order)

> This is the fastest path from current state → submitted APK + working demo.

| # | Task | Status | Where |
|---|---|---|---|
| 1 | Backend runs (`npm run start`) | ✅ verified 2026-06-01 | repo root |
| 2 | Eval is deterministic (`npm run eval`) | ✅ verified (fixed seed + anchor) | `eval/results.json` |
| 3 | PWA serves (`/`, `/simple`, `/dev`, `/activity`, `/metrics`) | ✅ all 200 | `public/` |
| 4 | Auto-demo runs end-to-end with live gate values | ✅ verified | `/api/demo/start` |
| 5 | APK built & signed | ✅ done | [`release/aura-v1.0-release.apk`](./release/aura-v1.0-release.apk) |
| 6 | `assetlinks.json` package + fingerprint match the APK | ✅ corrected & verified | `public/.well-known/assetlinks.json` |
| 7 | **APK loads on a device against a LIVE endpoint** | ⬜ **open** — APK points at a dead tunnel; rebuild against a live URL or deploy backend (see §6.1) | needs JDK 17+ & restored `android.keystore` |
| 8 | Record demo video using `/simple` + auto-demo button | ⬜ (do in-browser; no device needed) | |

---

## 0. Quick Start

```bash
# From worktree root:
cd d:\SAMSUNG_PRISM\p1\samsung_hack_01-apk-build-wip
npm install          # already done, but safe to re-run
npm run dev          # starts daemon on http://localhost:3000
npm run tunnel       # starts ngrok HTTP tunnel → copy the HTTPS URL
npm run reseed       # seeds 14 days of demo data into SQLite
```

Open `http://localhost:3000/simple` in Chrome → the purple-orb PWA is the frontend.

### Environment Variables (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `TICK_INTERVAL_SEC` | `30` | Scheduler loop interval |
| `TELEGRAM_BOT_TOKEN` | *(empty)* | Telegram delivery (falls back to console) |
| `TELEGRAM_CHAT_ID` | *(empty)* | Telegram chat target |
| `OLLAMA_URL` | *(empty)* | Ollama LLM (falls back to templates — **system works without Ollama**) |
| `OLLAMA_MODEL` | `llama3.2` | Model name for narration |
| `AUDIT_HMAC_SECRET` | `dev-secret-change-me` | HMAC key for audit chain |
| `VOICE_ENABLED` | `1` | `0` to disable TTS |
| `AURA_API_KEY` | *(empty)* | API key auth — only enforced in `NODE_ENV=production` |

---

## 1. Architecture Overview

AURA is a **proactive daemon** — it runs in the background and decides *on its own* when to speak. It is NOT a chatbot.

### 1.1 The 4 Primitives

| Primitive | File | Role |
|---|---|---|
| **SOUL** | `SOUL.md` | Hand-authored personality, cost weights, quiet hours |
| **HEARTBEAT** | `HEARTBEAT.yaml` | Cron-like schedule — when skills are eligible to fire |
| **TWIN** | `TWIN.md` + `src/twin/learn.ts` | Learned behavioral model — acceptance rates, patterns |
| **Skills** | `src/skills/*/index.ts` | Isolated logic modules (morning brief, hydration, etc.) |

### 1.2 Decision Pipeline (PRISM)

```
Sensor Data → Fusion (p_need) → Gate (p_need × p_accept > τ) → Adversary (veto?) → Shadow AURA (borderline review) → Deliver or Suppress
```

| Stage | File | Description |
|---|---|---|
| **Sensor Fusion** | `src/pi-engine/fusion.ts` | Softmax-weighted attention across 5 signals → `p_need` |
| **Fast Gate** | `src/pi-engine/gate.ts` | Bayesian threshold: utility vs. calibrated τ |
| **Calibration** | `src/pi-engine/calibration.ts` | Per-context (skill × hour-bucket) adaptive cost tuning |
| **Adversary** | `src/pi-engine/adversary.ts` | 7-rule deterministic critic; can veto weak nudges |
| **Shadow AURA** | `src/pi-engine/shadow.ts` | LLM-based slow-mode counterfactual for borderline calls |

### 1.3 LLM Philosophy

> **Code thinks. LLM speaks.**

The LLM (Ollama) is *only* used for narration. It never triggers decisions. If Ollama is offline, high-quality fallback templates are used. The system is **fully functional without any LLM**.

---

## 2. File Map

```
samsung_hack_01-apk-build-wip/
├── SOUL.md
├── HEARTBEAT.yaml
├── TWIN.md
├── IMPLEMENTATION_PLAN.md         ← This file
├── README.md
├── DECK.md
├── ngrok.yml                      ← Ngrok config (authtoken already set)
├── cloudflared.exe                ← Cloudflare tunnel binary (alternative to ngrok)
├── package.json
├── tsconfig.json
├── public/
│   ├── simple.html                # ← MAIN PWA FRONTEND (purple orb, voice, chat)
│   ├── landing.html               # Landing page (/)
│   ├── dev.html                   # Dev dashboard
│   ├── activity.html              # Activity log
│   ├── app.js                     # Shared JS
│   ├── style.css
│   ├── manifest.webmanifest       # PWA manifest
│   ├── sw.js                      # Service worker
│   ├── icon-192.png / icon-512.png / icon.svg
│   └── .well-known/
│       └── assetlinks.json        # ← Digital Asset Links (SHA256 fingerprint)
├── android-build/
│   └── aura-twa/                  # Bubblewrap-generated TWA Android project
│       ├── twa-manifest.json      # ← TWA config (host, startUrl, signing key)
│       ├── android.keystore       # ← Keystore already generated (✅)
│       ├── build.gradle           # Android Gradle 8.9.1
│       ├── gradle.properties
│       ├── gradlew / gradlew.bat  # Gradle wrapper
│       ├── settings.gradle
│       └── app/                   # Android app module
└── src/
    ├── index.ts                   # Entry point — boots daemon
    ├── config.ts
    ├── db.ts                      # SQLite schema (13 tables, WAL mode)
    ├── scheduler.ts               # Tick loop
    ├── server.ts                  # Express HTTP server (30+ REST endpoints)
    ├── soul.ts / twin.ts / i18n.ts
    ├── server/simulate.ts         # Simulation API router
    ├── pi-engine/                 # PRISM decision engine
    ├── gateway/                   # Ollama, Telegram, Voice, Weather
    ├── skills/                    # 7 active skills
    ├── score/compute.ts           # Day-Readiness Score
    ├── twin/learn.ts
    ├── audit/log.ts               # HMAC-chained audit log
    ├── data/seed.ts               # Demo seeder
    ├── demo/runner.ts             # Auto-demo orchestrator
    └── cli/tick.ts
```

---

## 3. Complete API Reference

Base URL: `http://localhost:3000` (tunneled via ngrok for Android TWA)

### 3.1 Dashboard APIs

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/status` | All dashboard data in one call: score, next event, last message, HRV, voice, ollama |
| `GET` | `/api/score` | Raw Day-Readiness Score |
| `GET` | `/api/last` | Last sent message + next calendar event + voice status |
| `GET` | `/health` | Ollama health check |
| `GET` | `/metrics` | Prometheus-format metrics (text/plain) |
| `GET` | `/api/metrics` | JSON metrics: uptime, request counts, DB stats, memory |

### 3.2 Chat

| Method | Endpoint | Body | Response |
|---|---|---|---|
| `POST` | `/api/say` | `{ transcript: string, lang?: "en"|"hi"|"kn" }` | `{ reply, intent, ... }` |

### 3.3 Skills & Feedback

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/skill_runs` | Last 30 skill executions |
| `POST` | `/api/skill_runs/:id/feedback` | `{ action: "accept"|"dismiss" }` — teaches the gate |
| `GET` | `/api/activity?days=7` | Per-skill + per-day stats + acceptance rate |
| `POST` | `/api/run/morning_brief` | Manually trigger morning brief |
| `POST` | `/api/run/commute_guardian` | Manually trigger commute guardian |
| `POST` | `/api/tick` | Force one scheduler tick |
| `POST` | `/api/learn` | Force TWIN re-learning |
| `GET` | `/api/twin/patterns` | Read current learned patterns |

### 3.4 Calendar

| Method | Endpoint | Body |
|---|---|---|
| `GET` | `/api/calendar` | List all events (50 max) |
| `POST` | `/api/calendar` | `{ start_ts, end_ts, title, location? }` |
| `DELETE` | `/api/calendar/:id` | Remove event |

### 3.5 Sensors (HRV / Galaxy Watch)

| Method | Endpoint | Body | Purpose |
|---|---|---|---|
| `POST` | `/api/hrv` | `{ rmssd: number }` (0–300) | Galaxy Watch HRV ingestion |
| `GET` | `/api/hrv` | — | Current normalised stress + raw RMSSD |

### 3.6 Settings & Voice

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/settings` | All user settings |
| `POST` | `/api/settings` | `{ key: value, ... }` — update settings |
| `GET` | `/api/voice` | Voice enabled status |
| `POST` | `/api/voice` | `{ enabled: boolean }` |
| `POST` | `/api/voice/test` | `{ text: string }` — test TTS |

### 3.7 Audit & Gate Testing

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/audit` | Audit chain verification + last 50 entries |
| `POST` | `/api/gate/test` | `{ skill?, text?, importance? }` — test gate without side effects |
| `GET` | `/api/quiet` | Current quiet-block status |
| `GET` | `/api/twin` | Raw TWIN data |
| `GET` | `/api/soul` | Raw SOUL data |

### 3.8 Simulation (Demo Control Panel)

| Method | Endpoint | Body | Purpose |
|---|---|---|---|
| `POST` | `/api/simulate/reset` | — | Clear all telemetry |
| `POST` | `/api/simulate/scenario/busy` | — | Inject 6 meetings + high stress + low steps |
| `POST` | `/api/simulate/scenario/relaxed` | — | Clear calendar + high steps + low stress |
| `POST` | `/api/simulate/steps` | `{ count?, hour?, date? }` | Inject step data |
| `POST` | `/api/simulate/hrv` | `{ stress: 0.0–1.0 }` | Inject HRV stress |

### 3.9 Demo Orchestration

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/demo/start` | Start auto-demo sequence (client polls `/api/demo/state`) |
| `POST` | `/api/demo/stop` | Stop demo |
| `GET` | `/api/demo/state` | Demo progress |
| `POST` | `/api/narrate` | `{ text }` — push text into AURA's voice + skill_runs log |

---

## 4. Database Schema (SQLite WAL)

File: `data/aura.db` (auto-created on first boot)

| Table | Purpose |
|---|---|
| `events` | Raw telemetry log |
| `calendar` | User's calendar events |
| `sleep` | Sleep records |
| `steps` | Hourly step counts |
| `notifications` | App notification log |
| `skill_runs` | Every skill execution + user feedback |
| `audit_log` | HMAC-chained decision log |
| `scheduler_state` | Per-tick last-run timestamps |
| `prewarm_cache` | Shadow AURA pre-computed verdicts |
| `quiet_blocks` | User-initiated DND periods |
| `notes` | User notes |
| `timers` | User timers |
| `settings` | Key-value config store |

---

## 5. What Is DONE ✅

### 5.1 Core Architecture
- [x] SOUL, HEARTBEAT, TWIN, Skills primitives
- [x] SQLite database with WAL mode + 13 tables
- [x] Scheduler with tick-based execution + local-timezone awareness
- [x] Demo data seeder (14 days of sleep, steps, 20 skill runs)

### 5.2 Decision Engine (PRISM)
- [x] Cross-modal sensor fusion (5 signals, softmax attention weights)
- [x] Bayesian gate with calibrated τ threshold
- [x] Edge-PRISM per-context cost calibration (skill × hour-bucket)
- [x] Adversary critic (7 veto rules, deterministic)
- [x] Shadow AURA slow-mode LLM review (with prewarm caching)
- [x] Sensor decay: HRV fades after 2h, stale steps → neutral

### 5.3 Skills (7 active)
- [x] `morning_brief` — daily agenda + readiness score
- [x] `commute_guardian` — departure timing alerts
- [x] `meeting_reminder` — pre-meeting nudges (every-minute cadence)
- [x] `hydration_reminder` — fuses HRV stress + time-of-day + activity
- [x] `standup_break` — 2-hour sedentary window detection
- [x] `eod_wrap` — day quality summary + tomorrow prep
- [x] `wind_down` — adaptive bedtime coach based on tomorrow's calendar

### 5.4 Gateways
- [x] Telegram delivery (with console fallback)
- [x] Ollama LLM narration (with template fallback)
- [x] Voice TTS: macOS (`say`) + Windows (PowerShell SpeechSynthesizer)
- [x] Weather: Open-Meteo API
- [x] Chat: Full intent router (`POST /api/say`) with timer/note/quiet/settings actions

### 5.5 Server & API
- [x] Express server with 30+ REST endpoints
- [x] CORS: wildcard origin (safe for single-user daemon)
- [x] Localtunnel/ngrok bypass headers on every response
- [x] Global error handler (async-safe via `wrap()`)
- [x] Request body size cap (256 kb)
- [x] Input validation on all POST endpoints
- [x] Rate limiting: global 100 req/min, `/api/say` 30/min, `/api/hrv` 60/min
- [x] Optional API key auth (`AURA_API_KEY` env var)
- [x] Prometheus-style `/metrics` endpoint
- [x] JSON `/api/metrics` with uptime, request counts, DB stats, memory
- [x] Graceful shutdown: SIGTERM flushes WAL and closes DB

### 5.6 Data Management
- [x] Automated pruning: prewarm (2h), events (30d), audit (90d), notifications (30d)
- [x] Nightly TWIN re-learning (03:00 AM in HEARTBEAT)
- [x] HMAC-chained audit log with verification endpoint

### 5.7 Developer Tooling
- [x] Simulation API (`/api/simulate/*`) for demo scenarios
- [x] Gate test endpoint (`/api/gate/test`)
- [x] Auto-demo orchestrator (`/api/demo/start`)
- [x] Eval harness with 60-day synthetic traces
- [x] `tsc --strict --noEmit` passes with 0 errors

### 5.8 Frontend (PWA — `public/simple.html`)
- [x] Purple ambient orb with floating animation + speaking/listening states
- [x] Language switcher: EN / हिं / ಕ (sends `lang` param to backend)
- [x] Push-to-talk mic button (Web Speech Recognition API)
- [x] Wake-word continuous listening: "Hey AURA" / "OK AURA"
- [x] Voice output via Web Speech Synthesis (premium voice selection)
- [x] Onboarding modal (name, language, quiet hours)
- [x] Settings drawer (name, language, quiet hours, city)
- [x] Offline-resilient: caches last good API responses in localStorage
- [x] Demo banner with progress bar (auto-demo mode)
- [x] Brief me button → triggers `morning_brief`
- [x] Mute/unmute voice toggle
- [x] Service worker registered (`sw.js`) → installable PWA
- [x] PWA manifest (`manifest.webmanifest`) with icons

### 5.9 Android APK (TWA — Trusted Web Activity)
- [x] Bubblewrap TWA project generated in `android-build/aura-twa/`
- [x] `android.keystore` generated (alias: `android`, path hard-coded in `twa-manifest.json`)
- [x] `assetlinks.json` created with correct SHA256 fingerprint from keystore
- [x] `twa-manifest.json` wired to Cloudflare tunnel URL (`las-dsc-snapshot-grace.trycloudflare.com`)
- [x] Gradle 8.9.1 + Android Gradle Plugin in `build.gradle`
- [x] `gradlew.bat` present — can run `./gradlew assembleRelease` on Windows

---

## 6. What Is IN PROGRESS 🔄

### 6.1 APK Build — Final Step

**Situation:** Everything is wired. The keystore exists (`android.keystore`), `assetlinks.json` has the SHA256 fingerprint, and `twa-manifest.json` references the Cloudflare tunnel domain. The only remaining step is to run Gradle.

**Blocker:** The Cloudflare tunnel URL in `twa-manifest.json` (`las-dsc-snapshot-grace.trycloudflare.com`) is **ephemeral** — it changes every time `cloudflared` is restarted. The `assetlinks.json` fingerprint does NOT change (it's tied to the keystore, not the URL), but the **host URL** in `twa-manifest.json` must match the live tunnel URL for the TWA to load.

**Steps to complete the APK:**

```bash
# 1. Start the backend dev server
cd d:\SAMSUNG_PRISM\p1\samsung_hack_01-apk-build-wip
npm run dev

# 2. Start a tunnel — use EITHER ngrok OR cloudflared:
npm run tunnel           # ngrok (recommended — more stable)
# OR: .\cloudflared.exe tunnel --url http://localhost:3000

# 3. Note the public HTTPS URL from the tunnel output, e.g.:
#    https://abc123.ngrok-free.app

# 4. Update twa-manifest.json (3 fields):
#    "host": "abc123.ngrok-free.app"
#    "iconUrl": "https://abc123.ngrok-free.app/icon-512.png"
#    "maskableIconUrl": "https://abc123.ngrok-free.app/icon-512.png"
#    "webManifestUrl": "https://abc123.ngrok-free.app/manifest.webmanifest"
#    "fullScopeUrl": "https://abc123.ngrok-free.app/"
#    "packageId": "com.ngrok.abc123.twa"   (or keep existing)

# 5. Verify assetlinks.json fingerprint matches the keystore:
#    The file already has: 93:27:22:29:B4:EB:... — do NOT change unless you regenerate the keystore.

# 6. Build the APK (from the android-build/aura-twa directory):
cd android-build\aura-twa
.\gradlew.bat assembleRelease

# 7. APK output:
#    app\build\outputs\apk\release\app-release.apk

# 8. Install on Android device:
adb install app\build\outputs\apk\release\app-release.apk
# OR: transfer the APK file manually and side-load it
```

**Requirement:** JDK 17+ must be installed and `JAVA_HOME` set. Android SDK is handled by Gradle (downloads automatically first time).

### 6.2 Tunnel Stability

- **ngrok** is preferred. The `ngrok.yml` authtoken is already configured.
- **Cloudflare** (`cloudflared.exe`) is an alternative — already present in worktree root.
- The ngrok free tier gives a different URL each session → update `twa-manifest.json` each time before building.
- For a **permanent** URL: upgrade ngrok to paid, or deploy the Node.js backend to a free host (Render, Railway) with a stable domain.

---

## 7. What Is LEFT TO DO ⬜

### 7.1 APK Completion (MUST DO)
- [ ] Choose and start a tunnel (ngrok recommended)
- [ ] Update `twa-manifest.json` with current tunnel URL
- [ ] Ensure JDK 17+ is in PATH (`java -version` to check)
- [ ] Run `.\gradlew.bat assembleRelease` in `android-build/aura-twa/`
- [ ] Install and test APK on Android device

### 7.2 Demo Polish (SHOULD DO)
- [ ] Run `npm run reseed` to load fresh 14-day demo data
- [ ] Record demo video: open `/simple`, tap "🎭 AURA demos herself", capture screen
- [ ] Test "Hey AURA" wake word on mobile Chrome

### 7.3 Phase 3: Samsung Hardware Bridge (Post-Hackathon)
- [ ] **Samsung Health Data SDK**: Replace `/api/hrv` stub with real Galaxy Watch HRV stream
- [ ] **Samsung Health Steps**: Replace `/api/simulate/steps` with real pedometer data
- [ ] **Samsung Neural SDK / Gauss-on-NPU**: Port Ollama inference to on-device NPU
- [ ] **Knox Personal Data Engine**: Move SQLite + HMAC audit to Knox secure storage
- [ ] **Foreground Android Service**: Convert Node.js daemon to Android service
- [ ] **Galaxy AI Integration**: Surface TWIN/SOUL into Samsung OS settings

### 7.4 Production Hardening (Post-Hackathon)
- [ ] **Horizontal scaling**: Replace in-process SQLite with PostgreSQL for multi-instance
- [ ] **JWT auth**: Add proper per-user authentication for multi-user support

---

## 8. Known Issues & Mitigations

| Issue | Impact | Fix |
|---|---|---|
| Tunnel URL changes each session | TWA fails to load if `twa-manifest.json` not updated | Update host URL before each build |
| JDK missing from PATH | `./gradlew` fails | Install JDK 17+, set `JAVA_HOME` |
| SQLite is single-writer | Fine for demo; blocks at scale | Phase 3: PostgreSQL |
| Node.js SQLite is "experimental" | Console warning on boot | Harmless; stable in practice |
| Ollama must be running for LLM narration | Fallback templates used instead | Templates are high quality |
| `meeting_reminder` fires every minute | Verbose scheduler logs | By design — needs minute-level precision |
| ngrok free tier URL changes per session | Must rebuild APK with new URL | Use paid ngrok for stable domain |

---

## 9. Commands Reference

```bash
# Backend
npm run dev            # Start daemon with hot-reload (tsx watch) on :3000
npm run start          # Start daemon without hot-reload
npm run seed           # Seed demo data
npm run reseed         # Delete DB + reseed from scratch
npm run tick           # Run one scheduler tick manually
npm run learn          # Run TWIN learner manually
npm run eval           # Run evaluation harness
npm run inspect:audit  # Inspect the audit log
npm run tunnel         # Start ngrok tunnel (uses ngrok.yml authtoken)

# Android build (from android-build/aura-twa/)
.\gradlew.bat assembleDebug     # Debug APK (no signing required)
.\gradlew.bat assembleRelease   # Signed release APK (uses android.keystore)
.\gradlew.bat clean             # Clean build artifacts

# Keystore inspection (to verify fingerprint matches assetlinks.json)
keytool -list -v -keystore android-build\aura-twa\android.keystore -alias android
```

---

## 10. TWA / APK Deep Dive

### How the TWA Works
1. Android opens the APK — it's essentially a native Chrome wrapper.
2. Chrome loads `https://<tunnel-host>/simple` (the purple-orb PWA).
3. The TWA trusts the domain if and only if `/.well-known/assetlinks.json` on that domain contains the SHA256 fingerprint of the signing certificate. This is already set up.
4. Without a matching `assetlinks.json`, Android falls back to a regular Chrome tab (still works for demo, just loses the full-screen TWA experience).

### Key Files & Their Relationship

```
twa-manifest.json
  └── "host": "abc.ngrok.app"           ← must match live tunnel
  └── "signingKey.path": ".../android.keystore"

android.keystore
  └── SHA256 fingerprint → 93:27:22:29:...

public/.well-known/assetlinks.json
  └── "sha256_cert_fingerprints": ["93:27:22:29:..."]
       ← must match keystore fingerprint
       ← served at https://<tunnel-host>/.well-known/assetlinks.json
```

### Package ID Note
Current `packageId` in `twa-manifest.json`: `com.trycloudflare.abraham_wage_grace_harold.twa`
When switching to ngrok, you can keep this or change it. Changing it means a different app on the device.

---

## 11. For Any AI Model Continuing This Work

1. **Read `SOUL.md`** first — personality + constraints.
2. **Read `HEARTBEAT.yaml`** — when each skill fires.
3. **The decision pipeline** is in `src/pi-engine/` — fusion → gate → adversary → shadow.
4. **The main frontend** is `public/simple.html` — a single self-contained HTML file with inline CSS and JS. No build step needed.
5. **All API routes** are in `src/server.ts` (main) and `src/server/simulate.ts` (simulation).
6. **TypeScript strict mode** — run `tsc --noEmit --strict` before committing.
7. **The DB uses Node's built-in `DatabaseSync`** (not better-sqlite3). No `.transaction()` — use `db.exec("BEGIN")` / `db.exec("COMMIT")`.
8. **TWA = Trusted Web Activity** — it is a Chrome wrapper around the PWA. The APK itself has no Android Java/Kotlin code beyond the Bubblewrap scaffold.
9. **The `assetlinks.json` fingerprint is already correct** (matches `android.keystore`). Don't regenerate the keystore unless you also update `assetlinks.json`.
10. **Ngrok authtoken** is set in `ngrok.yml` — just run `npm run tunnel`.

## Final Build Status (verified 2026-06-01)

- **Signed APK**: [`release/aura-v1.0-release.apk`](./release/aura-v1.0-release.apk) — valid, signed (v1 JAR signing: `META-INF/CERT.RSA`).
  - Package: `com.ngrok.aura.twa`
  - Signing cert SHA256: `93:27:22:29:B4:EB:…:1C:9B:E1:7C` — **verified** to match `public/.well-known/assetlinks.json`.
  - `assetlinks.json` `package_name` was corrected from a stale `com.trycloudflare.*` value to `com.ngrok.aura.twa` so Digital Asset Link verification can succeed.
- **Backend / PWA**: ✅ run `npm run start`, open `/simple`. Eval is deterministic (`npm run eval`).
- **⚠️ Known open item — the APK cannot connect as-shipped:** it was built pointing at the ephemeral tunnel `false-busload-squabble.ngrok-free.dev`, which no longer resolves. Free ngrok issues a new random host each session, so that exact host cannot be revived. To make the APK load on a device you must **rebuild** with a live URL (see §6.1) — which also requires restoring `android.keystore` (not committed) — **or** deploy the backend to a stable HTTPS host (Render/Railway/Fly) and rebuild once against that domain.
- **For judges without a device:** the full product runs in any browser at `http://localhost:3000/simple`; the APK is a thin TWA wrapper over that same PWA.
