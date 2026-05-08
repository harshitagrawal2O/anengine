
import { db, setSetting } from "../src/db.js";

function seed() {
  console.log("Seeding demo data via internal PRISM DB wrapper...");

  const now = new Date();
  const today = now.toISOString().split("T")[0];

  // 1. Calendar Events
  db.prepare("DELETE FROM calendar").run();
  const events = [
    { title: "Samsung PRISM Final Review", start: new Date(now.getTime() + 2 * 3600000), end: new Date(now.getTime() + 3 * 3600000) },
    { title: "Team Lunch & Celebration", start: new Date(now.getTime() + 1 * 3600000), end: new Date(now.getTime() + 2 * 3600000) },
    { title: "Submit Final Documentation", start: new Date(now.getTime() + 24 * 3600000), end: new Date(now.getTime() + 25 * 3600000) },
  ];

  for (const e of events) {
    db.prepare("INSERT INTO calendar (start_ts, end_ts, title, location) VALUES (?, ?, ?, ?)")
      .run(e.start.toISOString(), e.end.toISOString(), e.title, "Virtual / Conference Room");
  }

  // 2. Health Data (Steps)
  db.prepare("DELETE FROM steps WHERE date = ?").run(today);
  for (let h = 0; h < now.getHours(); h++) {
    const count = Math.floor(Math.random() * 500) + 100;
    db.prepare("INSERT INTO steps (date, hour, count) VALUES (?, ?, ?)").run(today, h, count);
  }

  // 3. Health Data (HRV / Stress) - Using internal helper
  setSetting("hrv_stress", "0.85");

  // 4. Memory / Notes
  db.prepare("DELETE FROM notes").run();
  const notes = [
    "Project AURA deployment is almost complete. Need to verify the TWA APK on Android 14.",
    "Budget for cloud infra: keep under $500/month as discussed with mentors.",
    "User preferred language is English, but they also speak Hindi fluently.",
  ];
  for (const n of notes) {
    db.prepare("INSERT INTO notes (ts, body) VALUES (?, ?)").run(new Date().toISOString(), n);
  }

  console.log("Success: Demo data seeded and PRISM internal tables updated.");
}

seed();
