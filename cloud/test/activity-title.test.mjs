import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { TaskHistory } from "../src/task-history.mjs";
import { config } from "../src/config.mjs";
import { appendJsonl, writeJson } from "../src/store.mjs";
import { queryFixture } from "./query-fixture.mjs";

const cases = [
  ["[第一次聊天] 设备：mac", "第一次聊天"],
  ["[动态] 上次：2026-10-15 08:00\n本地动态指令", "看看有没有新动态"],
  ["[目标跟进] 每周运动\n本地目标指令", "跟进目标：每周运动"],
  ["[点子]\n本地点子指令", "想一批点子"],
  ["[夜间整理]\n本地整理指令", "夜间整理"],
  ["[补读] 测试手机\n来源：本地测试", "补读 测试手机"],
];
async function flush(h) { await tick(); await h.inputChain; await tick(); }
function setup(t) {
  fs.rmSync(config.chatLog, { force: true }); fs.rmSync(path.join(config.system, "activity-index.json"), { force: true });
  writeJson(config.stateFile, {});
  const calls = [], events = [];
  const h = new Harness({ hub: new DeviceHub(), bus: { emit: (e) => events.push(e) }, log() {}, queryFactory: queryFixture(calls, { onInput(q) {
    if (!q.options.perTaskStopAffordance) q.emit({ type: "result", subtype: "success" });
  } }) });
  h.startMain(); t.after(() => h.close()); return { h, calls, events };
}

test("main trigger activities use friendly titles in events, live lists, completed lists and details", async (t) => {
  const { h, calls, events } = setup(t);
  for (const [prompt, title] of cases) {
    const id = await h.send(prompt); await flush(h);
    assert.equal(h.runningJobs().find((r) => r.id === id).title, title);
    assert.equal(events.find((e) => e.t === "activity" && e.id === id && e.phase === "started").title, title);
    assert.equal(calls[0].received.at(-1).message.content, prompt);
    calls[0].emit({ type: "result", subtype: "success" }); await flush(h);
    assert.equal(h.taskHistory(id).title, title); assert.equal(h.recentJobs().find((r) => r.id === id).title, title);
    assert.equal(h.history.get(id).instruction, prompt);
  }
});

test("isolated trigger activities use friendly titles before launch and at completion without changing model prompts", async (t) => {
  const { h, calls, events } = setup(t);
  for (const [index, [prompt, title]] of cases.entries()) {
    const id = `trigger-title-${index}`, p = h.runIsolated("安排的原始名称", prompt, { id });
    assert.equal(h.runningJobs().find((r) => r.id === id).label, title);
    await p;
    assert.equal(h.taskHistory(id).title, title); assert.equal(h.recentJobs().find((r) => r.id === id).label, title);
    assert.equal(calls.at(-1).received[0].message.content, prompt);
    assert.ok(events.filter((e) => e.t === "activity" && e.id === id).every((e) => e.title === title));
  }
});

test("ordinary chat summaries, unknown brackets and explicit side chat titles retain their existing behavior", async (t) => {
  const { h, calls } = setup(t);
  for (const text of ["帮我规划一下周末\n我们想去公园", "我想讨论 [动态] 这个功能", "[自定义] 这是用户自己的文字", "[动态]这个不是系统触发格式", "一段普通的聊天内容。".repeat(8)]) {
    const id = await h.send(text); await flush(h);
    assert.equal(h.taskHistory(id).title, "聊天 · " + text.replace(/\s+/g, " ").slice(0, 36));
    assert.equal(h.speech.history().at(-1).text, text);
    calls[0].emit({ type: "result", subtype: "success" }); await flush(h);
  }
  const automatic = await h.createSideChat("[目标跟进] 读书"); await h.jobChain;
  assert.equal(h.taskHistory(automatic).title, "跟进目标：读书");
  const named = await h.createSideChat("[点子]", [], "独立讨论"); await h.jobChain;
  assert.equal(h.taskHistory(named).title, "独立讨论");
  await h.runIsolated("用户自定义安排", "没有内部触发的本地指令", { id: "custom-title" });
  assert.equal(h.taskHistory("custom-title").title, "用户自定义安排");
});

test("existing titles remain unchanged when read, reloaded or continued", async (t) => {
  const { h } = setup(t);
  const id = "existing-title", title = "聊天 · [第一次聊天] 设备：mac";
  h.history.put(id, { kind: "isolated", title, status: "done", instruction: "[第一次聊天] 设备：mac", steps: [] });
  assert.equal(h.taskHistory(id).title, title); assert.equal(h.recentJobs().find((r) => r.id === id).title, title);
  const loaded = new TaskHistory({ root: config.root, sessions: config.sessions, redact: (s) => s });
  assert.equal(loaded.history(id).title, title);
  await h.sendTask(id, "[点子]\n继续已有活动"); await h.jobChain;
  assert.equal(h.taskHistory(id).title, title);
});

test("first-chat markers stay internal while ordinary user messages and assistant replies remain visible", async (t) => {
  const { h, calls, events } = setup(t);
  appendJsonl(config.chatLog, { role: "user", id: "internal-onboarding", text: "[第一次聊天] 设备：mac", source: "onboarding", ts: Date.now() });
  assert.deepEqual(h.speech.history(), []);
  assert.deepEqual(await h.firstChat("android"), { started: false });
  await h.send("用户自己输入的 [第一次聊天] 说明"); await flush(h);
  const reply = h.speech.emit({ text: "这是正常回复" }, { activityId: h.main.activityId });
  assert.deepEqual(h.speech.history().map((m) => m.text), ["用户自己输入的 [第一次聊天] 说明", "这是正常回复"]);
  assert.equal(h.speech.history(1)[0].id, reply.id);
  assert.equal(events.filter((e) => e.t === "user").length, 1);
  calls[0].emit({ type: "result", subtype: "success" }); await flush(h);
});
