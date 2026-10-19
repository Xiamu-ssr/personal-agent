import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { Schedules, feedDue, schedulePrompt, cronMatches } from "../src/scheduler.mjs";
import { nextCron } from "../src/cron.mjs";
import { Content } from "../src/content.mjs";
import { config, CODE } from "../src/config.mjs";
import { writeJson, readJson } from "../src/store.mjs";
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const local = (time) => new Date(`2026-10-15T${time}:00+08:00`);
const settings = { enabled: true, interval: 30, start: "07:00", end: "23:00" };
const putGoal = (name, cadence = "* * * * *", status = "进行中") => {
  const dir = path.join(config.data, "goals"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + ".md"), `---\ntitle: ${name}\ndomain: 效率\ncadence: "${cadence}"\nstatus: ${status}\nprogress: 0\n---\n## 计划\n计划\n## 步骤\n- [ ] 下一步\n## 记录\n`);
};

test("feed window includes its start, excludes its end and supports 15/30/60 minute intervals and overnight windows", () => {
  for (const [time, expected] of [["06:30", false], ["07:00", true], ["07:15", false], ["07:30", true], ["22:30", true], ["23:00", false]]) assert.equal(feedDue(settings, config.timezone, local(time)), expected, time);
  assert.equal(feedDue({ ...settings, interval: 15 }, config.timezone, local("07:15")), true);
  assert.equal(feedDue({ ...settings, interval: 60 }, config.timezone, local("07:30")), false);
  assert.equal(feedDue({ ...settings, enabled: false }, config.timezone, local("07:00")), false);
  for (const [time, expected] of [["22:00", true], ["00:00", true], ["05:30", true], ["06:00", false], ["12:00", false]]) assert.equal(feedDue({ ...settings, start: "22:00", end: "06:00" }, config.timezone, local(time)), expected);
});

test("cron validates fields, supports steps/ranges/weekdays and exposes the next follow-up in the configured timezone", () => {
  assert.equal(cronMatches("*/15 7-23 * * 1-5", config.timezone, local("07:15")), true);
  assert.equal(cronMatches("0 8 * * 1", config.timezone, new Date("2026-10-19T00:00:00Z")), true);
  assert.equal(cronMatches("0 8 * * 0", config.timezone, new Date("2026-10-18T00:00:00Z")), true);
  assert.equal(nextCron("0 8 * * 1", config.timezone, local("08:00")), "2026-10-19T00:00:00.000Z");
  for (const expr of ["bad", "*/0 * * * *", "60 * * * *", "0 24 * * *", "0 8 0 * *", "0 8 * * 8"]) assert.throws(() => cronMatches(expr, config.timezone));
});

test("schedule prompts read current spec files, replace only placeholders and remove the first-run last-success segment", () => {
  const feed = fs.readFileSync(path.join(CODE, "../spec/prompts/feed.md"), "utf8").trim();
  assert.equal(schedulePrompt("feed", { lastSuccess: "2026-10-15T00:00:00Z" }), feed.replace("<YYYY-MM-DD HH:MM>", "2026-10-15 08:00"));
  assert.equal(schedulePrompt("feed").split("\n")[0], "[动态]");
  const goal = fs.readFileSync(path.join(CODE, "../spec/prompts/goal-checkin.md"), "utf8").trim();
  assert.equal(schedulePrompt("goal", { goal: "运动" }), goal.replaceAll("<Goal ID>", "运动"));
  const tmp = path.join(config.root, "prompt-fixture"); fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, "feed.md"), "供人阅读的说明\n---\n[动态] 上次：<YYYY-MM-DD HH:MM>\n真正提示词");
  assert.equal(schedulePrompt("feed", { prompts: tmp }), "[动态]\n真正提示词");
});

test("feed is single-flight, leaves model selection to the harness, skips overlap, and uses the last successful completion even after a failed run", async () => {
  writeJson(path.join(config.system, "schedule-success.json"), {});
  const calls = [], pending = [], harness = { connectors: { redact: (s) => s }, runIsolated: (...args) => { calls.push(args); const g = gate(); pending.push(g); return g.promise; } };
  let now = local("08:00"); const content = new Content({ root: config.root }); const service = new Schedules({ harness, content, clock: () => now });
  const job = { id: "feed", name: "动态", kind: "feed" };
  const first = await service.run(job); assert.equal(first.mode, "isolated"); assert.equal("model" in calls[0][2], false); assert.equal(calls[0][1].split("\n")[0], "[动态]");
  assert.deepEqual(await service.run(job), { mode: "skipped", reason: "running" }); assert.equal(calls.length, 1);
  now = local("08:05"); const completion = service.active.get("feed").done; pending[0].resolve({ ok: true }); await completion;
  await service.run(job); assert.equal(calls[1][1].split("\n")[0], "[动态] 上次：2026-10-15 08:05");
  const failed = service.active.get("feed").done; now = local("08:35"); pending[1].resolve({ ok: false }); await failed;
  await service.run(job); assert.match(calls[2][1], /^\[动态\] 上次：2026-10-15 08:05/); pending[2].resolve({ ok: true }); await service.active.get("feed").done;
});

test("tick scans goals into main runs while feed and Monday ideas remain isolated", async () => {
  fs.rmSync(path.join(config.data, "goals"), { recursive: true, force: true });
  fs.rmSync(path.join(config.system, "schedule-overrides.json"), { force: true });
  const calls = [], harness = { runIsolated: async (...args) => { calls.push(args); return { ok: true }; }, runMain: async (...args) => { calls.push(["主会话", ...args]); return { ok: true }; } };
  const content = new Content({ root: config.root }); content.putFeedSettings(settings);
  writeJson(config.scheduleFile, [{ id: "feed", name: "动态", kind: "feed" }, { id: "ideas", kind: "ideas", cron: "0 8 * * 1" }]);
  let now = new Date("2026-10-19T00:00:00Z"); const service = new Schedules({ harness, content, clock: () => now });
  putGoal("每分钟目标"); service.tick(); await tick();
  assert.equal(calls.length, 3); assert.ok(calls.some((c) => c[0] === "主会话" && c[1].startsWith("[Goal 推进] 每分钟目标"))); assert.ok(calls.some((c) => c[1].startsWith("[点子]")));
  service.tick(); await tick(); assert.equal(calls.length, 3);
  putGoal("每分钟目标", "0 9 * * *"); putGoal("新目标"); now = new Date("2026-10-19T00:01:00Z"); service.tick(); await tick(); assert.equal(calls.length, 4); assert.ok(calls.at(-1)[1].startsWith("[Goal 推进] 新目标"));
  fs.unlinkSync(path.join(config.data, "goals/新目标.md")); now = new Date("2026-10-19T00:02:00Z"); service.tick(); await tick(); assert.equal(calls.length, 4);
  service.setEnabled("goal:每分钟目标", false); assert.equal(service.list().find((j) => j.id === "goal:每分钟目标").nextRun, null);
  service.setEnabled("feed", false); assert.equal(content.feedSettings().enabled, false);
  content.putFeedSettings({ enabled: true }); assert.equal(service.jobs().find((j) => j.id === "feed").enabled, true);
});

test("non-model health work appears as a running activity and retains the actual device-offline result", async () => {
  const health = gate(), records = new Map(), events = [], running = new Map();
  const harness = { running, bus: { emit: (e) => events.push(e) }, history: { put: (id, patch) => records.set(id, { ...records.get(id), ...patch }) }, runIsolated() { throw new Error("health must not call the model"); } };
  const service = new Schedules({ harness, health: { sync: () => health.promise }, content: new Content({ root: config.root }) });
  const accepted = await service.run({ id: "health-sync", kind: "health-sync", name: "健康同步" });
  assert.equal(running.has(accepted.id), true); assert.equal(records.get(accepted.id).status, "running");
  const finished = service.active.get("health-sync").done; health.resolve({ note: "手机不在线，保留已有数据" }); await finished;
  assert.equal(running.size, 0); assert.equal(records.get(accepted.id).latestResult, "手机不在线，保留已有数据"); assert.deepEqual(events.map((e) => e.phase), ["started", "done"]);
});

test("a failed health activity settles the avatar as an error after removing its running entry", async () => {
  const running = new Map(), settled = [], records = new Map();
  const harness = { running, avatar: { working() {}, settle: (ok) => settled.push({ ok, running: running.size }) }, history: { put: (id, patch) => records.set(id, { ...records.get(id), ...patch }) } };
  const service = new Schedules({ harness, health: { sync: async () => { throw new Error("fixture sync failed"); } }, content: new Content({ root: config.root }) });
  const { id } = await service.run({ id: "health-sync", kind: "health-sync", name: "健康同步" });
  await assert.rejects(service.active.get("health-sync").done, /fixture sync failed/);
  assert.equal(records.get(id).status, "error");
  assert.deepEqual(settled, [{ ok: false, running: 0 }]);
});
