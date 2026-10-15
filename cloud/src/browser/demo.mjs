import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CloudBrowser, createBrowserMcpServer, attachBrowserRoutes } from "./index.mjs";

const output = "/tmp/v08-browser-demo";
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "output.log"), "");
const log = (value) => {
  const line = JSON.stringify(value);
  fs.appendFileSync(path.join(output, "output.log"), line + "\n");
  console.log(line);
};
const browser = new CloudBrowser({ root: path.join(output, "root"), idleMs: 3500 });
const samples = [];
const chromeGroups = new Set(), knownPids = new Set();
function memory(stage) {
  const pid = browser.manager.chrome?.pid;
  if (pid) chromeGroups.add(pid);
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,rss="], { encoding: "utf8" }).trim().split("\n")
    .map((line) => { const [pid, ppid, pgid, rssKiB] = line.trim().split(/\s+/).map(Number); return { pid, ppid, pgid, rssKiB }; });
  const owned = new Set([...chromeGroups, ...knownPids]);
  let changed = true;
  while (changed) { changed = false; for (const row of rows) if ((owned.has(row.ppid) || chromeGroups.has(row.pgid)) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } }
  const processes = rows.filter((row) => owned.has(row.pid));
  for (const row of processes) knownPids.add(row.pid);
  const sample = { stage, rssMiB: +(processes.reduce((sum, row) => sum + row.rssKiB, 0) / 1024).toFixed(1), count: processes.length, processes };
  samples.push(sample); log(sample);
}

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>浏览器本地验收</title>
<style>body{font:20px system-ui;margin:36px;background:#f3f5f8;color:#14243a}input,select,button{font:inherit;padding:8px;margin:8px}#panel{padding:24px;background:white;border-radius:20px;width:850px}#user{background:#d9eaff}#tick{color:#718096}</style>
<h1>豆豆 0.8 · 云端浏览器验收</h1><div id="panel"><form id="form"><label>名字<input id="name" aria-label="名字"></label>
<label>颜色<select id="color" aria-label="颜色"><option value="blue">蓝色</option><option value="green">绿色</option></select></label>
<button>提交</button></form><p id="result" role="status">等待提交</p><button id="user">用户按钮</button><span id="count">0</span>
<p><label>接管文本<input id="userText" aria-label="接管文本"></label></p><button id="confirmButton">网页确认框</button><span id="confirmation">等待确认</span><p id="tick">实时画面</p></div>
<script>form.onsubmit=e=>{e.preventDefault();result.textContent='提交成功：'+document.querySelector('#name').value+' / '+color.value;document.title='表单提交成功';localStorage.setItem('browser-demo','persisted')};
let count=0;user.onclick=()=>document.querySelector('#count').textContent=String(++count);confirmButton.onclick=()=>confirmation.textContent=confirm('本地验收确认框')?'已确认':'已取消';setInterval(()=>tick.textContent='实时画面 '+new Date().toLocaleTimeString(),250);</script></html>`;
const server = http.createServer((req, res) => {
  if (req.url === "/demo") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); }
  else { res.writeHead(404); res.end(); }
});
// A catch-all like the production gateway must coexist with the mounted browser WS route.
server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 404 Not Found\r\n\r\n"));
const token = "local-browser-demo-fixture";
const mounted = attachBrowserRoutes(server, { browser, token });
const client = new Client({ name: "browser-demo", version: "0.8.0" });
let ws;
const frames = [], states = [];
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, name + " failed");
  return result;
};
async function waitFor(fn, message, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (!fn()) { if (Date.now() > deadline) throw new Error(message); await delay(30); }
}
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://localhost:${server.address().port}`;
  const post = async (route, value = {}) => {
    const result = await fetch(origin + "/api/browser/" + route, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(value) });
    const data = await result.json(); assert.equal(result.status, 200, JSON.stringify(data)); return data;
  };
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createBrowserMcpServer({ browser }).instance.connect(st); await client.connect(ct);
  await call("open", { url: origin + "/demo" }); memory("opened");
  const chromeVersion = browser.browser.version();
  log({ platform: process.platform, arch: process.arch, nodeVersion: process.version, chromeVersion });
  let snapshot = (await call("snapshot")).content[0].text;
  fs.writeFileSync(path.join(output, "snapshot.txt"), snapshot);
  const refFor = (name) => {
    const line = snapshot.split("\n").find((line) => line.includes('"' + name + '"') && /\[ref=/.test(line));
    assert.ok(line, "missing ref: " + name); return line.match(/\[ref=([^\]]+)\]/)[1];
  };
  await call("fill", { ref: refFor("名字"), text: "豆豆测试" });
  await call("select", { ref: refFor("颜色"), values: ["green"] });
  await call("click", { ref: refFor("提交") });
  snapshot = (await call("snapshot")).content[0].text;
  assert.match(snapshot, /提交成功：豆豆测试 \/ green/);
  assert.equal(await browser.page.evaluate(() => localStorage.getItem("browser-demo")), "persisted");
  await browser.page.context().addCookies([{ name: "browser_demo_login", value: "fixture", url: origin, expires: Math.floor(Date.now() / 1000) + 3600 }]);
  log({ step: "MCP form submitted", refs: true }); memory("form_submitted");
  ws = new WebSocket(origin.replace("http:", "ws:") + "/ws/browser", { headers: { authorization: `Bearer ${token}` } });
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === "browser_state") states.push(msg);
    if (msg.t === "browser_frame") {
      frames.push({ ...msg, data: undefined });
      if (frames.length <= 3) fs.writeFileSync(path.join(output, `frame-${frames.length}.jpg`), Buffer.from(msg.data, "base64"));
    }
  });
  await once(ws, "open"); await waitFor(() => frames.length >= 3, "no screencast frames");
  log({ step: "WebSocket live frames", frames: frames.length, size: [frames.at(-1).width, frames.at(-1).height], viewport: frames.at(-1).viewport }); memory("streaming");
  await call("request_takeover", { reason: "本地验收，请点一下用户按钮" });
  const blocked = await call("click", { ref: refFor("用户按钮") });
  assert.match(blocked.content[0].text, /用户正在操作，等他交还/);
  const button = await browser.page.getByRole("button", { name: "用户按钮", exact: true }).boundingBox();
  const frame = frames.at(-1), width = frame.width / 2, height = frame.height / 2;
  await post("input", { type: "click", frameId: frame.frameId, x: (button.x + button.width / 2) / frame.viewport.width * width,
    y: (button.y + button.height / 2) / frame.viewport.height * height, width, height });
  assert.equal(await browser.page.locator("#count").textContent(), "1");
  const field = await browser.page.getByRole("textbox", { name: "接管文本", exact: true }).boundingBox();
  await post("input", { type: "click", frameId: frames.at(-1).frameId, x: (field.x + 8) / 2, y: (field.y + 8) / 2, width, height });
  await post("input", { type: "text", text: "用户接管输入" });
  assert.equal(await browser.page.locator("#userText").inputValue(), "用户接管输入");
  await post("input", { type: "key", key: "Tab" });
  const confirmButton = await browser.page.getByRole("button", { name: "网页确认框", exact: true }).boundingBox();
  const dialogClick = post("input", { type: "click", frameId: frames.at(-1).frameId, x: (confirmButton.x + 10) / 2, y: (confirmButton.y + 10) / 2, width, height });
  await waitFor(() => browser.dialog?.type === "confirm", "dialog was not forwarded");
  await post("input", { type: "dialog", accept: false }); await dialogClick;
  assert.equal(await browser.page.locator("#confirmation").textContent(), "已取消");
  log({ step: "JavaScript dialog handled by user", accepted: false });
  log({ step: "takeover input", scaledClick: true, userButtonCount: 1, text: true, key: true, agentBlocked: true }); memory("takeover");
  await post("return");
  const returned = (await call("snapshot")).content[0].text; assert.match(returned, /用户接管输入/);
  fs.writeFileSync(path.join(output, "after-return.txt"), returned);
  const screenshot = await call("screenshot");
  fs.writeFileSync(path.join(output, "after-return.jpg"), Buffer.from(screenshot.content[0].data, "base64"));
  log({ step: "handed back", agentRead: true }); memory("handed_back");
  await waitFor(() => browser.state().state === "closed", "idle shutdown did not happen", 12_000);
  await browser.tail;
  memory("idle_closed");
  assert.ok(browser.manager.chrome === null, "Chrome process did not stop");
  assert.equal(samples.at(-1).count, 0, "Chrome children or process group survived idle shutdown");
  log({ step: "idle closed", idleTimeoutMs: browser.idleMs, watchersStillConnected: ws.readyState === 1 });
  await call("open", { url: origin + "/demo" });
  assert.equal(await browser.page.evaluate(() => localStorage.getItem("browser-demo")), "persisted");
  assert.ok((await browser.page.context().cookies()).some((cookie) => cookie.name === "browser_demo_login" && cookie.value === "fixture"));
  log({ step: "profile persisted across restart", localStorage: true, persistentCookie: true }); memory("reopened");
  await browser.close();
  memory("final_closed");
  assert.equal(samples.at(-1).count, 0, "Chrome children or process group survived final shutdown");
  fs.writeFileSync(path.join(output, "memory.json"), JSON.stringify({ platform: process.platform, arch: process.arch, nodeVersion: process.version, chromeVersion, samples, peakMiB: Math.max(...samples.map((sample) => sample.rssMiB)) }, null, 2));
  fs.writeFileSync(path.join(output, "frames.json"), JSON.stringify(frames, null, 2));
  fs.writeFileSync(path.join(output, "states.json"), JSON.stringify(states, null, 2));
  log({ result: "PASS", artifacts: output, peakChromeRssMiB: Math.max(...samples.map((sample) => sample.rssMiB)), frames: frames.length });
} catch (error) {
  log({ result: "FAIL", error: error.message.replaceAll(process.cwd(), "<repo>") }); process.exitCode = 1;
} finally {
  ws?.terminate(); await client.close().catch(() => {}); await mounted.close();
  await new Promise((resolve) => server.close(resolve));
}
