const $ = (s) => document.querySelector(s);

function fmtTime(d = new Date()) {
  return d.toTimeString().slice(0, 5);
}

async function jget(url) {
  const r = await fetch(url);
  return r.json();
}

async function jpost(url, body = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

const COMP_LABELS = {
  sleep: "Sleep",
  morning_activity: "Morning steps",
  calendar_prep: "Prep buffer",
  commute_buffer: "Commute slack",
  notifications: "Notif silence",
  focus_time: "Focus block",
  meeting_load: "Meeting load",
};

function renderScore(score) {
  $("#score").textContent = score.total;
  const ring = $("#ring");
  const circumference = 2 * Math.PI * 86;
  ring.setAttribute("stroke-dasharray", circumference.toFixed(2));
  const offset = circumference * (1 - score.total / 100);
  ring.setAttribute("stroke-dashoffset", offset.toFixed(2));

  const compEl = $("#components");
  compEl.innerHTML = "";
  for (const [k, v] of Object.entries(score.components)) {
    const el = document.createElement("div");
    el.className = "comp";
    el.innerHTML = `<span>${COMP_LABELS[k] ?? k}</span><span class="v">${Math.round(v * 100)}</span>`;
    compEl.appendChild(el);
  }

  const next = score.inputs.next_event_min_until;
  $("#next-event").textContent =
    next === null
      ? "No upcoming events"
      : `Next event in ${next} min · sleep ${score.inputs.sleep_min} min · ${score.inputs.notif_24h} notifs/24h`;
}

function renderCalendar(events) {
  const ul = $("#calendar");
  ul.innerHTML = "";
  for (const e of events) {
    const start = new Date(e.start_ts);
    const li = document.createElement("li");
    li.innerHTML = `<span><strong>${e.title}</strong> <span class="meta">${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></span>`;
    const btn = document.createElement("button");
    btn.textContent = "x";
    btn.onclick = async () => {
      await fetch(`/api/calendar/${e.id}`, { method: "DELETE" });
      await refresh();
    };
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

function tag(text, kind) {
  return `<span class="tag ${kind}">${text}</span>`;
}

function renderAudit(data) {
  const status = $("#chain-status");
  if (data.verified.ok) {
    status.textContent = "chain verified ✓";
    status.className = "ok";
  } else {
    status.textContent = `chain broken at ${data.verified.broken_at}`;
    status.className = "bad";
  }
  const ul = $("#audit");
  ul.innerHTML = "";
  for (const e of data.entries.slice(0, 12)) {
    const li = document.createElement("li");
    const time = new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    let extra = "";
    if (e.kind === "gate_decision") {
      const d = e.payload.decision;
      const t = d.intervene ? tag("speak", d.mode === "slow" ? "slow" : "intervene") : tag("silent", "silent");
      extra = ` ${t} <span class="meta">u=${d.utility.toFixed(2)} τ=${d.tau.toFixed(2)}</span>`;
    } else if (e.kind === "notification_sent") {
      extra = ` <span class="meta">→ ${e.payload.channel}</span>`;
    }
    li.innerHTML = `<span><strong>${e.kind}</strong>${extra} <span class="meta">${time}</span></span>`;
    ul.appendChild(li);
  }
}

function renderGate(decision) {
  $("#gate").textContent = JSON.stringify(decision, null, 2);
}

function renderTwin(p) {
  const root = $("#twin");
  const acc = Object.entries(p.acceptance ?? {})
    .map(([k, v]) => `${k}: <strong>${Math.round(v.rate * 100)}%</strong> (${v.accepted}/${v.accepted + v.dismissed})`)
    .join(" · ") || "(no labelled runs yet)";
  root.innerHTML = `
    <div class="kv">
      <div class="k">Wake median</div>
      <div class="v">${p.wake_time.median} <span class="meta">(${p.wake_time.trend}, conf ${p.wake_time.confidence})</span></div>
      <div class="k">Sleep median</div>
      <div class="v">${p.sleep_duration.median_min} min <span class="meta">recent ${p.sleep_duration.recent_avg_min} (${p.sleep_duration.trend})</span></div>
      <div class="k">Acceptance</div>
      <div class="v">${acc}</div>
      <div class="k">Burden 24h</div>
      <div class="v">${p.notif_24h} notifs · score ${p.burden_score}</div>
    </div>
    ${(p.routines ?? []).length ? `<div class="routine-list">${p.routines.map(r => `${r.time} — ${r.activity} <span class="meta">(${r.days_observed}d)</span>`).join("<br/>")}</div>` : ""}
  `;
}

function renderCommute(c) {
  if (!c) {
    $("#commute").textContent = "—";
    return;
  }
  const w = c.weather;
  const r = c.recommendation;
  const next = c.next_event;
  $("#commute").innerHTML = `
    <div class="kv">
      <div class="k">Next event</div>
      <div class="v">${next.title ?? "none"}${next.min_until !== null ? ` · in ${next.min_until} min` : ""}</div>
      <div class="k">Weather</div>
      <div class="v">${Math.round(w.temp_c)}°C · ${w.is_raining_soon ? "rain expected" : "clear"} <span class="meta">(${w.source})</span></div>
      <div class="k">Recommendation</div>
      <div class="v">${r ? `leave in ${r.leave_in_min} min — ${r.reason}` : "no nudge needed"}</div>
      <div class="k">Gate</div>
      <div class="v">${c.decision.intervene ? tag("speak", c.decision.mode === "slow" ? "slow" : "intervene") : tag("silent", "silent")} <span class="meta">u=${c.decision.utility.toFixed(2)} τ=${c.decision.tau.toFixed(2)}</span></div>
    </div>
  `;
}

function renderSkillRuns(rows) {
  const ul = $("#skill-runs");
  ul.innerHTML = "";
  let unlabeled = 0;
  for (const r of rows.slice(0, 10)) {
    const labeled = r.accepted !== null || r.dismissed !== null;
    if (!labeled) unlabeled++;
    const time = new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    let payload = "";
    try {
      const p = JSON.parse(r.payload ?? "{}");
      if (p.text) payload = p.text;
      else if (p.seeded) payload = "(seed)";
    } catch {}
    let labelHtml;
    if (r.accepted === 1) labelHtml = `<span class="label-tag acc">accepted</span>`;
    else if (r.dismissed === 1) labelHtml = `<span class="label-tag dis">dismissed</span>`;
    else labelHtml = `<span class="label-tag unl">unlabeled</span>`;

    const li = document.createElement("li");
    li.className = "skill-run";
    li.innerHTML = `
      <div class="row">
        <strong>${r.skill}</strong> ${labelHtml}
        <span class="meta">${time}</span>
      </div>
      <div class="meta">${payload}</div>
    `;
    if (!labeled) {
      const actions = document.createElement("div");
      actions.className = "actions-row";
      const acc = document.createElement("button");
      acc.className = "accept";
      acc.textContent = "✓ helpful";
      acc.onclick = async () => {
        await jpost(`/api/skill_runs/${r.id}/feedback`, { action: "accept" });
        await refresh();
      };
      const dis = document.createElement("button");
      dis.className = "dismiss";
      dis.textContent = "✗ dismiss";
      dis.onclick = async () => {
        await jpost(`/api/skill_runs/${r.id}/feedback`, { action: "dismiss" });
        await refresh();
      };
      actions.appendChild(acc);
      actions.appendChild(dis);
      li.appendChild(actions);
    }
    ul.appendChild(li);
  }
  $("#skill-runs-meta").textContent = unlabeled > 0 ? `${unlabeled} unlabeled` : "all labeled";
}

function renderOllamaHealth(h) {
  const badge = $("#ollama-badge");
  if (!badge) return;
  const online = h.ollama === "online";
  badge.className = `ollama-badge ${online ? "ollama-online" : "ollama-offline"}`;
  badge.title = online
    ? `Shadow AURA: ONLINE (${h.model ?? "unknown model"})`
    : "Shadow AURA: OFFLINE — slow-mode LLM not available";
}

let lastCommute = null;

async function refresh() {
  const [score, cal, audit, twin, runs, health] = await Promise.all([
    jget("/api/score"),
    jget("/api/calendar"),
    jget("/api/audit"),
    jget("/api/twin/patterns"),
    jget("/api/skill_runs"),
    jget("/health"),
  ]);
  renderScore(score);
  renderCalendar(cal);
  renderAudit(audit);
  renderTwin(twin);
  renderSkillRuns(runs);
  renderOllamaHealth(health);
  if (lastCommute) renderCommute(lastCommute);
}

$("#run-btn").onclick = async () => {
  const r = await jpost("/api/run/morning_brief", { dry_run: false });
  renderGate(r.decision);
  if (r.message) {
    $("#message").textContent = `${r.message.text}  (via ${r.message.source} → ${r.message.channel})`;
  } else {
    $("#message").textContent = `Stayed silent. Reason: ${r.decision.reason}`;
  }
  await refresh();
};

$("#dry-btn").onclick = async () => {
  await jpost("/api/tick", {});
  await refresh();
};

$("#gate-btn").onclick = async () => {
  const r = await jpost("/api/gate/test", { skill: "morning_brief" });
  renderGate(r.decision);
};

$("#commute-btn").onclick = async () => {
  const r = await jpost("/api/run/commute_guardian", { dry_run: false });
  lastCommute = r;
  renderCommute(r);
  renderGate(r.decision);
  if (r.message) {
    $("#message").textContent = `${r.message.text}  (via ${r.message.source} → ${r.message.channel})`;
  } else if (!r.recommendation) {
    $("#message").textContent = `Commute Guardian: no nudge needed (${r.decision.reason}).`;
  } else {
    $("#message").textContent = `Stayed silent. Reason: ${r.decision.reason}`;
  }
  await refresh();
};

$("#learn-btn").onclick = async () => {
  await jpost("/api/learn", {});
  await refresh();
};

$("#add-event").onsubmit = async (e) => {
  e.preventDefault();
  const title = $("#ev-title").value;
  const min = Number($("#ev-min").value);
  const start = new Date(Date.now() + min * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  await jpost("/api/calendar", {
    start_ts: start.toISOString(),
    end_ts: end.toISOString(),
    title,
  });
  $("#ev-title").value = "";
  $("#ev-min").value = "";
  await refresh();
};

setInterval(() => ($("#time").textContent = fmtTime()), 1000);
$("#time").textContent = fmtTime();

setInterval(refresh, 5000);
refresh();
