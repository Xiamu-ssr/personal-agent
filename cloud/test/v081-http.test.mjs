import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import WebSocket from "ws";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { Content } from "../src/content.mjs";
import { startServer } from "../src/server.mjs";
import { config, VERSION } from "../src/config.mjs";
import { tailJsonl, writeJson } from "../src/store.mjs";
import { queryFixture } from "./query-fixture.mjs";
import { recoveryContext } from "../src/conversation-recovery.mjs";

async function fixture(t) {
  for (const name of ["chat.jsonl", "activity-index.json"]) fs.rmSync(path.join(config.system, name), { force: true });
  fs.rmSync(path.join(config.system, "side-chats"), { recursive: true, force: true });
  fs.rmSync(path.join(config.data, "feed/反馈.jsonl"), { force: true }); writeJson(config.stateFile, {});
  const calls = [], events = [], listeners = new Set();
  const bus = { on: (f) => listeners.add(f), emit: (e) => { events.push(e); for (const f of listeners) f(e); } };
  const hub = new DeviceHub(), h = new Harness({ hub, bus, log() {}, queryFactory: queryFixture(calls, { onInput(q) {
    if (!q.options.perTaskStopAffordance) { q.emit({ type: "assistant", message: { content: [{ type: "text", text: "旁聊结果" }] } }); q.emit({ type: "result", subtype: "success" }); }
  } }) }); h.startMain();
  const content = new Content({ root: config.root, bus });
  const server = startServer({ harness: h, hub, bus, content, log() {}, listen: { host: "127.0.0.1", port: 0 } }); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${config.token}`, "content-type": "application/json" };
  const ws = new WebSocket(base.replace("http:", "ws:") + "/ws", { headers }), received = [];
  ws.on("message", (raw) => received.push(JSON.parse(raw))); await once(ws, "open"); await tick();
  const request = async (route, body) => { const r = await fetch(base + route, { headers, ...(body !== undefined && { method: "POST", body: JSON.stringify(body) }) }); return { status: r.status, body: await r.json() }; };
  t.after(async () => { ws.terminate(); await h.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  return { h, calls, events, content, request, received };
}

test("HTTP clientId deduplicates concurrent chat, side creation, activity continuation and feed discussion", async (t) => {
  const { h, calls, request } = await fixture(t);
  const send = { text: "主聊天只送一次", clientId: "main-once" };
  const pair = await Promise.all([request("/api/send", send), request("/api/send", send)]);
  assert.deepEqual(pair[0], pair[1]); assert.equal(pair[0].status, 200); assert.equal(calls[0].received.length, 1);
  assert.equal(h.speech.history().filter((m) => m.role === "user").length, 1);
  assert.deepEqual(await request("/api/send", { text: "同 id 的不同正文也不重发", clientId: send.clientId }), pair[0]);
  for (const clientId of [null, 1, "", "x".repeat(65)]) assert.equal((await request("/api/send", { text: "不应送出", clientId })).status, 400);
  const created = await Promise.all([request("/api/side-chats", { text: "旁聊只建一次", clientId: "side-once" }), request("/api/side-chats", { text: "旁聊只建一次", clientId: "side-once" })]);
  assert.deepEqual(created[0], created[1]); assert.equal(created[0].status, 201); await h.jobChain;
  const id = created[0].body.id, route = `/api/activities/${id}/send`;
  const continued = await Promise.all([request(route, { text: "旁聊只续一次", clientId: "continuation-once" }), request(route, { text: "旁聊只续一次", clientId: "continuation-once" })]);
  assert.deepEqual(continued[0], continued[1]); await h.jobChain;
  assert.deepEqual(h.taskHistory(id).messages.filter((m) => m.role === "user").map((m) => m.text), ["旁聊只建一次", "旁聊只续一次"]);
  const rel = "data/feed/2026-10-16/0800-新闻.md", file = path.join(config.root, rel); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "---\ntitle: 新闻\nsource: 本地渠道\nicon: 📰\nurl: https://example.test/news\n---\n完整新闻正文\n");
  const feedback = { path: rel, action: "discuss", text: "这对我有什么影响？", clientId: "discuss-once" };
  const discussed = await Promise.all([request("/api/feed/feedback", feedback), request("/api/feed/feedback", feedback)]);
  assert.deepEqual(discussed[0], discussed[1]); assert.equal(discussed[0].status, 200);
  assert.equal(calls[0].received.length, 2); assert.equal(tailJsonl(path.join(config.data, "feed/反馈.jsonl"), 100).length, 1);
  assert.equal(h.speech.history().filter((m) => m.quote).length, 1);
});

test("HTTP and WS expose working main activities with summary and updated titles while pure chat stays process-only", async (t) => {
  const { h, calls, request, received } = await fixture(t);
  h.summarize = async () => ({ title: "查阅资料", summary: "查阅资料并说明了结果" });
  await request("/api/send", { text: "纯聊天" }); const pure = h.main.activityId;
  h.speech.emit({ text: "你好。" }, { activityId: pure }); calls[0].emit({ type: "result", subtype: "success" }); await tick();
  assert.deepEqual((await request("/api/activities")).body.recent, []);
  assert.ok((await request(`/api/activities/${pure}/history`)).body.items.length);
  await request("/api/send", { text: "帮我查资料" }); const work = h.main.activityId;
  calls[0].emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } }); await tick();
  const running = (await request("/api/activities")).body.running.find((r) => r.id === work);
  assert.equal(running.title, "处理中"); assert.equal(running.summary, "");
  h.speech.emit({ text: "查好了。" }, { activityId: work }); calls[0].emit({ type: "result", subtype: "success" }); await tick(); await Promise.all([...h.summaryJobs]);
  const recent = (await request("/api/activities")).body.recent.find((r) => r.id === work);
  assert.equal(recent.title, "查阅资料"); assert.equal(recent.summary, "查阅资料并说明了结果");
  const deadline = Date.now() + 1000;
  while (!received.some((e) => e.t === "activity" && e.phase === "updated") && Date.now() < deadline) await tick();
  assert.ok(received.some((e) => e.t === "activity" && e.phase === "updated" && e.id === work && e.summary === recent.summary));
  assert.equal(received.some((e) => e.t === "activity" && e.id === pure), false);
});

test("feed discussion persists and broadcasts user words plus quote, sends full source to the model and allows an empty comment", async (t) => {
  const { h, calls, request, events, received } = await fixture(t);
  const rel = "data/feed/2026-10-16/0900-引用.md", file = path.join(config.root, rel); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "---\ntitle: 新产品发布\nsource: 测试发布站\nicon: 🚀\nurl: https://example.test/product\n---\n完整帖子中的事实。\n");
  const quote = { kind: "feed", path: rel, title: "新产品发布", emoji: "🚀", source: "测试发布站" };
  for (const text of ["值得试吗？", ""]) {
    const result = await request("/api/feed/feedback", { path: rel, action: "discuss", text, clientId: "quote-" + text }); assert.equal(result.status, 200);
    const row = (await request("/api/history")).body.items.find((m) => m.id === result.body.id);
    assert.equal(row.text, text); assert.deepEqual(row.quote, quote); assert.equal(row.activityId, h.main.activityId);
    const input = calls[0].received.at(-1).message.content;
    for (const part of ["新产品发布", "测试发布站", "https://example.test/product", "完整帖子中的事实", rel, text || "聊聊这条动态。"]) assert.ok(input.includes(part));
    assert.deepEqual(events.find((e) => e.t === "user" && e.id === row.id).quote, quote);
  }
  await tick(); assert.ok(received.some((e) => e.t === "user" && e.quote?.path === rel));
  const recovery = recoveryContext({ root: config.root, chatLog: config.chatLog }); assert.ok(recovery.includes(rel)); assert.match(recovery, /新产品发布/);
  assert.equal(received.find((e) => e.t === "hello").version, VERSION);
  const activities = (await request("/api/activities")).body;
  assert.deepEqual(activities.running, []); assert.deepEqual(activities.recent, []);
  assert.ok((await request(`/api/activities/${h.main.activityId}/history`)).body.items.length);
  assert.equal(events.some((e) => e.t === "activity"), false);
});
