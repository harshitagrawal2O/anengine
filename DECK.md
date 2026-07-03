# AURA — Pitch Deck Outline (10 slides, ~5 min)

> Style: dark gradient backgrounds (purple→pink), big claims, one number per slide where possible.
> Lean on the `/landing.html` page screenshots — the visual identity is already set.

---

## Slide 1 — Title

**AURA**
*The proactive assistant that learns when to stay silent.*

Sub: a Samsung-native, on-device implementation of cost-sensitive selective intervention.

(Background: the orb. Big.)

---

## Slide 2 — The Problem (5 lines)

> Every assistant you've used is either:
> — a **vending machine** (waits for you to push a button), or
> — a **notification spammer** (interrupts you constantly).
>
> The interesting middle ground — *speaks first, but only when it actually matters* — is technically hard. It's a decision-theoretic problem most teams reduce to ML pattern-matching.

Cite: prior HCI work on poorly timed interruptions imposing significant cognitive cost (ProAgentBench, 2026).

---

## Slide 3 — Our Bet

> **AURA reframes the question.** Instead of "what should I say?", we ask "**should I say anything at all?** "
>
> Every potential nudge is a 2-class decision: speak or stay silent. We compute the cost of each error and only act when the math says staying silent would be worse.

Single big quote on screen:
**"We use code to think. We use the LLM to communicate."**

---

## Slide 4 — The Architecture (4 primitives + 3 layers)

Show the file tree in big monospace:

```
SOUL.md         ← rules + cost weights you write by hand
HEARTBEAT.yaml  ← when AURA acts (cron-like)
TWIN.md         ← what AURA learned about you (auto-generated)
src/skills/     ← what AURA can do (folder per capability)
```

Below it, the decision pipeline:

```
Skill proposes  →  PRISM gate (math)  →  Adversary (always-on critic)  →  Shadow AURA (slow-mode review)  →  Speak / Silent
                                                                                          ↓
                                                                              HMAC-chained audit log
```

90% of behavior changes touch a config file, not code.

---

## Slide 5 — The Math (PRISM gate)

> Every potential nudge runs through:
>
> ```
> p_need × p_accept  >  τ
> τ = C_FA / (C_FA + C_FN)
> ```

Where:
- `p_need` = how likely the user actually needs help right now (from CRS + situational features)
- `p_accept` = how likely they'd accept it (learned per-context from acceptance feedback)
- `τ` = cost-derived threshold (changes by context: pre-meeting, quiet hours, focus block)
- `C_FA` / `C_FN` = false-alarm vs. missed-help cost (from `SOUL.md`)

Citation: Fu et al., *PRISM: Festina Lente Proactivity*, arXiv 2602.01532, 2026.

---

## Slide 6 — Our Contribution (Edge-PRISM)

> The original PRISM paper assumes **server-side teacher distillation** to calibrate the gate.
> That doesn't work on a phone. We extend PRISM along three axes:

1. **On-device acceptance calibration** — every accept/dismiss updates a per-context p_accept estimate. No teacher model needed. Personal in 2 weeks.
2. **Coalitional gating across multiple skills** — when N skills compete for the same window, we gate them jointly so total cognitive load stays within a budget.
3. **HMAC-chained audit trail** — every decision (gate, adversary, shadow) is signed and inspectable. The user can replay why AURA spoke or stayed silent.

The adversary critic and Shadow AURA are additional layers beyond the original paper.

---

## Slide 7 — Evaluation (the numbers slide)

| Strategy | Nudges/day | False-alarm rate | F1 |
|---|---|---|---|
| Always-speak | 46.6 | 100% | 0.196 |
| Never-speak | 0.0 | 0% | 0.000 |
| Fixed-threshold heuristic | 12.1 | 22.0% | 0.344 |
| PRISM gate alone | 6.6 | 10.4% | 0.391 |
| + Edge-Calibration | 6.4 | 9.9% | 0.392 |
| **+ Adversary (us, full stack)** | **5.8** | **8.9%** | **0.393** |

**Headline (vs always-speak):**
- 88% fewer notifications
- 91% lower false-alarm rate
- F1 +101%

**vs the most common heuristic (fixed threshold):**
- 52% fewer notifications
- 60% lower false alarm rate
- F1 +14%

*Evaluated on 60 days of seeded behavioral traces (2,796 moments, 10.8% ground-truth-useful), fully deterministic (fixed seed + date anchor → reproduces byte-for-byte). See `eval/results.json`.*

---

## Slide 8 — Demo

> **AURA demoes herself. Click → 90 sec.**

Screenshot of `/simple` with the orb mid-pulse. Caption:
*"This 90-second clip is AURA narrating her own pitch — adding events, triggering decisions, vetoing herself, switching to Hindi. No human controlling it."*

(In the live demo, click the orange **🎭 AURA demoes herself** button. Sit back.)

---

## Slide 9 — Samsung Mapping

| AURA component | Samsung surface |
|---|---|
| Local Ollama LLM | **Samsung Neural SDK / Gauss-on-NPU** (Phase 3 port) |
| Audit log + on-device-only | **Knox + Personal Data Engine** (privacy alignment) |
| `SOUL.md` / `HEARTBEAT.yaml` | **Galaxy AI personalization** (file-driven explainability) |
| Web simulator → .apk | **Galaxy phone foreground service** |
| 4-primitive architecture | **Modular Bixby successor** |

The architecture maps cleanly. Phase 2 is the brain on a laptop. Phase 3 is the same brain on a Galaxy NPU. **Same code, different hardware.**

---

## Slide 10 — Limitations + Ask

**Limitations (be honest — researchers respect this):**
- Ollama on a development laptop is the proxy for on-device LLM; Samsung Neural SDK requires partner access for the production port.
- Acceptance signal currently from Telegram dismiss-rate; richer signal would integrate Galaxy Watch HRV via Samsung Health Data SDK.
- Synthetic behavioral traces; we'd want 30-day live captures from the team to fine-tune cost weights.

**The ask:**
- Phase 3 access to Samsung Neural SDK + Knox for the on-device port.
- Galaxy Watch loaner so we can fold biometric ground-truth into p_need.
- Conversation with Personal Data Engine team about file-driven primitives.

(One-liner close: *"AURA is what proactive AI looks like when you take the burden of interruption seriously. Built for Galaxy."*)

---

## Backup slides (have ready, don't show unless asked)

**B1 — How the audit chain works** (HMAC-SHA256 over prev_hash || ts || payload, replay any decision)

**B2 — Skill catalog** (10 skills today: morning brief, commute guardian, meeting reminder, hydration, standup break, eod wrap, wind down, and 40+ voice intents)

**B3 — Multi-language demo** (English, Hindi, Kannada — both narration and voice input)

**B4 — Threat model** (no outbound network except Telegram + Ollama; turn off WiFi during demo, the agent still works)

**B5 — Future work**
- Anticipatory pre-warming (Edge-PRISM Extension 4): predict high-uncertainty windows, run slow-mode reasoning during idle periods
- Cross-modal sensor fusion for p_need (Extension 5): fuse calendar + motion + location into a single calibrated signal
- Galaxy Watch HRV as a stress co-signal

---

## Speaker notes / pacing

| Time | Slide | What you say |
|---|---|---|
| 0:00-0:30 | 1-2 | "Most assistants are wrong in opposite directions. Spammers or vending machines." |
| 0:30-1:15 | 3-4 | The reframe + the architecture (touch the file tree) |
| 1:15-2:00 | 5-6 | The math (don't dwell — let them read), then the contribution |
| 2:00-3:30 | 7-8 | Numbers → run the auto-demo |
| 3:30-4:15 | 9-10 | Samsung mapping + limitations + ask |
| 4:15-5:00 | Q&A | Backup slides on standby |

**The one number to memorize:** *"85% fewer notifications, F1 doubled, vs always-speak."*

**The one phrase to memorize:** *"We use code to think, the LLM to communicate."*
