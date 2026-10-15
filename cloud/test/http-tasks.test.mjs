import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { config, CODE } from "../src/config.mjs";
import { Harness } from "../src/agent.mjs";
import { Content } from "../src/content.mjs";
import { writeJson, tailJsonl } from "../src/store.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { startServer } from "../src/server.mjs";
import { queryFixture } from "./query-fixture.mjs";
const put = (rel, text) => { const f = path.join(config.root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const until = async (fn) => { const end = Date.now() + 3000; while (!fn()) { if (Date.now() > end) throw new Error("local HTTP event timed out"); await delay(5); } };

async function fixture(t) {
  const calls = [], events = [], notifications = [], listeners = new Set(), clients = [];
  fs.rmSync(config.chatLog, { force: true });
  const bus = { on: (fn) => listeners.add(fn), emit: (e) => { events.push(e); for (const fn of listeners) fn(e); } };
  const hub = new DeviceHub(); hub.broadcast = (e) => notifications.push(e);
  const h = new Harness({ hub, bus, log() {}, queryFactory: queryFixture(calls, { onInput(q) {
    if (!q.options.perTaskStopAffordance) { q.emit({ type: "assistant", message: { content: [{ type: "text", text: "后台完成" }] } }); q.emit({ type: "result", subtype: "success" }); }
  } }) }); h.startMain();
  const content = new Content({ root: config.root, bus });
  writeJson(config.scheduleFile, JSON.parse(fs.readFileSync(path.join(CODE, "seed/system/schedule.json"))));
  const server = startServer({ harness: h, hub, bus, content, health: { sync: async () => ({ days: [] }) }, log() {}, listen: { host: "127.0.0.1", port: 0 } }); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
  t.after(async () => { for (const ws of clients) ws.terminate(); await h.jobChain; await h.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const request = async (route, method = "GET", body, auth = true) => {
    const r = await fetch(base + route, { method, ...(auth && { headers }), ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }) }); return { status: r.status, data: await r.json() };
  };
  const app = async () => {
    const events = [], ws = new WebSocket(base.replace("http:", "ws:") + "/ws", { headers }); clients.push(ws); ws.on("message", (raw) => events.push(JSON.parse(raw)));
    await once(ws, "open"); await until(() => events.some((e) => e.t === "hello")); return { ws, events, hello: events.find((e) => e.t === "hello") };
  };
  return { h, content, calls, events, notifications, base, headers, request, app };
}

test("v08 HTTP/WS: first chat, multiple bubbles, one-shot options, immediate input, activity history/continuation and notifications", async (t) => {
  const { h, calls, events, notifications, request, app } = await fixture(t);
  assert.equal((await request("/api/activities", "GET", undefined, false)).status, 401);
  assert.equal((await request("/api/state")).data.version, "0.8.0");
  const a = await app(); assert.equal("queued" in a.hello, false); assert.equal("tasks" in a.hello, false);
  assert.equal((await request("/api/first-chat", "POST", { device: "web" })).status, 400);
  assert.equal((await request("/api/first-chat", "POST", { device: "mac" })).data.started, true);
  await until(() => calls[0].received.length === 1); assert.equal(calls[0].received[0].message.content, "[第一次聊天] 设备：mac");
  assert.equal((await request("/api/first-chat", "POST", { device: "android" })).data.started, false);
  const b = await app(); assert.equal(b.hello.avatar.state, "working"); assert.deepEqual(b.hello.history, []);
  assert.deepEqual((await request("/api/history")).data.items, []);
  assert.equal(events.some((e) => e.t === "user" && e.source === "onboarding"), false);
  assert.equal(a.events.some((e) => e.t === "user" && e.source === "onboarding"), false);
  assert.equal((await request("/api/state")).data.chatEmpty, false);
  const id = h.main.activityId;
  assert.equal((await request("/api/activities")).data.running.find((r) => r.id === id).title, "第一次聊天");
  h.speech.emit({ text: "先说第一句" }, { activityId: id });
  assert.deepEqual((await request("/api/history?n=1")).data.items.map((m) => m.text), ["先说第一句"]);
  const choice = h.speech.emit({ text: "再选一个", options: [{ label: "继续" }, { label: "暂停", reply: "先暂停这件事" }] }, { activityId: id });
  assert.equal((await request("/api/send", "POST", { text: "忙时补充" })).status, 200);
  assert.equal((await request("/api/options/choose", "POST", { messageId: choice.id, optionId: "1" })).status, 200);
  assert.equal((await request("/api/options/choose", "POST", { messageId: choice.id, optionId: "0" })).status, 409);
  await until(() => calls[0].received.length === 3); assert.deepEqual(calls[0].received.slice(1).map((m) => m.message.content), ["忙时补充", "先暂停这件事"]);
  assert.equal((await request("/api/history")).data.items.find((m) => m.id === choice.id).optionsUsed, true);
  h.main.q.emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "data/follow-ups.md" } }] } }); h.main.q.emit({ type: "result", subtype: "success" }); await until(() => !h.busy);
  assert.ok((await request("/api/activities")).data.recent.some((r) => r.id === id));
  const history = (await request(`/api/activities/${id}/history`)).data; assert.ok(history.items.some((i) => i.kind === "tool")); assert.ok(history.items.some((i) => i.text === "忙时补充"));
  assert.equal((await request(`/api/activities/${id}/send`, "POST", { text: "接着聊" })).status, 200); await h.jobChain;
  assert.ok((await request(`/api/activities/${id}/history`)).data.items.some((i) => i.text === "接着聊"));
  for (const [route, code] of [["/api/activities/no-such/history", 404], ["/api/activities/%E0/history", 400], ["/api/activities?limit=0", 400], ["/api/activities?before=bad", 400]]) assert.equal((await request(route)).status, code);
  const option = h.speech.emit({ text: "再问一句", options: [{ label: "好" }] }); a.ws.send(JSON.stringify({ t: "choose_option", messageId: option.id, optionId: "0" }));
  await until(() => a.events.some((e) => e.t === "options_used" && e.messageId === option.id));
  assert.equal(a.events.some((e) => e.t === "tool" || e.t === "queue_update"), false); assert.ok(a.events.some((e) => e.t === "activity_step"));
  assert.equal(notifications.filter((e) => e.kind === "reply").length, events.filter((e) => e.t === "say").length);
  for (const route of ["/api/jobs", "/api/tasks/old/history", "/api/briefs", "/api/briefs/item", "/api/profile", "/api/run"]) assert.equal((await request(route)).status, 404);
});

test("v08 content HTTP: feed/feedback/settings, ideas/click, goals/cadence, library/thumbnail and soul/memory", async (t) => {
  const { h, calls, content, request, base, headers } = await fixture(t);
  const post = "data/feed/2026-10-15/0800-测试.md"; put(post, "---\ntitle: 新消息\nsource: 本地测试\nurl: https://example.test/news\npublished: 2026-10-15 08:00\nicon: 📰\n---\n这是动态正文。\n");
  content.discoverFeed(); assert.equal((await request("/api/feed?days=1")).data.items[0].title, "新消息");
  for (const action of ["like", "dislike", "discuss"]) assert.equal((await request("/api/feed/feedback", "POST", { path: post, action })).status, 200);
  assert.equal(tailJsonl(path.join(config.data, "feed/反馈.jsonl"), 10).length, 3); assert.match(calls[0].received.at(-1).message.content, /这是动态正文/);
  assert.equal((await request("/api/feed/settings", "PUT", { interval: 15, instructions: "多看科技", start: "08:00", end: "22:00" })).data.interval, 15);
  assert.equal((await request("/api/feed/settings")).data.instructions, "多看科技"); assert.equal((await request("/api/feed/settings", "PUT", { interval: 45 })).status, 400);
  assert.equal((await request("/api/feed/refresh", "POST")).status, 202); await h.jobChain;
  put("data/ideas/点子.md", "## 调研\n- 🔎 **研究一下**：我帮你查。\n  > 帮我研究一下这个方向\n");
  const ideas = (await request("/api/ideas")).data; assert.equal(ideas.groups[0].items[0].title, "研究一下");
  assert.equal((await request("/api/ideas/click", "POST", { id: ideas.groups[0].items[0].id, revision: ideas.revision })).status, 200);
  assert.equal(calls[0].received.at(-1).message.content, "帮我研究一下这个方向"); assert.equal(tailJsonl(path.join(config.data, "ideas/点击.jsonl"), 10).length, 1);
  assert.equal((await request("/api/ideas/refresh", "POST")).status, 202); await h.jobChain;
  put("data/goals/运动.md", '---\ntitle: 每周运动\ndomain: 健康\ncadence: "0 8 * * 1"\nstatus: 追踪中\nprogress: 25\n---\n## 计划\n运动。\n## 步骤\n- [ ] 出门\n## 记录\n');
  assert.equal((await request("/api/goals")).data.items[0].progress, 25); assert.match((await request("/api/goals/item?name=" + encodeURIComponent("运动"))).data.body, /## 步骤/);
  assert.ok((await request("/api/schedules")).data.items.some((j) => j.id === "goal:运动" && j.nextRun));
  const goalRoute = "/api/schedules/" + encodeURIComponent("goal:运动"); assert.equal((await request(goalRoute, "PUT", { enabled: false })).data.enabled, false); assert.equal((await request("/api/goals")).data.items[0].nextCheckin, null);
  assert.equal((await request(goalRoute + "/run", "POST")).status, 202); await h.jobChain; assert.equal((await request("/api/schedules/no-such/run", "POST")).status, 404);
  put("data/library/artifacts/页面/index.html", "<title>页面</title>"); put("data/library/media/2026-10-15/a.png", "image");
  const library = (await request("/api/library")).data; assert.equal(library.artifacts[0].kind, "page"); assert.equal(library.media[0].kind, "image");
  h.pages.screenshot = async () => ({ data: Buffer.from("fake-jpeg") }); const thumb = await fetch(base + library.artifacts[0].thumbnail, { headers }); assert.equal(thumb.headers.get("content-type"), "image/jpeg"); assert.equal(await thumb.text(), "fake-jpeg");
  put("data/soul/角色.md", "- 名字：小豆\n- 性格：可靠\n"); put("data/health/days.json", "{\"days\":[]}"); assert.equal((await request("/api/memory")).data.soul.name, "小豆");
  const memoryPath = "/api/memory/item?path=" + encodeURIComponent("data/soul/角色.md"); assert.equal((await request(memoryPath, "PUT", { text: "- 名字：豆豆\n" })).status, 200); assert.match((await request(memoryPath)).data.text, /豆豆/);
  assert.equal((await request("/api/memory/item?path=" + encodeURIComponent("data/health/days.json"), "PUT", { text: "changed" })).status, 405); assert.equal((await request("/api/memory/item?path=system/private.txt")).status, 400);
  h.stopTask = async (id) => { if (id === "missing") throw Object.assign(new Error("没有这个活动"), { status: 404 }); };
  assert.equal((await request("/api/activities/local/stop", "POST")).status, 200); assert.equal((await request("/api/activities/missing/stop", "POST")).status, 404);
});
