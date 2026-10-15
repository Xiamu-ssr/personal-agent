import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.mjs";
import { readJson } from "./store.mjs";
import { writePrivateJson } from "./private-json.mjs";
import { Content } from "./content.mjs";
import { cronMatches, nextCron, timeParts } from "./cron.mjs";
export { cronMatches } from "./cron.mjs";

export const FEED_MODEL = "anthropic/claude-haiku-5.5";
const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
export function feedDue(settings, timezone, now) {
  if (!settings.enabled) return false;
  const [m, h] = timeParts(timezone, now), current = h * 60 + m, start = minutes(settings.start), end = minutes(settings.end);
  const elapsed = (current - start + 1440) % 1440, length = (end - start + 1440) % 1440;
  return elapsed < length && elapsed % settings.interval === 0;
}
export function schedulePrompt(kind, { lastSuccess, goal, prompts = config.prompts, timezone = config.timezone } = {}) {
  const filename = { feed: "feed.md", goal: "goal-checkin.md", ideas: "ideas.md" }[kind];
  if (!filename) throw new Error("没有这个安排的提示词");
  const raw = fs.readFileSync(path.join(prompts, filename), "utf8");
  const trigger = raw.search(/^\[(?:动态|目标跟进|点子)\]/m);
  let body = (trigger < 0 ? raw : raw.slice(trigger)).trim();
  if (kind === "feed") {
    const formatted = lastSuccess && new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(lastSuccess));
    body = formatted ? body.replace("<YYYY-MM-DD HH:MM>", formatted) : body.replace(/^(\[动态\])[^\r\n]*/, "$1");
  }
  if (kind === "goal") body = body.replaceAll("<目标名>", goal);
  return body;
}
export function cleanWorkspace(log) {
  const cutoff = Date.now() - 7 * 86400_000;
  let removed = 0;
  fs.mkdirSync(config.workspace, { recursive: true });
  for (const entry of fs.readdirSync(config.workspace, { withFileTypes: true })) {
    const file = path.join(config.workspace, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const newest = (dir) => Math.max(fs.statSync(dir).mtimeMs, ...fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.isSymbolicLink() ? 0 : e.isDirectory() ? newest(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).mtimeMs));
    if (newest(file) < cutoff) { fs.rmSync(file, { recursive: true, force: true }); removed++; }
  }
  log(`workspace cleanup: removed ${removed}`);
  return removed;
}

export class Schedules {
  constructor({ harness, log = () => {}, health, content = new Content({ root: config.root }), clock = () => new Date(), prompts = config.prompts }) {
    Object.assign(this, { harness, log, health, content, clock, prompts });
    this.lastKey = ""; this.active = new Map();
    this.successFile = path.join(config.system, "schedule-success.json");
  }
  jobs() {
    const jobs = readJson(config.scheduleFile, []), overrides = readJson(path.join(config.system, "schedule-overrides.json"), {});
    for (const job of jobs) if (job.kind === "feed") job.enabled = this.content.feedSettings().enabled;
    for (const goal of this.content.goals().items) if (goal.status === "追踪中") jobs.push({ id: `goal:${goal.name}`, name: `跟进 · ${goal.title}`, kind: "goal", goal: goal.name, cron: goal.cadence, enabled: overrides[`goal:${goal.name}`] !== false });
    return jobs;
  }
  list() {
    const settings = this.content.feedSettings(), now = this.clock();
    return this.jobs().map((job) => {
      const value = { ...job, enabled: job.enabled !== false, running: this.active.has(job.id) };
      if (job.kind === "feed") {
        value.enabled &&= settings.enabled;
        value.interval = settings.interval; value.start = settings.start; value.end = settings.end;
        for (let ts = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000; value.enabled && ts < now.getTime() + 2 * 86400_000; ts += 60_000) {
          if (feedDue(settings, config.timezone, new Date(ts))) { value.nextRun = new Date(ts).toISOString(); break; }
        }
      } else if (value.enabled && job.cron) {
        try { value.nextRun = nextCron(job.cron, config.timezone, now); } catch { value.error = "cron 格式不正确"; }
      }
      value.nextRun ||= null;
      return value;
    });
  }
  setEnabled(id, enabled) {
    if (typeof enabled !== "boolean") throw Object.assign(new Error("enabled 必须是布尔值"), { status: 400 });
    const job = this.jobs().find((j) => j.id === id);
    if (!job) throw Object.assign(new Error("没有这个定时安排"), { status: 404 });
    if (job.kind === "feed") this.content.putFeedSettings({ enabled });
    else if (job.kind === "goal") {
      const file = path.join(config.system, "schedule-overrides.json"), overrides = readJson(file, {});
      overrides[id] = enabled; writePrivateJson(file, overrides);
    } else {
      const jobs = readJson(config.scheduleFile, []);
      jobs.find((j) => j.id === id).enabled = enabled; writePrivateJson(config.scheduleFile, jobs);
    }
    return this.list().find((j) => j.id === id);
  }
  async run(jobOrId) {
    const job = typeof jobOrId === "string" ? this.jobs().find((j) => j.id === jobOrId) : jobOrId;
    if (!job) throw Object.assign(new Error("没有这个定时安排"), { status: 404 });
    if (this.active.has(job.id)) return { mode: "skipped", reason: "running" };
    const id = crypto.randomUUID(), label = job.name || job.id;
    let done;
    if (job.kind === "health-sync" || job.kind === "cleanup" || job.kind === "compact") {
      let succeeded = true;
      this.harness.history?.put(id, { title: label, kind: "maintenance", status: "running" });
      this.harness.running?.set(id, { label, started: Date.now() });
      this.harness.bus?.emit({ t: "activity", phase: "started", id, title: label, ts: Date.now() });
      this.harness.avatar?.working();
      done = Promise.resolve().then(async () => {
        this.harness.step?.(id, "tool", label, job.kind);
        let message = "已完成", ok = true;
        if (job.kind === "health-sync") message = (await this.health.sync())?.note || "健康同步完成";
        else if (job.kind === "cleanup") message = `已清理 ${cleanWorkspace(this.log)} 个过期草稿目录`;
        else if (!this.harness.compactMain()) { message = "主聊天正在工作，本次整理跳过"; ok = false; }
        const status = ok ? "done" : "stopped";
        this.harness.history?.put(id, { status, endedAt: Date.now(), latestResult: message });
        this.harness.bus?.emit({ t: "activity", phase: "done", id, title: label, status, ts: Date.now() });
        return { ok };
      }).catch((e) => {
        succeeded = false;
        this.harness.history?.put(id, { status: "error", endedAt: Date.now(), latestResult: e.message });
        this.harness.bus?.emit({ t: "activity", phase: "done", id, title: label, status: "error", ts: Date.now() });
        throw e;
      }).finally(() => { this.harness.running?.delete(id); this.harness.avatar?.settle(succeeded); });
    } else {
      const success = readJson(this.successFile, {});
      const prompt = ["feed", "goal", "ideas"].includes(job.kind) ? schedulePrompt(job.kind, { lastSuccess: success[job.id], goal: job.goal, prompts: this.prompts }) : job.prompt;
      if (typeof prompt !== "string" || !prompt.trim()) throw new Error("定时安排缺少提示词");
      done = this.harness.runIsolated(label, prompt, { id, ...(job.kind === "feed" && { model: FEED_MODEL }) });
    }
    this.active.set(job.id, { id, done });
    const finished = done.then((result) => {
      if (result?.ok !== false) {
        const success = readJson(this.successFile, {}); success[job.id] = this.clock().toISOString(); writePrivateJson(this.successFile, success);
      }
      this.content.discoverFeed();
      return result;
    }).finally(() => this.active.delete(job.id));
    this.active.get(job.id).done = finished;
    finished.catch((e) => this.log("scheduled activity failed:", this.harness.connectors?.redact(e.message) || e.message));
    return { mode: "isolated", id };
  }
  tick() {
    this.content.discoverFeed();
    const now = this.clock(), key = now.toISOString().slice(0, 16);
    if (key === this.lastKey) return;
    this.lastKey = key;
    const settings = this.content.feedSettings();
    for (const job of this.jobs()) {
      if (job.enabled === false) continue;
      try {
        const hit = job.kind === "feed" ? feedDue(settings, config.timezone, now) : job.cron && cronMatches(job.cron, config.timezone, now);
        if (hit) this.run(job).catch((e) => this.log("cron failed:", e.message));
      } catch (e) { this.log(`bad cron for ${job.id}: ${e.message}`); }
    }
  }
  start() { this.timer = setInterval(() => this.tick(), 15_000); this.timer.unref?.(); this.tick(); return this; }
  stop() { clearInterval(this.timer); }
}
const controllers = new WeakMap();
export function schedulerFor(options) {
  if (!controllers.has(options.harness)) controllers.set(options.harness, new Schedules(options));
  return controllers.get(options.harness);
}
export async function runScheduledTask(harness, job, options = {}) { return (await schedulerFor({ harness, ...options }).run(job)).mode; }
export function startScheduler(options) { return schedulerFor(options).start(); }
