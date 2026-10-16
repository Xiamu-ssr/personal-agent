import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const index = process.argv.indexOf("--output");
const output = path.resolve(index < 0 ? "/tmp/v08-cloud-demo/browser" : process.argv[index + 1]);
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, "root-"));
Object.assign(process.env, { AGENT_ROOT: root, AGENT_TOKEN: "fake-local-browser-demo-token", AGENT_HOST: "127.0.0.1", AGENT_PORT: "0", AGENT_BROWSER_SERVICE: "" });
const [{ query }, { default: WebSocket }, { Harness }, { DeviceHub }, { Content }, { startServer }, { migrateV08 }, { CODE }, { fakeAnthropic }, fixtures] = await Promise.all([
  import("@anthropic-ai/claude-agent-sdk"), import("ws"), import("../src/agent.mjs"), import("../src/devices.mjs"), import("../src/content.mjs"), import("../src/server.mjs"), import("../src/migrate-v08.mjs"), import("../src/config.mjs"), import("../test/fake-anthropic.mjs"), import("../test/native-fixture.mjs"),
]);
const { toolReply, textReply, resultFor } = fixtures;
const lines = [], events = [], requests = [], frames = [], listeners = new Set();
for (const name of ["demo.log", "events.jsonl", "browser-events.jsonl"]) fs.writeFileSync(path.join(output, name), "");
const log = (value) => { lines.push(value); fs.appendFileSync(path.join(output, "demo.log"), value + "\n"); };
const bus = { on: (fn) => listeners.add(fn), emit: (event) => { events.push(event); fs.appendFileSync(path.join(output, "events.jsonl"), JSON.stringify(event) + "\n"); for (const fn of listeners) fn(event); } };
let modelError;
const site = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end('<!doctype html><meta charset="utf-8"><title>本地浏览器接线验证</title><h1 id="status">等待用户确认</h1><button style="position:absolute;left:40px;top:90px;width:200px;height:60px" onclick="document.querySelector(\'#status\').textContent=\'USER_CONFIRMED\'">确认本地测试</button>');
});
site.listen(0, "127.0.0.1"); await once(site, "listening");
const localPage = `http://127.0.0.1:${site.address().port}/`;
const api = await fakeAnthropic((body) => {
  try {
    const serialized = JSON.stringify(body.messages), feed = serialized.includes("BROWSER_FEED_DEMO");
    const channel = serialized.includes("BROWSER_BACKGROUND_DEMO") ? "background" : "main";
    const returned = serialized.includes("[浏览器交还]");
    requests.push({ request: requests.length + 1, channel: feed ? "feed" : channel, returned, model: body.model });
    if (feed) return textReply(" ");
    if (!resultFor(body, channel + "_open")) return toolReply(channel + "_open", "mcp__browser__open", { url: localPage + channel });
    if (!resultFor(body, channel + "_takeover")) return toolReply(channel + "_takeover", "mcp__browser__request_takeover", { reason: "请在本地测试页点一下确认" });
    if (!resultFor(body, channel + "_wait_say")) return toolReply(channel + "_wait_say", "mcp__doudou__say", { text: "请在浏览器里确认，交还后我继续。", cards: [{ type: "browser" }] });
    if (!returned) return textReply(" ");
    if (!resultFor(body, channel + "_snapshot")) return toolReply(channel + "_snapshot", "mcp__browser__snapshot", {});
    assert.match(JSON.stringify(resultFor(body, channel + "_snapshot")), /USER_CONFIRMED/);
    if (!resultFor(body, channel + "_result_say")) return toolReply(channel + "_result_say", "mcp__doudou__say", { text: `${channel}：看到了你确认后的页面，已经继续完成。`, cards: [{ type: "browser" }] });
    return textReply(" ");
  } catch (error) { modelError = error; return { error: "local browser demo assertion failed" }; }
});
let harness, server, app, viewer;
let launches = 0, returnedEvents = 0;
try {
  migrateV08({ root, seedDir: path.join(CODE, "seed") });
  const hub = new DeviceHub();
  harness = new Harness({ hub, bus, log() {}, queryFactory: ({ prompt, options }) => query({ prompt, options: {
    ...options, settingSources: [], agentProgressSummaries: false, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
    env: { ...options.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-local-browser-model", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CONFIG_DIR: path.join(root, "system/sessions"), CLAUDE_CODE_TMPDIR: path.join(root, "sdk-tmp"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
  } }) });
  const browser = harness.browser, start = browser.manager.start.bind(browser.manager);
  browser.manager.start = async () => { launches++; return start(); };
  browser.on("returned", () => { returnedEvents++; });
  const content = new Content({ root, bus }); harness.startMain();
  server = startServer({ harness, hub, bus, content, log() {}, listen: { host: "127.0.0.1", port: 0 } }); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${process.env.AGENT_TOKEN}`, "Content-Type": "application/json" };
  const request = async (route, method = "GET", value) => {
    const response = await fetch(base + route, { method, headers, signal: AbortSignal.timeout(20_000), ...(value !== undefined && { body: JSON.stringify(value) }) });
    return { status: response.status, body: await response.json() };
  };
  const until = async (fn) => { const end = Date.now() + 25_000; while (!fn()) { if (modelError) throw modelError; if (Date.now() > end) throw new Error("local browser demo timed out"); await delay(15); } };
  assert.equal((await fetch(base + "/api/browser/state")).status, 401);
  const appEvents = [];
  app = new WebSocket(base.replace("http:", "ws:") + "/ws?role=app", { headers });
  app.on("message", (raw) => appEvents.push(JSON.parse(raw))); await once(app, "open");
  viewer = new WebSocket(base.replace("http:", "ws:") + "/ws/browser", { headers });
  viewer.on("message", (raw) => {
    const event = JSON.parse(raw);
    if (event.t === "browser_frame") frames.push(event);
    const { data, ...metadata } = event;
    fs.appendFileSync(path.join(output, "browser-events.jsonl"), JSON.stringify({ ...metadata, ...(data && { jpegBytes: Buffer.from(data, "base64").length }) }) + "\n");
  }); await once(viewer, "open");
  assert.equal(launches, 0); log("MCP + App HTTP/WS connected; Chrome launches=0 (lazy)");
  const useAndReturn = async (channel) => {
    await until(() => browser.owner === "user" && events.some((e) => ["say", "activity_message"].includes(e.t) && e.cards?.some((c) => c.type === "browser")));
    if (channel === "main") await until(() => !harness.busy);
    else await until(() => [...harness.isolated.values()].some((i) => i.job.waitingBrowser));
    assert.equal(harness.avatar.value.state, "waiting");
    await until(() => frames.length && browser.frames.has(frames.at(-1).frameId));
    const frame = frames.at(-1); assert.equal(frame.width, 1280); assert.equal(frame.height, 800);
    fs.writeFileSync(path.join(output, channel + "-takeover.jpg"), Buffer.from(frame.data, "base64"));
    log(`${channel}: real Chrome opened local page -> request_takeover -> avatar=waiting; authenticated live frame=1280x800`);
    assert.equal((await request("/api/browser/input", "POST", { type: "click", frameId: frame.frameId, width: 1280, height: 800, x: 100, y: 120 })).status, 200);
    assert.equal((await request("/api/browser/return", "POST", {})).status, 200);
    await until(() => events.some((e) => ["say", "activity_message"].includes(e.t) && e.text.startsWith(channel + "：")));
    log(`${channel}: App click -> return=200 -> original query received [浏览器交还] -> snapshot sees USER_CONFIRMED -> say result`);
  };
  assert.equal((await request("/api/send", "POST", { text: "BROWSER_MAIN_DEMO：请打开测试页，让我确认，交还后继续。" })).status, 200);
  const mainQuery = harness.main.q;
  await useAndReturn("main"); await until(() => !harness.busy);
  assert.equal(harness.main.q, mainQuery);
  const chatUsers = harness.speech.history(100).filter((item) => item.role === "user").length;
  assert.equal(chatUsers, 1);
  const sideId = await harness.createSideChat("BROWSER_BACKGROUND_DEMO：请读测试页，等我确认后继续。", [], "旁聊浏览器验证");
  const background = harness.sideRuns.get(sideId);
  await useAndReturn("background"); assert.equal((await background).ok, true);
  assert.equal(harness.busy, false); log("side-chat return stayed in isolated SDK stream; main busy=false; no fabricated user chat bubbles");
  assert.equal(returnedEvents, 2); assert.equal(launches, 1);
  await request("/api/browser/close", "POST", {});
  assert.equal((await harness.runIsolated("动态轻量验证", "[动态]\nBROWSER_FEED_DEMO")).ok, true);
  assert.equal(launches, 1); log("feed with browser tools and no browser calls: no Chrome restart");
  assert.ok(appEvents.some((e) => e.t === "avatar" && e.text === "在浏览网页"));
  assert.ok(appEvents.some((e) => e.t === "say" && e.cards?.[0]?.type === "browser"));
  const summary = { ok: true, sdk: "0.3.295", realChrome: true, launches, returnedEvents, chatUsers, frames: frames.length, viewport: [1280, 800], mainStreamReused: true, backgroundStreamReused: true, feedLazy: true, requests, log: lines };
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
} finally {
  app?.terminate(); viewer?.terminate();
  if (server?.browserRoutes) await server.browserRoutes.close();
  await harness?.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await api.close(); site.closeAllConnections(); await new Promise((resolve) => site.close(resolve));
}
