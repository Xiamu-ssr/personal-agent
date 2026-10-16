import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { Speech } from "../src/say.mjs";
import { TurnSpeech, SPEECH_REMINDER } from "../src/turn-speech.mjs";
import { Schedules } from "../src/scheduler.mjs";
import { Content } from "../src/content.mjs";
import { ClientRequests } from "../src/client-requests.mjs";
import { config } from "../src/config.mjs";
import { writeJson } from "../src/store.mjs";
import { queryFixture } from "./query-fixture.mjs";

const goal = '---\ntitle: 增肌\ndomain: 健康\ncadence: "0 21 * * *"\nstatus: 追踪中\nprogress: 10\n---\n## 计划\n循序渐进。\n## 步骤\n- [ ] 运动\n## 记录\n';
const put = (rel, text) => { const file = path.join(config.root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const text = (value) => ({ type: "assistant", message: { content: [{ type: "text", text: value }] } });
const finish = (q, value) => { if (value) q.emit(text(value)); q.emit({ type: "result", subtype: "success" }); };
const flush = async (h) => { await tick(); await h.inputChain; await tick(); };
function fixture(t, options = {}) {
  for (const file of [config.chatLog, "activity-index.json"].map((f) => path.isAbsolute(f) ? f : path.join(config.system, f))) fs.rmSync(file, { force: true });
  writeJson(config.stateFile, {});
  const calls = [], events = [];
  const h = new Harness({ hub: new DeviceHub(), bus: { emit: (e) => events.push(e) }, log() {}, queryFactory: queryFixture(calls), ...options }); h.startMain();
  t.after(() => h.close()); return { h, calls, events };
}

test("Stop reminds once for unsaid prose, preserves containment direction and does not reset for an interjection", async (t) => {
  const r = new TurnSpeech(); r.assistant([{ type: "text", text: "用户看不到的回答" }]);
  assert.deepEqual(r.stop(), { decision: "block", reason: SPEECH_REMINDER }); assert.deepEqual(r.stop(), {});
  const duplicate = new TurnSpeech(); duplicate.say("完整答案：测试通过。");
  assert.deepEqual(duplicate.stop({ last_assistant_message: "测试通过。" }), {});
  assert.equal(duplicate.stop({ last_assistant_message: "测试通过。还有新内容。" }).decision, "block");
  const active = new TurnSpeech(); active.assistant([{ type: "text", text: "内部正文" }]); assert.deepEqual(active.stop({ stop_hook_active: true }), {});
  const { h, calls } = fixture(t); await h.send("先工作");
  const stop = calls[0].options.hooks.Stop[0].hooks[0], id = h.main.activityId;
  assert.equal((await stop({ last_assistant_message: "未发出的回答" })).decision, "block");
  await h.send("忙时补一句"); assert.equal(h.main.activityId, id);
  assert.deepEqual(await stop({ last_assistant_message: "第二次仍写正文" }), {});
  finish(calls[0], "这句话只进过程"); await flush(h);
  assert.deepEqual(h.speech.history().filter((m) => m.role === "assistant"), []);
  assert.ok(h.taskHistory(id).items.some((s) => s.text === "这句话只进过程"));
  await h.send("下一轮重置"); assert.equal((await stop({ last_assistant_message: "下一轮的正文" })).decision, "block");
  calls[0].emit({ type: "result", subtype: "success", result: "result 也不能变气泡" }); await flush(h);
  assert.deepEqual(h.speech.history().filter((m) => m.role === "assistant"), []);
});

test("all background prose stays in process, no Stop hook is installed and delegated continuation stays isolated", async (t) => {
  const { h, calls, events } = fixture(t);
  for (const [i, prompt] of ["[动态]", "[点子]", "[夜间整理]", "[补读] 邮件", "健康同步", "委派任务"].entries()) {
    const p = h.runIsolated("后台工作", prompt); await flush(h);
    const q = calls.at(-1), jobId = [...h.isolated.keys()][0]; assert.equal(q.options.hooks.Stop, undefined);
    if (i % 2) q.emit({ type: "result", subtype: "success", result: "内部结果正文" }); else finish(q, "内部结果正文");
    assert.equal((await p).ok, true); assert.ok(h.taskHistory(jobId).items.some((x) => x.text === "内部结果正文"));
  }
  const id = [...h.history.records.keys()].at(-1); await h.sendTask(id, "接着委派"); await flush(h);
  finish(calls.at(-1), "委派续聊正文"); await h.jobChain;
  assert.deepEqual(h.speech.history(), []); assert.equal(events.some((e) => e.t === "say"), false);
});

test("goal check-in waits for native idle, runs on the same main input stream and never writes a trigger user bubble", async (t) => {
  const { h, calls } = fixture(t); put("data/goals/增肌.md", goal);
  const service = new Schedules({ harness: h, content: new Content({ root: config.root }) });
  await h.send("主聊天先忙一会儿"); const main = calls[0];
  main.emit({ type: "system", subtype: "session_state_changed", state: "running" }); await flush(h);
  const accepted = await service.run({ id: "goal:增肌", kind: "goal", goal: "增肌" });
  const done = service.active.get("goal:增肌").done; await flush(h);
  assert.equal(accepted.mode, "main"); assert.equal(main.received.length, 1); assert.equal(calls.length, 1);
  finish(main, "主聊天内部正文"); await flush(h); assert.equal(main.received.length, 1);
  main.emit({ type: "system", subtype: "session_state_changed", state: "idle" }); await flush(h);
  assert.equal(main.received.length, 2); assert.match(main.received[1].message.content, /^\[目标跟进\] 增肌/);
  assert.equal(h.main.activityId, accepted.id); assert.equal(h.runningJobs()[0].title, "跟进目标：增肌");
  h.speech.emit({ text: "今天训练了吗？" }, { activityId: accepted.id }); finish(main); main.emit({ type: "system", subtype: "session_state_changed", state: "idle" }); await done; await flush(h);
  assert.equal(h.speech.history().filter((m) => m.role === "user").length, 1);
  await h.send("练完了"); await flush(h); assert.equal(calls.length, 1); assert.equal(main.received.at(-1).message.content, "练完了"); finish(main);
  assert.doesNotMatch(h.promptContext().hookSpecificOutput.additionalContext, /后台跟进时/);
});

test("only working main rounds enter lists and events, summaries update asynchronously and system rounds follow the same rule", async (t) => {
  let complete; const pending = new Promise((r) => { complete = r; });
  const { h, calls, events } = fixture(t, { summarize: () => pending });
  await h.send("你好"); const pure = h.main.activityId;
  h.speech.emit({ text: "你好呀。" }, { activityId: pure }); finish(calls[0]); await flush(h);
  assert.deepEqual(h.recentJobs(), []); assert.ok(h.taskHistory(pure).items.length);
  await h.send("查资料"); const id = h.main.activityId;
  calls[0].emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "data/memory/profile/总档.md" } }] } }); await flush(h);
  assert.equal(h.runningJobs()[0].title, "处理中"); assert.equal(h.runningJobs()[0].summary, "");
  await h.send("再补一个条件"); assert.equal(h.main.activityId, id);
  h.speech.emit({ text: "查到了。" }, { activityId: id }); finish(calls[0]); await flush(h);
  assert.equal(h.recentJobs()[0].id, id); assert.equal(h.recentJobs()[0].title, "处理中");
  complete({ title: "查询资料", summary: "读取资料后回答了问题" }); await Promise.all([...h.summaryJobs]);
  assert.equal(h.recentJobs()[0].summary, "读取资料后回答了问题");
  assert.ok(events.some((e) => e.t === "activity" && e.phase === "updated" && e.id === id && e.title === "查询资料"));
  assert.equal(events.some((e) => e.t === "activity" && e.id === pure), false);
  calls[0].emit({ type: "system", subtype: "session_state_changed", state: "running" }); await flush(h);
  const systemId = h.main.activityId;
  calls[0].emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } }); finish(calls[0]); calls[0].emit({ type: "system", subtype: "session_state_changed", state: "idle" }); await flush(h);
  assert.ok(h.recentJobs().some((r) => r.id === systemId)); assert.equal(h.history.get(systemId).kind, "chat");
});

test("feed without a new post stays out of lists and events while a published post makes the activity visible", async (t) => {
  const { h, calls, events } = fixture(t); const quiet = h.runIsolated("动态", "[动态]"); await flush(h);
  const quietId = [...h.isolated.keys()][0]; assert.deepEqual(h.runningJobs(), []);
  finish(calls.at(-1), "本次不发帖"); await quiet;
  assert.deepEqual(h.recentJobs(), []); assert.ok(h.taskHistory(quietId).items.length);
  assert.equal(events.some((e) => e.t === "activity" && e.id === quietId), false);
  const posted = h.runIsolated("动态", "[动态]"); await flush(h);
  const [id, active] = [...h.isolated.entries()][0], rel = "data/feed/2026-10-17/0810-新内容.md";
  put(rel, "---\ntitle: 新内容\n---\n帖子正文"); h.noteWrite(rel, active.job);
  assert.equal(h.runningJobs()[0].id, id); finish(calls.at(-1)); await posted;
  assert.equal(h.recentJobs()[0].id, id); assert.ok(h.recentJobs()[0].outputs.includes(rel));
  const bashPosted = h.runIsolated("动态", "[动态]"); await flush(h);
  const bashId = [...h.isolated.keys()][0], bashRel = "data/feed/2026-10-17/0820-脚本写入.md";
  put(bashRel, "---\ntitle: 脚本生成的帖子\n---\n正文"); finish(calls.at(-1)); await bashPosted;
  assert.ok(h.recentJobs().find((a) => a.id === bashId).outputs.includes(bashRel));
});

test("client request ids share pending work, keep the first result and expire ten minutes after acceptance", async () => {
  let time = 0, calls = 0, release; const cache = new ClientRequests({ clock: () => time });
  const pending = new Promise((r) => { release = r; });
  const first = cache.run("same", async () => { calls++; await pending; return { status: 201, body: { id: "first" } }; });
  const repeat = cache.run("same", () => { throw new Error("重复请求不应执行"); }); release();
  assert.deepEqual(await first, await repeat); assert.equal(calls, 1);
  time = 599_999; assert.deepEqual(await cache.run("same", () => null), await first);
  time = 600_000; assert.equal(await cache.run("same", () => ++calls), 2);
  for (const id of [null, 1, "", "x".repeat(65)]) assert.throws(() => cache.run(id, () => {}), /clientId/);
});

test("goal cards reject the whole say until the shared goal parser accepts the file", async () => {
  const root = fs.mkdtempSync(path.join(config.root, "card-")), events = [], speech = new Speech({ root, bus: { emit: (e) => events.push(e) } });
  const tool = speech.tools()[0], file = path.join(root, "data/goals/增肌.md");
  for (const raw of [null, "没有 frontmatter", goal.replace('0 21 * * *', '90 21 * * *'), goal.replace('progress: 10', 'progress: 200')]) {
    if (raw !== null) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, raw); }
    const result = await tool.handler({ text: "目标建好了", cards: [{ type: "browser" }, { type: "goal", name: "增肌" }] }, {});
    assert.equal(result.isError, true); assert.match(result.content[0].text, /data\/goals\/增肌\.md 还没写好.*先按系统提示词/);
    assert.deepEqual(speech.history(), []); assert.equal(events.length, 0);
  }
  fs.writeFileSync(file, goal); assert.notEqual((await tool.handler({ text: "目标建好了", cards: [{ type: "goal", name: "增肌" }] }, {})).isError, true);
  assert.equal(speech.history().length, 1);
});
