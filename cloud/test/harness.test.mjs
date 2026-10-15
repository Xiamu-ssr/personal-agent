import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { Harness } from "../src/agent.mjs";
import { ConnectorManager } from "../src/connectors.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { config } from "../src/config.mjs";
import { readJson, writeJson, tailJsonl } from "../src/store.mjs";
import email from "../connectors/qq-mail/index.mjs";
import { queryFixture } from "./query-fixture.mjs";

async function flush(h) { await tick(); await h.inputChain; await tick(); }
function setup(t) {
  const calls = [], events = [];
  fs.rmSync(config.chatLog, { force: true });
  fs.rmSync(path.join(config.system, "activity-index.json"), { force: true });
  writeJson(config.stateFile, { mainSessionId: "same-fictional-session" });
  const connectors = new ConnectorManager({ definitions: [{ ...email, test: async () => {} }] });
  const h = new Harness({ hub: new DeviceHub(), bus: { emit: (e) => events.push(e) }, log() {}, connectors, queryFactory: queryFixture(calls) });
  h.startMain(); t.after(() => h.close());
  return { h, calls, events, connectors };
}
const answer = (q, text = "完成") => { q.emit({ type: "assistant", message: { content: [{ type: "text", text }] } }); q.emit({ type: "result", subtype: "success" }); };

test("busy messages enter the open input immediately and MCP reload waits for idle while preserving the session", async (t) => {
  const { h, calls, connectors } = setup(t); await flush(h);
  await h.send("第一条");
  await connectors.addAccount("qq-mail", { address: "fixture@example.test", password: "fake-harness-password" });
  await h.send("忙时插话"); await h.send("继续补充"); await flush(h);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].received.map((m) => m.message.content), ["第一条", "忙时插话", "继续补充"]);
  assert.equal(tailJsonl(config.chatLog, 100).filter((m) => m.role === "user").length, 3);
  assert.equal("turnQueue" in h, false); assert.equal("updateQueued" in h, false);
  answer(calls[0]); await flush(h);
  assert.equal(calls.length, 2); assert.equal(calls[1].options.resume, "same-fictional-session");
  assert.equal(calls[1].options.mcpServers["qq-mail"].type, "sdk");
  await h.send("下一轮"); await flush(h); assert.equal(calls[1].received.length, 1);
});

test("file guards, model caps and isolated MCP transports remain independent", async (t) => {
  const { h, calls } = setup(t); await flush(h);
  const opts = h.options({ isolated: true, onWrite() {} });
  for (const name of ["doudou", "connectors", "devices", "page"]) assert.notEqual(opts.mcpServers[name].instance, calls[0].options.mcpServers[name].instance);
  const pre = calls[0].options.hooks.PreToolUse;
  assert.equal((await pre[0].hooks[0]({ tool_name: "Read", tool_input: { file_path: "system/connectors/x/accounts.json" } })).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(await pre[1].hooks[0]({ tool_name: "Write", tool_input: { file_path: "data/memory/work/example.md" } }), {});
  assert.equal(opts.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "128000"); assert.equal(opts.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
  assert.equal(opts.allowedTools.includes("mcp__doudou__say"), true);
  for (const server of Object.values(opts.mcpServers)) await server.instance.close();
  await calls[0].options.hooks.PreCompact[0].hooks[0]();
  assert.deepEqual(calls[0].flagSettings.at(-1), { effortLevel: "low", maxEffortLevel: "low" });
  await calls[0].options.hooks.PostCompact[0].hooks[0]();
  assert.deepEqual(calls[0].flagSettings.at(-1), { effortLevel: "max", maxEffortLevel: "max" });
});

test("a closed query is resumed before delivery and its old inbox is never reused", async (t) => {
  const { h, calls } = setup(t); await flush(h); calls[0].close(); await flush(h);
  await h.send("重连时收到"); await flush(h);
  assert.equal(calls.length, 2); assert.equal(calls[1].received[0].message.content, "重连时收到");
  assert.equal(calls[1].options.resume, "same-fictional-session");
});

test("native result still waits for idle but busy interjections never wait for either lifecycle signal", async (t) => {
  const { h, calls } = setup(t), q = calls[0]; await flush(h);
  q.emit({ type: "system", subtype: "session_state_changed", state: "running" }); await flush(h);
  await h.send("通知轮中的插话"); await flush(h); assert.equal(q.received.length, 1);
  answer(q); await flush(h); assert.equal(h.busy, true);
  q.emit({ type: "system", subtype: "session_state_changed", state: "idle" }); await flush(h); assert.equal(h.busy, false);
});

test("say emits separate bubbles, options produce waiting and only one click wins across concurrent requests", async (t) => {
  const { h, calls, events } = setup(t); await flush(h); await h.send("开始");
  const first = h.speech.emit({ text: "先说一句" }, { activityId: h.main.activityId });
  const second = h.speech.emit({ text: "你选哪个？", options: [{ label: "豆豆" }, { label: "小豆", reply: "就叫小豆" }] }, { activityId: h.main.activityId });
  calls[0].emit({ type: "result", subtype: "success" }); await flush(h);
  assert.equal(h.avatar.value.state, "waiting");
  assert.deepEqual(events.filter((e) => e.t === "say").map((e) => e.id), [first.id, second.id]);
  const chosen = await Promise.allSettled([h.chooseOption(second.id, "1"), h.chooseOption(second.id, "0")]);
  assert.equal(chosen.filter((r) => r.status === "fulfilled").length, 1); assert.equal(chosen.find((r) => r.status === "rejected").reason.status, 409);
  await flush(h); assert.equal(calls[0].received.at(-1).message.content, "就叫小豆");
  assert.equal(h.speech.history().find((m) => m.id === second.id).optionsUsed, true);
  const restarted = new Harness({ hub: new DeviceHub(), bus: { emit() {} }, log() {}, queryFactory: queryFixture([]) });
  await assert.rejects(restarted.chooseOption(second.id, "1"), (e) => e.status === 409); restarted.avatar.close();
});

test("plain model prose without say stays visible and tools live only in activity steps", async (t) => {
  const { h, calls, events } = setup(t); await flush(h); await h.send("查邮件"); const id = h.main.activityId;
  calls[0].emit({ type: "assistant", message: { content: [{ type: "text", text: "正文也要显示" }, { type: "tool_use", id: "read-mail", name: "mcp__qq-mail__read", input: { account: "fake" } }] } });
  await flush(h); assert.equal(h.avatar.value.text, "在看你的邮件");
  calls[0].emit({ type: "result", subtype: "success" }); await flush(h);
  assert.equal(h.speech.history().filter((m) => m.role === "assistant").length, 1);
  assert.equal(h.speech.history().find((m) => m.role === "assistant").fallback, true);
  assert.equal(events.some((e) => e.t === "tool"), false);
  assert.ok(h.taskHistory(id).items.some((i) => i.kind === "tool"));
  assert.equal(h.history.get(id).status, "done");
  const restarted = new Harness({ hub: new DeviceHub(), bus: { emit() {} }, log() {}, queryFactory: queryFixture([]) });
  assert.ok(restarted.taskHistory(id).items.some((i) => i.text === "正文也要显示")); restarted.avatar.close();
});

test("main say hides prose before and after speech, including streamed text and busy interjections", async (t) => {
  const { h, calls, events } = setup(t); await flush(h); await h.send("检查浏览器");
  const q = calls[0], id = h.main.activityId;
  const prose = (text) => {
    q.emit({ type: "stream_event", event: { type: "message_start" } });
    q.emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
    q.emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
  };
  prose("先检查一下浏览器"); await flush(h);
  assert.equal(events.some((e) => e.t === "say" || e.t === "delta"), false);
  const say = h.speech.tools(() => ({ activityId: id }))[0];
  await say.handler({ text: "找到了标题。" }, {});
  await h.send("顺便保留链接"); await flush(h);
  assert.equal(h.main.activityId, id); assert.equal(h.main.said, true);
  await say.handler({ text: "还要继续吗？", options: [{ label: "继续" }] }, {});
  prose("云端浏览器自检完成，已把标题发给用户");
  q.emit({ type: "result", subtype: "success", result: "这也是内部收尾说明" }); await flush(h);
  const bubbles = h.speech.history().filter((m) => m.role === "assistant");
  assert.deepEqual(bubbles.map((m) => m.text), ["找到了标题。", "还要继续吗？"]);
  assert.ok(bubbles.every((m) => !("fallback" in m)));
  assert.equal(events.some((e) => e.t === "delta"), false);
  assert.equal(events.findLast((e) => e.t === "turn_end").text, "");
  for (const text of ["先检查一下浏览器", "云端浏览器自检完成，已把标题发给用户"]) {
    assert.equal(h.taskHistory(id).items.filter((i) => i.text === text).length, 1);
    assert.ok(events.some((e) => e.t === "activity_step" && e.id === id && e.item.text === text));
  }
  assert.equal(h.avatar.value.state, "waiting");
  await h.send("下一轮忘了说话工具");
  assert.notEqual(h.main.activityId, id);
  q.emit({ type: "result", subtype: "success", result: "结果字段也能兜底" }); await flush(h);
  assert.equal(h.speech.history().at(-1).text, "结果字段也能兜底"); assert.equal(h.speech.history().at(-1).fallback, true);
});

test("main fallback keeps multiple prose bubbles in one turn and interjections do not reset it", async (t) => {
  const { h, calls, events } = setup(t); await flush(h); await h.send("不用工具也能回答");
  const q = calls[0], id = h.main.activityId;
  q.emit({ type: "assistant", message: { content: [{ type: "text", text: "第一段回复" }] } }); await flush(h);
  await h.send("再加一句");
  q.emit({ type: "assistant", message: { content: [{ type: "text", text: "第二段回复" }] } }); await flush(h);
  assert.equal(h.main.activityId, id); assert.equal(events.some((e) => e.t === "say"), false);
  q.emit({ type: "result", subtype: "success", result: "不要重复生成结果气泡" }); await flush(h);
  const bubbles = h.speech.history().filter((m) => m.role === "assistant");
  assert.deepEqual(bubbles.map((m) => m.text), ["第一段回复", "第二段回复"]);
  assert.ok(bubbles.every((m) => m.fallback && m.activityId === id)); assert.notEqual(bubbles[0].id, bubbles[1].id);
  assert.equal(h.main.said, false);
  assert.deepEqual(events.filter((e) => e.t === "delta").map((e) => e.id), bubbles.map((m) => m.id));
  for (const bubble of bubbles) assert.equal(h.taskHistory(id).items.filter((i) => i.text === bubble.text).length, 1);
});

test("context recovery retries once without tools, includes all interjections and never duplicates user envelopes", async (t) => {
  const { h, calls } = setup(t); await flush(h); await h.send("第一条要保留"); await h.send("补充也要保留");
  for (let i = 0; i < 2; i++) {
    calls[i].emit({ type: "assistant", error: "invalid_request", message: { content: [{ type: "text", text: "Prompt is too long" }] } });
    calls[i].emit({ type: "result", subtype: "error_during_execution" }); await flush(h);
  }
  assert.equal(calls.length, 3); assert.equal(calls[2].received.length, 0);
  const recovery = JSON.stringify(calls[1].received[0]); assert.match(recovery, /第一条要保留/); assert.match(recovery, /补充也要保留/);
  assert.equal(tailJsonl(config.chatLog, 100).filter((m) => m.role === "user").length, 2);
  assert.equal(calls[1].options.resume, undefined);
});

test("a turn with tool side effects cannot be replayed automatically", async (t) => {
  const { h, calls } = setup(t); await flush(h); await h.send("执行一次");
  calls[0].emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "data/follow-ups.md" } }] } });
  calls[0].emit({ type: "system", subtype: "status", compact_result: "failed", compact_error: "Prompt is too long" });
  calls[0].emit({ type: "result", subtype: "error_during_execution" }); await flush(h);
  assert.equal(calls.length, 2); assert.equal(calls[1].received.length, 0);
});

test("ordinary auth failure keeps the session and yields error avatar with Chinese speech", async (t) => {
  const { h, calls } = setup(t); await flush(h); await h.send("你好");
  calls[0].emit({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "API Error: 401 Unauthorized" }] } });
  calls[0].emit({ type: "result", subtype: "error_during_execution" }); await flush(h);
  assert.equal(h.avatar.value.state, "error"); assert.equal(calls.length, 1); assert.match(h.speech.history().at(-1).text, /授权/);
});

test("first chat is single-flight, validates the device and refuses to repeat after main history exists", async (t) => {
  const { h, calls, events } = setup(t); await flush(h);
  await assert.rejects(h.firstChat("web"), (e) => e.status === 400);
  const results = await Promise.all([h.firstChat("android"), h.firstChat("android")]); await flush(h);
  assert.equal(results[0].id, results[1].id); assert.equal(calls[0].received.length, 1);
  assert.equal(calls[0].received[0].message.content, "[第一次聊天] 设备：android");
  assert.equal(h.history.get(results[0].id).title, "第一次聊天");
  assert.deepEqual(h.speech.history(), []);
  assert.equal(events.some((e) => e.t === "user"), false);
  assert.deepEqual(await h.firstChat("mac"), { started: false });
});

test("stopping an isolated activity leaves main chat usable and a pending background activity can be cancelled before its query starts", async (t) => {
  const { h, calls } = setup(t); await flush(h);
  const first = h.runIsolated("后台活动", "等待停止", { id: "isolated-stop" });
  const pending = h.runIsolated("尚未开始", "不用执行", { id: "pending-stop" });
  await flush(h); assert.equal(calls.length, 2);
  await h.stopTask("pending-stop"); await h.stopTask("isolated-stop"); await first; await pending;
  assert.equal(h.history.get("isolated-stop").status, "stopped"); assert.equal(h.history.get("pending-stop").status, "stopped"); assert.equal(calls.length, 2);
  await h.send("主聊天继续"); await flush(h); assert.equal(calls[0].received.at(-1).message.content, "主聊天继续");
});
