import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { startServer } from "../src/server.mjs";
import { config } from "../src/config.mjs";
import { writeJson, tailJsonl } from "../src/store.mjs";
import { queryFixture } from "./query-fixture.mjs";
import { CloudBrowser } from "../src/browser/browser.mjs";

class Browser extends EventEmitter {
  owner = "agent";
  starts = 0;
  state() { return { t: "browser_state", state: this.owner === "user" ? "user" : "closed", control: this.owner }; }
  setViewers() {}
  async runAgent(fn, { onStart = () => {} } = {}) { this.starts++; if (this.owner === "user") return { blocked: true }; await onStart(); return fn({ ariaSnapshot: async () => "页面" }, new AbortController().signal); }
  async takeover() { this.starts++; this.owner = "user"; this.emit("state", this.state()); return this.state(); }
  async handBack() { this.owner = "agent"; this.emit("state", this.state()); this.emit("returned", { t: "browser_returned" }); return this.state(); }
  async close() {}
}
const flush = async (h) => { await tick(); await h.inputChain; await tick(); };
const finish = (q) => q.emit({ type: "result", subtype: "success" });
function setup(t) {
  fs.rmSync(config.chatLog, { force: true });
  fs.rmSync(path.join(config.system, "activity-index.json"), { force: true });
  writeJson(config.stateFile, {});
  const calls = [], events = [], browser = new Browser(), listeners = new Set();
  const bus = { on: (fn) => listeners.add(fn), emit: (e) => { events.push(e); for (const fn of listeners) fn(e); } }, hub = new DeviceHub();
  const h = new Harness({ browser, hub, bus, log() {}, queryFactory: queryFixture(calls) });
  h.startMain(); t.after(() => h.close());
  return { h, calls, events, browser, hub, bus };
}
async function clientFor(t, server) {
  const client = new Client({ name: "browser-integration", version: "0.8.0" }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(b); await client.connect(a); t.after(() => client.close()); return client;
}

test("all query types receive independent browser transports without starting Chrome; feed guard differs from main and ideas", async (t) => {
  const { h, calls, browser } = setup(t); await flush(h);
  const file = "data/feed/动态说明.md", input = { tool_name: "Write", tool_input: { file_path: file } };
  assert.ok(calls[0].options.allowedTools.includes("mcp__browser__*"));
  assert.deepEqual(await calls[0].options.hooks.PreToolUse[1].hooks[0](input), {});
  const feed = h.runIsolated("动态", "[动态]\n本地测试", { id: "feed-guard-run" }); await flush(h);
  const q = calls[1];
  assert.notEqual(q.options.mcpServers.browser.instance, calls[0].options.mcpServers.browser.instance);
  assert.equal((await q.options.hooks.PreToolUse[1].hooks[0](input)).hookSpecificOutput.permissionDecision, "deny");
  const client = await clientFor(t, q.options.mcpServers.browser);
  assert.match((await client.listTools()).tools[0].description, /已登录/);
  assert.equal(browser.starts, 0);
  assert.match((await client.callTool({ name: "request_takeover", arguments: { reason: "登录" } })).content[0].text, /不请求接管/);
  assert.equal(browser.starts, 0);
  finish(q); await feed;
  const ideas = h.runIsolated("点子", "[点子]"); await flush(h);
  assert.deepEqual(await calls[2].options.hooks.PreToolUse[1].hooks[0](input), {}); finish(calls[2]); await ideas;
  const followup = h.runIsolated("用户续聊", "按我说的更新动态偏好", { id: "feed-guard-run", resumeTask: "feed-guard-run" }); await flush(h);
  assert.deepEqual(await calls[3].options.hooks.PreToolUse[1].hooks[0](input), {}); finish(calls[3]); await followup;
});

test("hand-back reuses the main input stream during a turn or after idle, never fabricates a user chat bubble", async (t) => {
  const { h, calls, browser } = setup(t); await h.send("看一下网页"); await flush(h);
  const client = await clientFor(t, calls[0].options.mcpServers.browser);
  await client.callTool({ name: "snapshot", arguments: {} });
  await client.callTool({ name: "request_takeover", arguments: { reason: "请登录" } });
  assert.equal(h.avatar.value.state, "waiting"); finish(calls[0]); await flush(h);
  assert.equal(h.avatar.value.state, "waiting");
  await browser.handBack(); await flush(h);
  assert.equal(calls.length, 1); assert.match(calls[0].received.at(-1).message.content, /用户已交还浏览器/);
  assert.equal(h.avatar.value.text, "在浏览网页");
  assert.equal(tailJsonl(config.chatLog, 20).filter((row) => row.role === "user").length, 1);
  await client.callTool({ name: "request_takeover", arguments: { reason: "再确认一次" } });
  await browser.handBack(); await flush(h);
  assert.equal(calls[0].received.length, 3);
});

test("isolated hand-back stays in its original query, including return before the first result; other queries cannot steal ownership", async (t) => {
  const { h, calls, browser } = setup(t);
  for (const early of [false, true]) {
    const run = h.runIsolated("后台网页", "读登录后的内容"); await flush(h);
    const q = calls.at(-1), client = await clientFor(t, q.options.mcpServers.browser);
    await client.callTool({ name: "request_takeover", arguments: { reason: "请确认" } });
    const owner = h.browserSession.activityId;
    const mainClient = early ? await clientFor(t, calls[0].options.mcpServers.browser) : null;
    if (mainClient) await mainClient.callTool({ name: "snapshot", arguments: {} });
    assert.equal(h.browserSession.activityId, owner);
    if (early) await browser.handBack();
    finish(q); await flush(h);
    assert.equal(h.isolated.has(owner), true);
    if (!early) await browser.handBack();
    await flush(h);
    assert.match(q.received.at(-1).message.content, /用户已交还浏览器/);
    assert.equal(calls[0].received.length, 0);
    finish(q); await run;
  }
});

test("browser HTTP routes use the existing auth and coexist with App HTTP/WS without starting Chrome", async (t) => {
  const { h, browser, hub, bus } = setup(t);
  const server = startServer({ harness: h, hub, bus, log() {}, listen: { host: "127.0.0.1", port: 0 } }); await once(server, "listening");
  t.after(async () => { await server.browserRoutes.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + "/api/browser/state")).status, 401);
  for (const headers of [{ authorization: `Bearer ${config.token}` }, { cookie: `pa_token=${config.token}` }]) {
    const r = await fetch(base + "/api/browser/state", { headers }); assert.equal(r.status, 200); assert.equal((await r.json()).state, "closed");
    assert.equal((await fetch(base + "/api/state", { headers })).status, 200);
  }
  assert.equal(browser.starts, 0);
});

test("native fork tool-use metadata routes hand-back to that activity instead of its parent chat", async (t) => {
  const { h, calls, browser } = setup(t); await h.send("让后台查看"); await flush(h);
  h.history.put("native-browser-child", { kind: "subagent", title: "后台网页", status: "running" });
  const continued = []; t.mock.method(h, "sendTask", async (id, text) => { continued.push({ id, text }); });
  await calls[0].options.hooks.PreToolUse.at(-1).hooks[0]({ tool_name: "mcp__browser__request_takeover", tool_use_id: "fork-takeover", agent_id: "native-browser-child" });
  const client = await clientFor(t, calls[0].options.mcpServers.browser);
  await client.callTool({ name: "request_takeover", arguments: { reason: "请确认" }, _meta: { "claudecode/toolUseId": "fork-takeover" } });
  await browser.handBack(); await flush(h);
  assert.equal(continued.length, 1); assert.equal(continued[0].id, "native-browser-child"); assert.match(continued[0].text, /用户已交还/);
  assert.equal(calls[0].received.length, 1);
});

test("queued browser tools claim their session only when execution starts, so takeover belongs to the running tool", async (t) => {
  const manager = new EventEmitter(); manager.stop = async () => {};
  const browser = new CloudBrowser({ manager }); browser.ensure = async () => {}; browser.refreshState = async () => {};
  t.after(() => browser.close());
  const owners = []; let release, began;
  const gate = new Promise((resolve) => { release = resolve; }), started = new Promise((resolve) => { began = resolve; });
  const first = browser.runAgent(async () => { began(); await gate; }, { onStart: () => owners.push("main") }); await started;
  const second = browser.runAgent(async () => {}, { onStart: () => owners.push("background") });
  assert.deepEqual(owners, ["main"]);
  const takeover = browser.takeover("用户接管正在运行的工具"); release();
  await first; assert.equal((await second).blocked, true); await takeover;
  assert.deepEqual(owners, ["main"]);
});

test("stopping a background activity waiting for hand-back closes its stream and cancels automatic continuation", async (t) => {
  const { h, calls, browser } = setup(t);
  const run = h.runIsolated("后台网页", "读取网页"); await flush(h);
  const q = calls.at(-1), client = await clientFor(t, q.options.mcpServers.browser);
  await client.callTool({ name: "request_takeover", arguments: { reason: "请确认" } });
  const id = h.browserSession.activityId; finish(q); await flush(h);
  await h.stopTask(id); assert.equal((await run).stopped, true);
  await browser.handBack(); await flush(h);
  assert.equal(h.history.get(id).status, "stopped"); assert.equal(calls.length, 2); assert.equal(calls[0].received.length, 0);
});
