import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fakeAnthropic } from "./fake-anthropic.mjs";
import { fakeConnectorApi } from "./fake-connector-api.mjs";
import { nativeHarness, resultFor, hasInput, isFork, toolReply, textReply } from "./native-fixture.mjs";
import { config } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";
import { DeviceHub, deviceContent, DEVICE_IMAGE_LIMIT } from "../src/devices.mjs";
import { ConnectorManager } from "../src/connectors.mjs";
import { createTavilyConnector } from "../connectors/tavily/index.mjs";
import { createWereadConnector } from "../connectors/weread/index.mjs";
import { tailJsonl, dateIn } from "../src/store.mjs";
import { runScheduledTask } from "../src/scheduler.mjs";
import { validateBrief } from "../src/briefs.mjs";

const brief = (title) => `<section class="card"><h1 class="title">${title}</h1></section>`;
const writeBrief = (rel, value) => { const p = path.join(config.root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof value === "string" ? value : "invalid"); };
async function httpFixture(t, runtime) {
  const server = startServer({ ...runtime, log() {}, listen: { port: 0, host: "127.0.0.1" } });
  await once(server, "listening");
  const clients = [];
  t.after(async () => { for (const ws of clients) ws.terminate(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
  async function request(route, method = "GET", value, auth = true) {
    const response = await fetch(url + route, { method, ...(auth && { headers }), ...(value !== undefined && { body: typeof value === "string" ? value : JSON.stringify(value) }) });
    return { status: response.status, data: await response.json() };
  }
  async function app() {
    const events = [], ws = new WebSocket(url.replace("http:", "ws:") + "/ws", { headers });
    clients.push(ws); ws.on("message", (raw) => events.push(JSON.parse(raw)));
    await once(ws, "open"); await runtime.until(() => events.some((e) => e.t === "hello"));
    return { events, ws, hello: events.find((e) => e.t === "hello") };
  }
  return { url, request, app, headers };
}

test("real CLI main/fork/isolated Write+Edit get Chinese brief errors, repair HTML and complete with valid path cards", { timeout: 45_000 }, async (t) => {
  const states = new Map();
  const paths = Object.fromEntries(["MAIN", "FORK", "ISOLATED"].map((mode) => [mode, `data/briefs/2026-10-11/native-${mode}.html`]));
  const api = await fakeAnthropic((body) => {
    if (!isFork(body) && hasInput(body, "FORK_WRITE") && !hasInput(body, "task-notification")) {
      if (!resultFor(body, "v04_fork")) return toolReply("v04_fork", "Agent", { subagent_type: "fork", run_in_background: true, description: "测试简报", prompt: "FORK_WRITE: write and fix the brief." });
      return textReply("已派到后台");
    }
    if (hasInput(body, "task-notification")) return textReply("后台 HTML 完成");
    const mode = isFork(body) ? "FORK" : hasInput(body, "ISOLATED_WRITE") ? "ISOLATED" : "MAIN";
    const step = (states.get(mode) || 0) + 1; states.set(mode, step);
    if (step === 1) return toolReply(`bad_${mode}`, "Write", { file_path: path.join(config.root, paths[mode]), content: brief("文".repeat(1200)) });
    if (step === 2) {
      assert.match(JSON.stringify(body.messages), /简报校验失败.*内容过高/);
      return toolReply(`fix_${mode}`, "Edit", { file_path: path.join(config.root, paths[mode]), old_string: "文".repeat(1200), new_string: "修正后的结论" });
    }
    return textReply(mode + " HTML 完成");
  });
  const runtime = nativeHarness(t, api), { harness, events, until } = runtime;
  await harness.send("MAIN_WRITE");
  await until(() => events.some((e) => e.t === "turn_end" && e.text === "MAIN HTML 完成") && !harness.busy);
  await runScheduledTask(harness, { id: "native-json-brief", name: "测试简报", prompt: "FORK_WRITE" });
  await until(() => events.some((e) => e.t === "turn_end" && e.text === "后台 HTML 完成") && !harness.busy && !harness.backgroundTasks().length);
  const job = await harness.runIsolated("隔离 HTML 简报", "ISOLATED_WRITE");
  assert.equal(job.ok, true);
  for (const mode of Object.keys(paths)) {
    assert.equal(states.get(mode), 3);
    assert.equal(validateBrief(fs.readFileSync(path.join(config.root, paths[mode]), "utf8")).error, undefined);
  }
  for (const mode of ["FORK", "ISOLATED"]) {
    const card = events.find((e) => e.t === "job" && e.phase === "done" && e.path === paths[mode]);
    assert.equal(card.ok, true); assert.deepEqual(card.outputs, [paths[mode]]);
  }
});

test("real SDK queue can edit/remove via WS across Apps, reconnect restores pending attachments, dispatch alone writes final text and too_late is requester-only", { timeout: 45_000 }, async (t) => {
  let release, active = false;
  const gate = new Promise((r) => { release = r; });
  const api = await fakeAnthropic(async (body) => {
    if (hasInput(body, "QUEUE_BLOCKER") && !resultFor(body, "unused") && !hasInput(body, "最终文本")) { active = true; await gate; return textReply("第一轮完成"); }
    assert.equal(hasInput(body, "撤回这条"), false); assert.equal(hasInput(body, "修改前的文本"), false);
    return textReply("修改后的消息已处理");
  });
  const runtime = nativeHarness(t, api, { release }), { harness, until } = runtime;
  const http = await httpFixture(t, runtime);
  const first = await http.request("/api/send", "POST", { text: "QUEUE_BLOCKER" });
  assert.equal(typeof first.data.id, "string");
  await until(() => active && harness.busy);
  const upload = path.join(config.data, "uploads/2026-10-11/fixture.txt");
  fs.mkdirSync(path.dirname(upload), { recursive: true }); fs.writeFileSync(upload, "local attachment");
  const id = await harness.send("修改前的文本", "app", [{ path: "data/uploads/2026-10-11/fixture.txt", name: "fixture.txt", kind: "file" }]);
  const removed = await harness.send("撤回这条");
  const a = await http.app(), b = await http.app();
  assert.deepEqual(a.hello.queued.map((q) => q.id), [id, removed]);
  assert.equal(a.hello.queued[0].attachments[0].name, "fixture.txt");
  assert.equal(a.hello.history.some((e) => [id, removed].includes(e.id)), false);
  assert.equal(tailJsonl(config.chatLog, 100).some((e) => [id, removed].includes(e.id)), false);
  a.ws.send(JSON.stringify({ t: "edit_queued", id, text: "  最终文本  " }));
  await until(() => a.events.some((e) => e.t === "queue_update" && e.id === id) && b.events.some((e) => e.t === "queue_update" && e.id === id));
  assert.deepEqual(a.events.find((e) => e.t === "queue_update" && e.id === id), { t: "queue_update", id, state: "edited", text: "最终文本" });
  b.ws.send(JSON.stringify({ t: "unqueue", id: removed }));
  await until(() => a.events.some((e) => e.t === "queue_update" && e.id === removed && e.state === "removed"));
  a.ws.send(JSON.stringify({ t: "unqueue", id: first.data.id }));
  await until(() => a.events.some((e) => e.t === "queue_update" && e.id === first.data.id && e.state === "too_late"));
  assert.equal(b.events.some((e) => e.t === "queue_update" && e.id === first.data.id), false);
  a.ws.send(JSON.stringify({ t: "edit_queued", id, text: 42 }));
  await until(() => a.events.some((e) => e.t === "error"));
  const reconnect = await http.app();
  assert.deepEqual(reconnect.hello.queued.map((q) => ({ id: q.id, text: q.text })), [{ id, text: "最终文本" }]);
  release();
  await until(() => runtime.events.some((e) => e.t === "turn_end" && e.text === "修改后的消息已处理") && !harness.busy);
  const history = tailJsonl(config.chatLog, 100);
  const stored = history.filter((e) => e.id === id);
  assert.equal(stored.length, 1); assert.equal(stored[0].text, "最终文本"); assert.equal(stored[0].attachments.length, 1);
  assert.equal(history.some((e) => e.id === removed), false);
  assert.deepEqual(harness.queuedMessages(), []);
  assert.ok(runtime.events.filter((e) => e.t === "user").every((e) => typeof e.id === "string" && e.ts));
  assert.deepEqual(harness.updateQueued(id, "too late"), { t: "queue_update", id, state: "too_late" });
});

test("authenticated HTTP profile round-trips all 16 avatars privately, state exposes names and briefs are independent HTML documents with bounded days", async (t) => {
  const api = await fakeAnthropic();
  const runtime = nativeHarness(t, api), http = await httpFixture(t, runtime);
  assert.equal((await http.request("/api/profile", "GET", undefined, false)).status, 401);
  assert.deepEqual((await http.request("/api/profile")).data, { avatar: { shape: "bean", palette: "mist" } });
  for (const shape of ["bean", "girl", "boy", "cat"]) for (const palette of ["mist", "dusk", "mint", "sakura"]) {
    const profile = { avatar: { shape, palette } };
    assert.deepEqual((await http.request("/api/profile", "PUT", profile)).data, profile);
    assert.deepEqual((await http.request("/api/profile")).data, profile);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(config.system, "app-profile.json"))), profile);
  }
  const saved = fs.readFileSync(path.join(config.system, "app-profile.json"));
  for (const value of [{ avatar: { shape: "dog", palette: "mist" } }, { avatar: { shape: "cat", palette: "blue" } }, { avatar: { shape: "bean" } }, { avatar: { shape: "cat", palette: "mist" }, model: "x" }, "bad json"]) {
    assert.equal((await http.request("/api/profile", "PUT", value)).status, 400);
    assert.deepEqual(fs.readFileSync(path.join(config.system, "app-profile.json")), saved);
  }
  assert.equal(fs.statSync(path.join(config.system, "app-profile.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(config.system, "app-profile.json")).uid, process.getuid());
  const state = (await http.request("/api/state")).data;
  assert.equal(state.userCall, config.userCall); assert.equal(state.agentName, config.agentName); assert.equal("model" in state, false);
  const today = dateIn(config.timezone), rel = `data/briefs/${today}/api-fixture.html`;
  writeBrief(rel, brief("HTTP 卡片"));
  writeBrief(`data/briefs/${today}/invalid.html`, { invalid: true });
  const oneDay = await http.request("/api/briefs?days=1");
  assert.equal(oneDay.status, 200);
  assert.ok(oneDay.data.items.some((i) => i.path === rel && i.cards[0].html.includes("HTTP 卡片")));
  assert.equal(oneDay.data.items.some((i) => i.path.endsWith("invalid.html")), false);
  assert.ok(oneDay.data.items.every((i) => i.date === today));
  for (const value of ["0", "-1", "1.5", "NaN", "366"]) assert.equal((await http.request("/api/briefs?days=" + value)).status, 400);
  const catalog = (await http.request("/api/connectors")).data.cloud;
  assert.equal("builtin" in catalog, false); assert.equal("custom" in catalog, false);
  for (const item of [...catalog.catalog, ...catalog.installed]) {
    const response = await fetch(http.url + item.icon, { headers: http.headers });
    assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /max-age=2592000/);
    assert.ok((await response.arrayBuffer()).byteLength > 100);
  }
  assert.equal((await http.request("/api/connectors/unknown/icon")).status, 404);
});

test("device image MCP content supports one/multiple/mixed images, keeps metadata and rejects >5MB or malformed data in Chinese", async (t) => {
  const small = Buffer.from("fake-image").toString("base64");
  assert.deepEqual(deviceContent({ image: small, mime: "image/png" }), { content: [{ type: "image", data: small, mimeType: "image/png" }] });
  assert.deepEqual(deviceContent([{ image: small, mime: "image/jpeg", width: 100 }, "备注", { image: small, mime: "image/webp" }]).content.map((c) => c.type), ["image", "text", "text", "image"]);
  assert.equal(deviceContent({ image: Buffer.alloc(DEVICE_IMAGE_LIMIT).toString("base64"), mime: "image/png" }).content[0].type, "image");
  assert.throws(() => deviceContent({ image: Buffer.alloc(DEVICE_IMAGE_LIMIT + 1).toString("base64"), mime: "image/png" }), /超过 5MB/);
  assert.throws(() => deviceContent([{ image: small, mime: "image/png" }, { image: "invalid#", mime: "image/png" }]), /base64 格式/);
  assert.throws(() => deviceContent({ image: small, mime: "image/svg+xml" }), /只支持/);
  const hub = new DeviceHub();
  hub.call = async () => ({ image: Buffer.alloc(DEVICE_IMAGE_LIMIT + 1).toString("base64"), mime: "image/png" });
  const client = new Client({ name: "device-test", version: "0.4" }), server = hub.mcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport); await client.connect(clientTransport); t.after(() => client.close());
  const failed = await client.callTool({ name: "call_device", arguments: { device: "fake", capability: "computer_use" } });
  assert.equal(failed.isError, true); assert.match(failed.content[0].text, /超过 5MB/); assert.equal(failed.content.length, 1);
});

test("real SDK sends device screenshot as an Anthropic image block and Tavily/WeRead MCP requests never expose credentials to the model", { timeout: 45_000 }, async (t) => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKZ8AAAAASUVORK5CYII=";
  const api = await fakeAnthropic((body) => {
    if (!resultFor(body, "device_image")) return toolReply("device_image", "mcp__devices__call_device", { device: "fake-mac", capability: "computer_use", args: { action: "screenshot" } });
    assert.ok(resultFor(body, "device_image").content.some((b) => b.type === "image" && b.source?.data === png && b.source.media_type === "image/png"));
    if (!resultFor(body, "tavily_search")) return toolReply("tavily_search", "mcp__tavily__search", { query: "深入调研", depth: "advanced" });
    if (!resultFor(body, "weread_shelf")) return toolReply("weread_shelf", "mcp__weread__shelf", {});
    return textReply("图片与连接器完成");
  });
  const tavilyKey = "tvly-FAKE-NATIVE-KEY", wereadKey = "wrk-FAKE-NATIVE-KEY";
  const remote = await fakeConnectorApi((req) => ({ data: { echo: req.authorization.slice(7), results: [], books: [] } }));
  t.after(() => remote.close());
  const connectors = new ConnectorManager({ definitions: [createTavilyConnector({ baseUrl: remote.url }), createWereadConnector({ gateway: remote.url + "/api/agent/gateway" })] });
  await connectors.addAccount("tavily", { apiKey: tavilyKey }); await connectors.addAccount("weread", { apiKey: wereadKey });
  const hub = new DeviceHub(), ws = new EventEmitter();
  ws.readyState = 1; ws.send = (raw) => { const call = JSON.parse(raw); queueMicrotask(() => hub.handleResult({ t: "result", id: call.id, ok: true, data: { image: png, mime: "image/png", width: 1, height: 1 } })); };
  hub.register(ws, { id: "fake-mac", name: "测试 Mac", kind: "mac", capabilities: [{ name: "computer_use", enabled: true }] });
  const { harness, events, until } = nativeHarness(t, api, { connectors, hub });
  await harness.send("IMAGE_CONNECTOR_NATIVE");
  await until(() => events.some((e) => e.t === "turn_end" && e.text === "图片与连接器完成") && !harness.busy);
  for (const key of [tavilyKey, wereadKey]) assert.equal(JSON.stringify(api.requests).includes(key), false);
  assert.ok(remote.requests.some((r) => r.path === "/search")); assert.ok(remote.requests.some((r) => r.body?.api_name === "/shelf/sync"));
});
