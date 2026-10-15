import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter, once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { SystemdBrowserProcess } from "../src/browser/systemd-process.mjs";
import { startBrowserHost } from "../src/browser/service-host.mjs";
import { serviceState, serviceRequest } from "../src/browser/service-client.mjs";
import { CloudBrowser } from "../src/browser/browser.mjs";
import { browserExecutable } from "../src/browser/process.mjs";
import { PageScreenshot } from "../src/page-screenshot.mjs";
import { screenshotService } from "../src/screenshot-service.mjs";
import { writePrivateJson } from "../src/private-json.mjs";

const until = async (fn) => { const end = Date.now() + 5000; while (!await fn()) { if (Date.now() > end) throw new Error("浏览器 host 测试超时"); await delay(10); } };
class FakeProcess extends EventEmitter {
  launches = 0; stops = 0;
  async ensure() { return this.endpoint ||= `ws://127.0.0.1:9222/devtools/browser/fixture-${++this.launches}`; }
  async stop() { this.stops++; this.crash(); }
  crash() { this.endpoint = null; this.emit("exit"); }
}
async function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(testRoot, "browser-host-")), process = new FakeProcess();
  const host = await startBrowserHost({ root, manager: process, ...options });
  const manager = new SystemdBrowserProcess({ root, startupMs: 100, pollMs: 10_000 });
  t.after(async () => { await manager.stop().catch(() => {}); await host.close(); });
  return { root, host, manager, process };
}

test("system browser host stays online without Chrome, authenticates requests and stops only Chrome", async (t) => {
  const { root, host, manager, process: browser } = await setup(t);
  const state = serviceState(root);
  assert.equal(host.server.address().address, "127.0.0.1"); assert.equal(browser.launches, 0);
  assert.equal(fs.statSync(path.join(root, "system/browser/service.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(root, "system/browser")).mode & 0o777, 0o700);
  assert.equal((await fetch(state.url + "/status")).status, 401);
  assert.equal((await serviceRequest(root, "/status", { method: "GET" })).endpoint, null); assert.equal(browser.launches, 0);
  assert.equal(await manager.ensure(), await manager.ensure()); assert.equal(browser.launches, 1);
  await manager.stop(); assert.equal(manager.endpoint, null);
  assert.equal((await serviceRequest(root, "/status", { method: "GET" })).endpoint, null);
  await manager.ensure(); assert.equal(browser.launches, 2);
});

test("Chrome loss is detected over loopback and a later request reuses the resident host", async (t) => {
  const { root, manager, process: browser } = await setup(t), exits = [];
  manager.on("exit", () => exits.push(true)); const first = await manager.ensure(), pid = serviceState(root).pid;
  browser.crash(); await manager.check(); assert.equal(manager.endpoint, null); assert.equal(exits.length, 1);
  assert.notEqual(await manager.ensure(), first); assert.equal(serviceState(root).pid, pid);
});

test("missing, stale, public or non-loopback service state is rejected without starting Chrome", async (t) => {
  const { root, manager, process: browser } = await setup(t), file = path.join(root, "system/browser/service.json"), original = serviceState(root);
  fs.chmodSync(file, 0o644); assert.throws(() => serviceState(root), /权限/); fs.chmodSync(file, 0o600);
  writePrivateJson(file, { ...original, url: "https://example.test" }); assert.throws(() => serviceState(root), /端点/);
  writePrivateJson(file, { ...original, pid: original.pid + 1 }); await assert.rejects(manager.ensure(), /没有退回主服务/);
  assert.equal(browser.launches, 0); fs.rmSync(file); await assert.rejects(manager.ensure(), /没有退回主服务/);
  writePrivateJson(file, original);
});

test("host idle collection keeps Node available and status polling does not keep Chrome alive", async (t) => {
  const { root, manager, process: browser } = await setup(t, { idleMs: 150 });
  await manager.ensure();
  await until(async () => { await serviceRequest(root, "/status", { method: "GET" }); return !browser.endpoint; });
  assert.ok(browser.stops > 0);
  await manager.check(); await manager.ensure(); assert.equal(browser.launches, 2);
});

test("artifact screenshots use the same authenticated host and preserve bytes and metadata", async (t) => {
  const { root, process: browser } = await setup(t, { capture: async (body) => {
    assert.equal(body.path, "data/library/artifacts/page/index.html"); assert.equal(body.timeoutMs, 7000);
    return { width: 390, height: 844, path: body.path, data: Buffer.from("fixture JPEG bytes") };
  } });
  const result = await screenshotService({ root, path: "data/library/artifacts/page/index.html", timeoutMs: 10_000 });
  assert.equal(result.width, 390); assert.equal(result.data.toString(), "fixture JPEG bytes"); assert.equal(browser.launches, 0);
  assert.equal(fs.existsSync(path.join(root, "system/browser/screenshots")), false);
});

test("host serializes screenshot requests and reports a concurrent request as busy", async (t) => {
  let release, entered = false; const gate = new Promise((r) => { release = r; });
  t.after(() => release());
  const { root } = await setup(t, { capture: async () => { entered = true; await gate; return { data: Buffer.from("jpeg"), width: 390, height: 844 }; } });
  const first = screenshotService({ root, path: "data/library/artifacts/page/index.html" }); await until(() => entered);
  await assert.rejects(serviceRequest(root, "/screenshot", { body: {} }), /正在截图/);
  release(); assert.equal((await first).width, 390);
});

test("system units support 239 and give the body and shared host separate limits without swap prohibition", () => {
  const deploy = new URL("../deploy/", import.meta.url), read = (name) => fs.readFileSync(new URL(name, deploy), "utf8");
  for (const [name, memory] of [["personal-agent.service", 900], ["personal-agent-browser.service", 800]]) {
    const unit = read(name); assert.match(unit, /User=agent/); assert.match(unit, /Type=simple/);
    assert.match(unit, new RegExp(`MemoryLimit=${memory}M`)); assert.match(unit, new RegExp(`MemoryMax=${memory}M`));
    assert.doesNotMatch(unit, /MemorySwapMax=|OOMPolicy=|Slice=|Type=exec/);
  }
  const browser = read("personal-agent-browser.service"), installer = read("browser-service-install.sh"), mainInstaller = read("install.sh");
  assert.match(browser, /WantedBy=multi-user.target/); assert.match(browser, /KillMode=control-group/); assert.match(browser, /Restart=on-failure/);
  assert.doesNotMatch(browser, /PartOf=|BindsTo=|EnvironmentFile=/);
  assert.doesNotMatch(installer + mainInstaller, /--user|loginctl|XDG_RUNTIME_DIR|cgroup.controllers|243/);
  assert.doesNotMatch(mainInstaller, /^\s*systemctl\s+(?:restart|start|try-restart)\s+personal-agent(?:\.service)?\s*$/m);
  for (const file of ["personal-agent-browser.slice", "personal-agent-thumbnail@.service"]) assert.equal(fs.existsSync(new URL(file, deploy)), false);
});

test("root installer can repeat, enables only the system host and leaves the main service running", () => {
  const dir = fs.mkdtempSync(path.join(testRoot, "system-installer-")), bin = path.join(dir, "bin"), log = path.join(dir, "calls.jsonl"); fs.mkdirSync(bin);
  const shim = `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const cmd=path.basename(process.argv[1]),args=process.argv.slice(2);if(cmd==='id'){if(args[0]==='-u')process.stdout.write(process.env.FIXTURE_UID);process.exit(0);}if(cmd==='install'){if(args[0]!=='-d')fs.copyFileSync(args.at(-2),path.join(process.env.FIXTURE_FILES,path.basename(args.at(-1))));}else fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(args)+'\\n');\n`;
  for (const command of ["id", "install", "systemctl"]) { fs.writeFileSync(path.join(bin, command), shim, { mode: 0o755 }); }
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, FIXTURE_UID: "0", FIXTURE_LOG: log, FIXTURE_FILES: dir };
  const script = fileURLToPath(new URL("../deploy/browser-service-install.sh", import.meta.url));
  assert.throws(() => execFileSync("bash", [script], { env: { ...env, FIXTURE_UID: "501" }, stdio: "pipe" }));
  assert.equal(fs.existsSync(log), false);
  for (let i = 0; i < 2; i++) execFileSync("bash", [script], { env, stdio: "pipe" });
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls, [["daemon-reload"], ["enable", "--now", "personal-agent-browser.service"], ["daemon-reload"], ["enable", "--now", "personal-agent-browser.service"]]);
  assert.match(fs.readFileSync(path.join(dir, "personal-agent-browser.service"), "utf8"), /MemoryLimit=800M/);
});

test("a resident real-Chrome host shares one Chrome with thumbnails and survives browser close", { timeout: 35_000, skip: !browserExecutable() }, async (t) => {
  const root = fs.mkdtempSync(path.join(testRoot, "real-browser-host-")), file = path.join(root, "data/library/artifacts/page/index.html");
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "<!doctype html><title>隔离截图</title><h1>共享 Chrome 的本地缩略图</h1>");
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/browser/host.mjs", import.meta.url))], { env: { ...process.env, AGENT_ROOT: root, AGENT_BROWSER_SERVICE: "" }, stdio: "ignore" });
  const manager = new SystemdBrowserProcess({ root }), browser = new CloudBrowser({ manager });
  t.after(async () => { await browser.close().catch(() => {}); const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; });
  await until(() => fs.existsSync(path.join(root, "system/browser/service.json")));
  assert.equal((await serviceRequest(root, "/status", { method: "GET" })).endpoint, null);
  await browser.runAgent(async (page) => { await page.goto("data:text/html;charset=utf-8,<title>用户页面</title><h1>保持用户页面</h1>"); });
  const endpoint = manager.endpoint, pid = serviceState(root).pid;
  const image = await new PageScreenshot({ root, service: true }).screenshot({ path: "data/library/artifacts/page" });
  assert.equal(image.width, 390); assert.equal(image.path, "data/library/artifacts/page/index.html");
  assert.equal((await serviceRequest(root, "/status", { method: "GET" })).endpoint, endpoint);
  assert.equal(await browser.page.title(), "用户页面");
  await browser.close(); assert.equal(child.exitCode, null); assert.equal(serviceState(root).pid, pid);
  assert.equal((await serviceRequest(root, "/status", { method: "GET" })).endpoint, null);
});
