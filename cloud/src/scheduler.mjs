// Minute-tick cron. Jobs live in system/schedule.json so the agent (or the App) can edit them.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { readJson } from "./store.mjs";

function fieldMatches(spec, value) {
  return spec.split(",").some((part) => {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    let lo, hi;
    if (range === "*") [lo, hi] = [0, 99];
    else if (range.includes("-")) [lo, hi] = range.split("-").map(Number);
    else [lo, hi] = [Number(range), stepStr ? 99 : Number(range)];
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

function partsIn(tz, d) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short", hour12: false,
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { min: Number(p.minute), hour: Number(p.hour) % 24, dom: Number(p.day), mon: Number(p.month), dow };
}

export function cronMatches(expr, tz, d = new Date()) {
  const [m, h, dom, mon, dow] = expr.trim().split(/\s+/);
  const t = partsIn(tz, d);
  return fieldMatches(m, t.min) && fieldMatches(h, t.hour) && fieldMatches(dom, t.dom) && fieldMatches(mon, t.mon) &&
    (fieldMatches(dow, t.dow) || (t.dow === 0 && fieldMatches(dow, 7)));
}

// Scratch dirs under workspace/ untouched for 7 days are removed. Plain code, no model call.
export function cleanWorkspace(log) {
  const cutoff = Date.now() - 7 * 86400_000;
  let removed = 0;
  for (const name of fs.readdirSync(config.workspace)) {
    const p = path.join(config.workspace, name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) {
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      }
    } catch {}
  }
  log(`workspace cleanup: removed ${removed}`);
}

// Cron and /api/run share the same routing. Maintenance deliberately has no main-session context.
export async function runScheduledTask(harness, job) {
  const label = job.name || job.id;
  if (/^\[(?:补读|夜间整理)\]/.test(job.prompt || "")) {
    harness.runIsolated(label, job.prompt).catch((e) => harness.log("scheduled maintenance failed:", harness.connectors.redact(e.message)));
    return "isolated";
  }
  await harness.send(`[定时] 该出「${label}」了\n\n${job.prompt || ""}`, "schedule");
  return "alarm";
}

export function startScheduler({ harness, log, clock = () => new Date() }) {
  let lastKey = "";
  const tick = () => {
    const now = clock();
    const key = now.toISOString().slice(0, 16);
    if (key === lastKey) return;
    lastKey = key;
    const jobs = readJson(config.scheduleFile, []);
    for (const job of jobs) {
      if (job.enabled === false || !job.cron) continue;
      let hit = false;
      try {
        hit = cronMatches(job.cron, config.timezone, now);
      } catch (e) {
        log(`bad cron for ${job.id}: ${e.message}`);
      }
      if (!hit) continue;
      log(`cron fire: ${job.id}`);
      if (job.kind === "compact") {
        if (!harness.compactMain()) log("compact skipped: main thread busy");
      } else if (job.kind === "cleanup") {
        cleanWorkspace(log);
      } else {
        runScheduledTask(harness, job).catch((e) => log("cron failed:", harness.connectors.redact(e.message)));
      }
    }
  };
  const timer = setInterval(tick, 15_000);
  tick();
  return { tick, stop: () => clearInterval(timer) };
}
