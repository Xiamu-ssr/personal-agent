import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { startServer } from "../src/server.mjs";
import { config } from "../src/config.mjs";
import { writeJson } from "../src/store.mjs";
import { queryFixture } from "./query-fixture.mjs";

const until = async (fn) => { const end = Date.now() + 3000; while (!fn()) { if (Date.now() > end) throw new Error("旁聊测试超时"); await delay(5); } };
const answer = (q, text = "旁聊正文") => { q.emit({ type: "assistant", message: { content: [{ type: "text", text }] } }); q.emit({ type: "result", subtype: "success" }); };

async function fixture(t) {
  for (const file of [config.chatLog, path.join(config.system, "activity-index.json")]) fs.rmSync(file, { force: true });
  fs.rmSync(path.join(config.system, "side-chats"), { recursive: true, force: true });
  writeJson(config.stateFile, {});
  const calls = [], events = [], notifications = [], listeners = new Set(), clients = [];
  const bus = { on: (fn) => listeners.add(fn), emit: (e) => { events.push(e); for (const fn of listeners) fn(e); } };
  const hub = new DeviceHub(); hub.broadcast = (e) => notifications.push(e);
  const h = new Harness({ hub, bus, log() {}, queryFactory: queryFixture(calls) }); h.startMain();
  const server = startServer({ harness: h, hub, bus, log() {}, listen: { host: "127.0.0.1", port: 0 } }); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
  const request = async (route, method = "GET", body, auth = true) => {
    const r = await fetch(base + route, { method, ...(auth && { headers }), ...(body !== undefined && { body: JSON.stringify(body) }) });
    return { status: r.status, data: await r.json() };
  };
  const app = async () => {
    const seen = [], ws = new WebSocket(base.replace("http:", "ws:") + "/ws", { headers }); clients.push(ws);
    ws.on("message", (raw) => seen.push(JSON.parse(raw))); await once(ws, "open"); await until(() => seen.some((e) => e.t === "hello"));
    return { ws, seen };
  };
  t.after(async () => { for (const ws of clients) ws.terminate(); await h.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  return { h, calls, events, notifications, request, app, bus, hub };
}

test("side chat creation validates input and starts an independent activity while main chat is busy", async (t) => {
  const { h, calls, events, request } = await fixture(t);
  assert.equal((await request("/api/side-chats", "POST", { text: "旁聊" }, false)).status, 401);
  for (const body of [{}, { text: 42 }, { text: "x", title: "" }, { text: "x", title: 1 }, { text: "x", title: "x".repeat(201) }, { attachments: [{ path: "data/memory/profile/总档.md", kind: "file" }] }]) {
    assert.equal((await request("/api/side-chats", "POST", body)).status, 400);
  }
  assert.equal(h.history.records.size, 0);
  await h.send("MAIN_CONTEXT_SENTINEL");
  const mainId = h.main.activityId, created = await request("/api/side-chats", "POST", { text: "SIDE_CONTEXT_SENTINEL", title: "单独讨论" });
  assert.equal(created.status, 201); assert.equal(created.data.chatType, "side");
  const id = created.data.id; await until(() => calls[1]?.received.length === 1);
  assert.notEqual(id, mainId); assert.equal(calls[1].options.resume, undefined);
  assert.equal(calls[1].received[0].message.content, "SIDE_CONTEXT_SENTINEL");
  assert.equal(calls[0].received.length, 1); assert.equal(h.busy, true);
  const running = (await request("/api/activities")).data.running;
  assert.equal(running.find((a) => a.id === id).chatType, "side"); assert.equal("chatType" in running.find((a) => a.id === mainId), false);
  answer(calls[1]); await h.jobChain;
  const history = (await request(`/api/activities/${id}/history`)).data;
  assert.equal(history.title, "单独讨论"); assert.equal(history.chatType, "side");
  assert.deepEqual(history.messages.map((m) => m.text), ["SIDE_CONTEXT_SENTINEL", "旁聊正文"]);
  assert.equal(history.items[0].from, "user"); assert.ok(history.items.some((i) => i.kind === "result"));
  assert.deepEqual(h.speech.history().map((m) => m.text), ["MAIN_CONTEXT_SENTINEL"]);
  assert.equal(events.some((e) => e.t === "say" && e.text === "旁聊正文"), false);
  assert.equal((await request("/api/activities")).data.recent.find((a) => a.id === id).chatType, "side");
});

test("side say cards and one-shot options stay in their own HTTP/WS history, including concurrent clicks", async (t) => {
  const { h, calls, events, notifications, request, app } = await fixture(t);
  const a = await app();
  const { id } = (await request("/api/side-chats", "POST", { text: "选个方向" })).data;
  await until(() => calls[1]?.received.length === 1);
  const tool = h.speech.tools(() => ({ activityId: id, chatType: "side" }))[0];
  const result = await tool.handler({ text: "旁聊里的第一句", cards: [{ type: "link", url: "https://example.test/side", title: "资料" }], options: [{ label: "继续", reply: "SIDE_OPTION_REPLY" }, { label: "暂停" }] }, {});
  const messageId = JSON.parse(result.content[0].text).id;
  assert.equal((await request("/api/options/choose", "POST", { messageId, optionId: "0" })).status, 404);
  const clicks = await Promise.all(["0", "1"].map((optionId) => request("/api/options/choose", "POST", { activityId: id, messageId, optionId })));
  assert.deepEqual(clicks.map((r) => r.status).sort(), [200, 409]);
  const accepted = clicks.find((r) => r.status === 200).data;
  assert.equal(accepted.activityId, id); assert.notEqual(accepted.id, id);
  await until(() => calls[1].received.length === 2);
  const choice = h.speech.emit({ text: "旁聊里的第二句", options: [{ label: "再看看" }] }, { activityId: id, chatType: "side" });
  a.ws.send(JSON.stringify({ t: "choose_option", activityId: id, messageId: choice.id, optionId: "0" }));
  await until(() => a.seen.some((e) => e.t === "options_used" && e.messageId === choice.id));
  await until(() => calls[1].received.length === 3);
  assert.equal(calls[1].received.at(-1).message.content, "再看看");
  answer(calls[1], "普通正文也留在旁聊"); await h.jobChain;
  const history = (await request(`/api/activities/${id}/history`)).data;
  const bubble = history.messages.find((m) => m.id === messageId);
  assert.equal(history.messages.find((m) => m.id === accepted.id).role, "user");
  assert.equal(bubble.optionsUsed, true); assert.equal(bubble.cards[0].title, "资料");
  assert.equal(history.messages.at(-1).fallback, true);
  assert.ok(history.messages.filter((m) => m.role === "user").slice(1).every((m) => m.source === "option"));
  assert.ok(events.filter((e) => e.t === "activity_message").every((e) => e.activityId === id && e.chatType === "side"));
  assert.ok(a.seen.some((e) => e.t === "activity_message" && e.id === messageId));
  assert.equal(a.seen.some((e) => ["say", "user", "delta", "turn_end"].includes(e.t)), false);
  assert.equal((await request("/api/history")).data.items.length, 0); assert.equal(notifications.length, 0);
  assert.equal((await request("/api/state")).data.chatEmpty, true); assert.equal(h.busy, false);
  const next = await app(); assert.deepEqual(next.seen.find((e) => e.t === "hello").history, []);
});

test("side chat history, attachments and option consumption persist across a cloud restart", async (t) => {
  const { h, calls, request, bus, hub } = await fixture(t);
  const file = path.join(config.data, "uploads/2026-10-15/notes.txt"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "side attachment");
  const attachment = { path: "data/uploads/2026-10-15/notes.txt", name: "笔记.txt", kind: "file" };
  const { id } = (await request("/api/side-chats", "POST", { attachments: [attachment] })).data;
  await until(() => calls[1]?.received.length === 1);
  const bubble = h.speech.emit({ text: "已看过笔记", options: [{ label: "继续" }] }, { activityId: id, chatType: "side" });
  await h.chooseOption(bubble.id, "0", id); answer(calls[1], "RETAIN_SIDE_CONTEXT"); await h.jobChain; await h.close();
  const resumedCalls = [], resumed = new Harness({ hub, bus, log() {}, queryFactory: queryFixture(resumedCalls) });
  t.after(() => resumed.close());
  const history = resumed.taskHistory(id);
  assert.equal(history.chatType, "side"); assert.equal(history.messages[0].attachments[0].path, attachment.path);
  assert.equal(history.messages.find((m) => m.id === bubble.id).optionsUsed, true);
  await assert.rejects(resumed.chooseOption(bubble.id, "0", id), (e) => e.status === 409);
  await resumed.sendTask(id, "重新接着聊"); await until(() => resumedCalls[0]?.received.length === 1);
  const input = JSON.stringify(resumedCalls[0].received[0]);
  assert.match(input, /RETAIN_SIDE_CONTEXT/); assert.match(input, /notes\.txt/); assert.doesNotMatch(input, /system\/chat\.jsonl/);
  answer(resumedCalls[0], "重启后继续"); await resumed.jobChain;
  assert.equal(resumed.taskHistory(id).messages.at(-1).text, "重启后继续"); assert.deepEqual(resumed.speech.history(), []);
});

test("side input before its isolated query starts is delivered once and retains submission order", async (t) => {
  const { h, calls, request } = await fixture(t);
  const blocker = h.runIsolated("本地占位活动", "BLOCKER"); await until(() => calls[1]?.received.length === 1);
  const { id } = (await request("/api/side-chats", "POST", { text: "FIRST_SIDE_MESSAGE" })).data;
  await Promise.all(["SECOND_SIDE_MESSAGE", "THIRD_SIDE_MESSAGE"].map((text) => h.sendTask(id, text)));
  assert.equal(calls.length, 2);
  answer(calls[1], " "); await blocker;
  await until(() => calls[2]?.received.length === 3);
  assert.deepEqual(calls[2].received.map((m) => m.message.content), ["FIRST_SIDE_MESSAGE", "SECOND_SIDE_MESSAGE", "THIRD_SIDE_MESSAGE"]);
  answer(calls[2]); await h.jobChain;
  assert.equal(h.taskHistory(id).items.filter((i) => i.kind === "prompt").length, 3);
  assert.deepEqual(h.speech.history(), []);
});

test("side input after result waits for its own result and idle without closing the live input", async (t) => {
  const { h, calls } = await fixture(t);
  const id = await h.createSideChat("先开一个旁聊"); await until(() => calls[1]?.received.length === 1);
  const q = calls[1]; q.emit({ type: "system", subtype: "session_state_changed", state: "running" });
  q.emit({ type: "result", subtype: "success" }); await until(() => h.isolated.get(id)?.job.resultSeen);
  await h.sendTask(id, "RESULT_IDLE_BOUNDARY_MESSAGE");
  q.emit({ type: "system", subtype: "session_state_changed", state: "idle" });
  await until(() => h.isolated.get(id)?.job.sdkState === "idle"); assert.equal(q.closed, false);
  assert.equal(q.received.at(-1).message.content, "RESULT_IDLE_BOUNDARY_MESSAGE");
  q.emit({ type: "system", subtype: "session_state_changed", state: "running" }); answer(q, "新交代已处理");
  q.emit({ type: "system", subtype: "session_state_changed", state: "idle" }); await h.jobChain;
  assert.equal(calls.length, 2); assert.equal(h.taskHistory(id).messages.at(-1).text, "新交代已处理");
});

test("side failures remain visible in their own conversation and never turn into main chat bubbles", async (t) => {
  const { h, calls, events } = await fixture(t);
  const id = await h.createSideChat("帮我试一下"); await until(() => calls[1]?.received.length === 1);
  const q = calls[1];
  q.emit({ type: "system", subtype: "session_state_changed", state: "running" });
  q.emit({ type: "result", subtype: "error_during_execution", errors: ["authentication error"] }); await h.jobChain;
  const history = h.taskHistory(id); assert.equal(history.status, "error"); assert.equal(history.messages.at(-1).error, true);
  assert.equal(events.some((e) => e.t === "say"), false); assert.deepEqual(h.speech.history(), []);
});
