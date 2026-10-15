import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BrowserProcess, chromeArgs } from "../src/browser/process.mjs";
import { CloudBrowser, jpegSize, USER_BUSY } from "../src/browser/browser.mjs";
import { mapCoordinates, dispatchInput } from "../src/browser/input.mjs";
import { createBrowserMcpServer } from "../src/browser/index.mjs";
import { attachBrowserRoutes, browserAuthed } from "../src/browser/routes.mjs";

function rootFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeSpawner(root, { portFile = true } = {}) {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 1_000_000_000 + calls.length, exitCode: null, signalCode: null, stdio: [null, null, null, new PassThrough()] });
    child.kill = (signal) => { child.signalCode = signal; child.emit("exit", null, signal); };
    calls.push({ command, args, options, child });
    queueMicrotask(() => {
      if (command === "Xvfb") child.stdio[3].write("87\n");
      else if (portFile) fs.writeFileSync(path.join(root, "system/browser/profile/DevToolsActivePort"), "43210\n/devtools/browser/local-fixture\n");
    });
    return child;
  };
  return { calls, spawnProcess };
}

function fakeBrowser(t, options = {}) {
  const manager = new EventEmitter();
  Object.assign(manager, { downloads: path.join(rootFor(t), "downloads"), starts: 0, stops: 0,
    ensure: async () => { manager.starts++; return "ws://127.0.0.1:43210/devtools/browser/fake"; },
    stop: async () => { manager.stops++; } });
  const cdp = new EventEmitter(), commands = [];
  cdp.send = async (method, args) => { commands.push({ method, args }); return {}; };
  const page = new EventEmitter();
  Object.assign(page, { isClosed: () => false, url: () => "http://localhost/test", title: async () => "本地测试",
    setViewportSize: async () => {}, mainFrame: () => page, ariaSnapshot: async () => '- button "提交" [ref=e1]',
    getByRef: () => ({ click: async () => {} }), close: async () => {} });
  const context = new EventEmitter();
  Object.assign(context, { pages: () => [page], addInitScript: async () => {}, setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, newCDPSession: async () => cdp });
  const connection = new EventEmitter();
  Object.assign(connection, { contexts: () => [context], isConnected: () => true });
  const browser = new CloudBrowser({ manager, connect: async () => connection, ...options });
  t.after(() => browser.close());
  return { browser, manager, page, context, cdp, commands };
}

const sampleJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 3, 32, 5, 0, 1, 1, 17, 0, 0xff, 0xd9]).toString("base64");
const metadata = { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0, pageScaleFactor: 1 };

test("Linux without DISPLAY starts one private Xvfb before headed Chrome, persists profile, and restarts after crash", async (t) => {
  const root = rootFor(t), spawn = fakeSpawner(root);
  const manager = new BrowserProcess({ root, platform: "linux", env: {}, executablePath: "/fake/chrome", ...spawn });
  t.after(() => manager.stop());
  const [first, second] = await Promise.all([manager.ensure(), manager.ensure()]);
  assert.equal(first, second); assert.equal(spawn.calls.length, 2);
  assert.equal(spawn.calls[0].command, "Xvfb");
  assert.ok(spawn.calls[0].args.includes("1280x800x24"));
  assert.ok(spawn.calls[0].args.includes("-nolisten"));
  assert.equal(spawn.calls[1].options.env.DISPLAY, ":87");
  assert.ok(spawn.calls[1].args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(!spawn.calls[1].args.some((arg) => arg.startsWith("--headless")));
  assert.equal(fs.statSync(manager.profile).mode & 0o777, 0o700);
  fs.writeFileSync(path.join(manager.profile, "persistent-marker"), "keep");
  spawn.calls[1].child.exitCode = 1; spawn.calls[1].child.emit("exit", 1);
  await manager.ensure();
  assert.equal(spawn.calls.length, 4);
  assert.equal(fs.readFileSync(path.join(manager.profile, "persistent-marker"), "utf8"), "keep");
  await manager.stop();
  assert.ok(spawn.calls.every(({ child }) => child.signalCode || child.exitCode !== null));
});

for (const [platform, env] of [["darwin", {}], ["linux", { DISPLAY: ":99" }]]) {
  test(`${platform} with available desktop launches Chrome directly`, async (t) => {
    const root = rootFor(t), spawn = fakeSpawner(root);
    const manager = new BrowserProcess({ root, platform, env, executablePath: "/fake/chrome", ...spawn });
    t.after(() => manager.stop()); await manager.ensure();
    assert.equal(spawn.calls.length, 1); assert.equal(spawn.calls[0].options.env.DISPLAY, env.DISPLAY);
    assert.equal(manager.downloads, path.join(root, "workspace/browser-downloads"));
  });
}

test("startup timeout cleans both process groups and a later call can retry", async (t) => {
  const root = rootFor(t), spawn = fakeSpawner(root, { portFile: false });
  const manager = new BrowserProcess({ root, platform: "linux", env: {}, executablePath: "/fake/chrome", startupMs: 50, ...spawn });
  t.after(() => manager.stop());
  await assert.rejects(manager.ensure(), /超时/); assert.equal(manager.chrome, null); assert.equal(manager.xvfb, null);
  assert.ok(spawn.calls.every(({ child }) => child.signalCode));
  await assert.rejects(manager.ensure(), /超时/); assert.equal(spawn.calls.length, 4);
});

test("graceful exit waits for Chrome to finish before cleaning, and Xvfb death stops its Chrome", async (t) => {
  const root = rootFor(t), spawn = fakeSpawner(root);
  const manager = new BrowserProcess({ root, platform: "linux", env: {}, executablePath: "/fake/chrome", ...spawn });
  t.after(() => manager.stop()); await manager.ensure();
  const chrome = manager.chrome;
  let finished = false;
  const waiting = manager.waitForExit().then(() => { finished = true; });
  await delay(20); assert.equal(finished, false); assert.equal(chrome.signalCode, null);
  chrome.exitCode = 0; chrome.emit("exit", 0); await waiting; await manager.cleanup();
  assert.equal(finished, true); assert.equal(manager.chrome, null); assert.equal(manager.xvfb, null);
  await manager.ensure(); const next = manager.chrome, xvfb = manager.xvfb;
  xvfb.exitCode = 1; xvfb.emit("exit", 1); await manager.cleanup();
  assert.ok(next.signalCode); assert.equal(manager.chrome, null);
});

test("memory flags retain process isolation and sandbox unless explicitly opted out", () => {
  const args = chromeArgs("/tmp/profile");
  assert.ok(args.includes("--renderer-process-limit=1")); assert.ok(args.includes("--js-flags=--max-old-space-size=192"));
  assert.ok(!args.includes("--no-sandbox")); assert.ok(!args.includes("--single-process"));
  assert.ok(chromeArgs("/tmp/profile", { noSandbox: true }).includes("--no-sandbox"));
});

test("takeover aborts in-flight waits, blocks queued and new agent operations without error, then hand-back resumes", async (t) => {
  const { browser } = fakeBrowser(t);
  let began, executed = 0;
  const ready = new Promise((resolve) => { began = resolve; });
  const running = browser.runAgent(async (_page, signal) => { began(); await delay(10_000, null, { signal }); executed++; });
  await ready;
  const queued = browser.runAgent(async () => { executed++; });
  const takeover = browser.takeover("这里要登录，你来一下");
  assert.deepEqual(await running, { blocked: true, message: USER_BUSY });
  assert.equal((await queued).blocked, true); await takeover;
  assert.equal((await browser.runAgent(() => { executed++; })).blocked, true); assert.equal(executed, 0);
  assert.equal(browser.state().state, "user");
  const returned = []; browser.on("returned", (event) => returned.push(event));
  await browser.handBack(); await browser.runAgent(() => { executed++; }); assert.equal(executed, 1);
  await browser.handBack();
  assert.equal(returned.length, 1); assert.equal(returned[0].t, "browser_returned");
  assert.equal(returned[0].reason, "这里要登录，你来一下");
});

test("disconnected Chrome reconnects on next use and takeover ownership survives disconnection", async (t) => {
  const { browser, manager } = fakeBrowser(t);
  await browser.open(); await browser.takeover("请登录");
  manager.emit("exit");
  assert.equal(browser.state().state, "closed"); assert.equal(browser.state().control, "user");
  assert.equal((await browser.runAgent(() => {})).blocked, true);
  await browser.handBack(); await browser.runAgent(() => ({ ok: true }));
  assert.equal(manager.starts, 2); assert.equal(browser.state().state, "idle");
});

test("a stalled title read does not hold open or takeover operations", async (t) => {
  const { browser, page } = fakeBrowser(t);
  let resolveTitle;
  page.title = () => new Promise((resolve) => { resolveTitle = resolve; });
  await browser.open();
  const timer = delay(300).then(() => "timeout");
  const state = await Promise.race([browser.takeover("请登录"), timer]);
  assert.notEqual(state, "timeout"); assert.equal(state.state, "user");
  resolveTitle("恢复后的标题"); await delay(0); assert.equal(browser.title, "恢复后的标题");
});

test("real SDK MCP initialize/list/call provides Chinese descriptions, refs, and non-error takeover gating", async (t) => {
  const { browser } = fakeBrowser(t), server = createBrowserMcpServer({ browser });
  const client = new Client({ name: "browser-test", version: "0.8.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(st); await client.connect(ct); t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name), ["open", "snapshot", "click", "fill", "select", "press", "scroll", "screenshot", "wait", "request_takeover"]);
  assert.ok(tools.every(({ description }) => /[\u4e00-\u9fff]/.test(description)));
  const result = await client.callTool({ name: "snapshot", arguments: {} });
  assert.match(result.content[0].text, /ref=e1/);
  await client.callTool({ name: "request_takeover", arguments: { reason: "这里要登录，你来一下" } });
  for (const [name, args] of [["click", { ref: "e1" }], ["snapshot", {}], ["screenshot", {}], ["wait", { seconds: 10 }]]) {
    const held = await client.callTool({ name, arguments: args });
    assert.notEqual(held.isError, true); assert.match(held.content[0].text, /用户正在操作，等他交还/);
  }
  const invalid = await client.callTool({ name: "open", arguments: { url: "file:///private" } });
  assert.equal(invalid.isError, true);
});

test("coordinate conversion handles displayed-image scaling and page zoom without adding document scroll", () => {
  const frame = { viewport: { width: 1280, height: 800 } };
  assert.deepEqual(mapCoordinates({ x: 320, y: 200, width: 640, height: 400 }, frame), { x: 640, y: 400 });
  assert.deepEqual(mapCoordinates({ x: 640, y: 400, width: 640, height: 400 }, frame), { x: 1279, y: 799 });
  assert.deepEqual(mapCoordinates({ x: 320, y: 200, width: 640, height: 400 }, { viewport: { width: 640, height: 400 } }), { x: 320, y: 200 });
  for (const bad of [{ x: -1, y: 0 }, { x: 641, y: 0 }, { x: NaN, y: 0 }, { x: 0, y: Infinity }]) assert.throws(() => mapCoordinates({ width: 640, height: 400, ...bad }, frame));
});

test("CDP input covers click, drag, pointer, wheel, text and keys; rejects stale frames", async () => {
  const commands = [], cdp = { send: async (method, args) => { commands.push({ method, args }); } };
  const frames = new Map([[1, { viewport: { width: 1280, height: 800 } }]]), state = {};
  const at = { frameId: 1, width: 640, height: 400, x: 100, y: 50 };
  await dispatchInput(cdp, { type: "click", ...at }, frames, state);
  assert.equal(commands[1].args.type, "mousePressed"); assert.equal(commands[1].args.x, 200);
  assert.equal(commands[2].args.type, "mouseReleased"); assert.equal(state.pointerDown, null);
  await dispatchInput(cdp, { type: "drag", ...at, points: [{ x: 100, y: 50 }, { x: 150, y: 50 }] }, frames, state);
  assert.equal(commands.at(-1).args.x, 300);
  await dispatchInput(cdp, { type: "pointer", phase: "down", ...at }, frames, state);
  await dispatchInput(cdp, { type: "pointer", phase: "move", ...at, x: 200 }, frames, state);
  assert.equal(commands.at(-1).args.buttons, 1);
  await dispatchInput(cdp, { type: "pointer", phase: "up", ...at }, frames, state);
  await dispatchInput(cdp, { type: "scroll", ...at, deltaY: 100 }, frames);
  assert.equal(commands.at(-1).args.deltaY, 200);
  await dispatchInput(cdp, { type: "text", text: "本地测试" }, frames);
  assert.equal(commands.at(-1).method, "Input.insertText");
  await dispatchInput(cdp, { type: "key", key: "Enter" }, frames);
  assert.equal(commands.at(-2).args.windowsVirtualKeyCode, 13); assert.equal(commands.at(-1).args.type, "keyUp");
  await assert.rejects(dispatchInput(cdp, { type: "click", ...at, frameId: 2 }, frames), /过期/);
});

test("user input requires takeover and hand-back releases a held pointer", async (t) => {
  const { browser, commands } = fakeBrowser(t);
  await browser.open();
  await assert.rejects(browser.input({ type: "text", text: "test" }), /先接管/);
  await browser.takeover();
  browser.frames.set(1, { viewport: { width: 1280, height: 800 } });
  await browser.input({ type: "pointer", phase: "down", frameId: 1, width: 640, height: 400, x: 10, y: 10 });
  await browser.handBack();
  assert.equal(commands.at(-1).args.type, "mouseReleased"); assert.equal(browser.pointerDown, null);
});

test("JavaScript dialogs request takeover, remain for user confirmation, and block premature hand-back", async (t) => {
  const { browser, page, commands } = fakeBrowser(t);
  await browser.open();
  page.emit("dialog", { type: () => "confirm", message: () => "请确认操作", defaultValue: () => "" });
  await browser.tail;
  assert.equal(browser.owner, "user"); assert.equal(browser.state().dialog.type, "confirm");
  assert.equal(commands.some(({ method }) => method === "Page.handleJavaScriptDialog"), false);
  await assert.rejects(browser.handBack(), /先处理网页对话框/);
  await browser.input({ type: "dialog", accept: false });
  assert.deepEqual(commands.at(-1), { method: "Page.handleJavaScriptDialog", args: { accept: false } });
  await browser.handBack(); assert.equal(browser.state().dialog, null);
});

test("dialog answers bypass a CDP click waiting for that answer", async (t) => {
  const { browser, cdp } = fakeBrowser(t);
  await browser.open(); await browser.takeover();
  let unblock;
  const original = cdp.send;
  cdp.send = async (method, args) => {
    if (method === "Input.insertText") {
      browser.dialog = { type: "confirm", message: "确认", defaultValue: "" };
      await new Promise((resolve) => { unblock = resolve; });
    }
    if (method === "Page.handleJavaScriptDialog") unblock();
    return original(method, args);
  };
  const input = browser.input({ type: "text", text: "test" });
  await delay(10);
  await browser.input({ type: "dialog", accept: false });
  await input; assert.equal(browser.dialog, null);
});

test("idle closes even with a viewer, actions reset its deadline, and later use restarts", async (t) => {
  const { browser, manager } = fakeBrowser(t, { idleMs: 70 });
  await browser.open(); browser.setViewers(1);
  await delay(45); await browser.runAgent(() => ({ ok: true }));
  await delay(40); assert.notEqual(browser.state().state, "closed");
  await delay(65); await browser.tail;
  assert.equal(browser.state().state, "closed"); assert.equal(manager.stops, 1);
  await browser.open(); assert.equal(manager.starts, 2);
});

test("screencast starts only for watchers, bounds frame rate, acknowledges every frame, stops and restarts", async (t) => {
  const { browser, cdp, commands } = fakeBrowser(t);
  await browser.open(); assert.equal(commands.some(({ method }) => method === "Page.startScreencast"), false);
  browser.setViewers(1); await browser.tail;
  assert.equal(commands.at(-1).method, "Page.startScreencast");
  const frames = []; browser.on("frame", (frame) => frames.push(frame));
  const emit = (sessionId) => cdp.emit("Page.screencastFrame", { data: sampleJpeg, metadata, sessionId });
  emit(1); await delay(15); emit(2); emit(3); await delay(220);
  assert.equal(frames.length, 2); assert.equal(frames[0].width, 1280); assert.equal(frames[0].height, 800);
  assert.ok(frames[1].timestamp - frames[0].timestamp >= 195);
  assert.equal(commands.filter(({ method }) => method === "Page.screencastFrameAck").length, 3);
  browser.setViewers(0); await browser.tail; assert.equal(commands.at(-1).method, "Page.stopScreencast");
  browser.setViewers(1); await browser.tail; emit(4); await delay(15); assert.equal(frames.length, 3);
  assert.throws(() => jpegSize(Buffer.from("invalid").toString("base64")));
});

test("bearer/cookie authentication matches App token rules and malformed cookies fail closed", () => {
  const req = (headers) => ({ headers });
  assert.equal(browserAuthed(req({ authorization: "Bearer fixture" }), "fixture"), true);
  assert.equal(browserAuthed(req({ cookie: "extra=a; pa_token=hello%20world" }), "hello world"), true);
  assert.equal(browserAuthed(req({ authorization: "Bearer wrong", cookie: "pa_token=fixture" }), "fixture"), false);
  assert.equal(browserAuthed(req({ cookie: "pa_token=%broken" }), "fixture"), false);
  assert.equal(browserAuthed(req({}), ""), false);
});

test("HTTP/WS routes intercept only their own paths, enforce auth/control and stream state/frames", async (t) => {
  const { browser, cdp } = fakeBrowser(t);
  const server = http.createServer((_req, res) => { res.writeHead(418); res.end("previous"); });
  let oldUpgrade = 0;
  server.on("upgrade", (_req, socket) => { oldUpgrade++; socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); });
  const mounted = attachBrowserRoutes(server, { browser, authenticate: (req) => {
    if (req.headers.cookie === "pa_token=%broken") throw new URIError("malformed cookie");
    return browserAuthed(req, "local-fixture");
  } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await mounted.close(); await new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`, auth = { authorization: "Bearer local-fixture" };
  const post = (route, value = {}) => fetch(origin + "/api/browser/" + route, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(value) });
  assert.equal((await fetch(origin + "/existing")).status, 418);
  assert.equal((await fetch(origin + "/api/browser/state")).status, 401);
  assert.equal((await fetch(origin + "/api/browser/state", { headers: { cookie: "pa_token=%broken" } })).status, 401);
  assert.equal((await fetch(origin + "/api/browser/state", { headers: { cookie: "pa_token=local-fixture" } })).status, 200);
  assert.equal((await post("open")).status, 200);
  assert.equal((await post("input", { type: "text", text: "test" })).status, 409);
  assert.equal((await post("takeover")).status, 200);
  assert.equal((await post("input", { type: "text", text: "test" })).status, 200);
  assert.equal((await post("input", { type: "click", x: "invalid" })).status, 400);
  assert.equal((await post("open", null)).status, 400);
  assert.equal((await post("input", { type: "text", text: "x".repeat(70 * 1024) })).status, 413);
  assert.equal((await post("return")).status, 200);
  const denied = new WebSocket(origin.replace("http:", "ws:") + "/ws/browser");
  const deniedResult = new Promise((resolve) => { denied.on("unexpected-response", (_req, res) => { res.resume(); denied.terminate(); resolve(res.statusCode); }); denied.on("error", () => {}); });
  assert.equal(await deniedResult, 401);
  const ws = new WebSocket(origin.replace("http:", "ws:") + "/ws/browser", { headers: auth });
  const messages = []; ws.on("message", (raw) => messages.push(JSON.parse(raw)));
  await once(ws, "open"); await delay(20); await browser.tail;
  cdp.emit("Page.screencastFrame", { data: sampleJpeg, metadata, sessionId: 1 }); await delay(30);
  assert.ok(messages.some(({ t }) => t === "browser_state")); assert.ok(messages.some(({ t }) => t === "browser_frame"));
  assert.equal(oldUpgrade, 0);
  const legacy = new WebSocket(origin.replace("http:", "ws:") + "/ws", { headers: auth });
  const legacyStatus = new Promise((resolve) => { legacy.on("unexpected-response", (_req, res) => { res.resume(); legacy.terminate(); resolve(res.statusCode); }); legacy.on("error", () => {}); });
  assert.equal(await legacyStatus, 401); assert.equal(oldUpgrade, 1);
  ws.send(JSON.stringify({ t: "browser_watch", watch: false })); await delay(20); await browser.tail;
  assert.equal(browser.viewers, 0); ws.terminate();
  await mounted.close();
  assert.equal((await fetch(origin + "/api/browser/state")).status, 418);
});
