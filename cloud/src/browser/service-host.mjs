import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { BrowserProcess } from "./process.mjs";
import { writePrivateJson } from "../private-json.mjs";

export async function startBrowserHost({ root, manager = new BrowserProcess({ root }), idleMs = 10 * 60_000, capture } = {}) {
  if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error("浏览器空闲时间必须是正数");
  const file = path.join(root, "system/browser/service.json"), token = crypto.randomBytes(32).toString("hex");
  let idleTimer, busy = 0, closing, connection, screenshotActive = false, pages;
  const stop = async () => { clearTimeout(idleTimer); await manager.stop(); connection = null; };
  const touch = () => {
    clearTimeout(idleTimer);
    if (closing) return;
    idleTimer = setTimeout(() => { if (!busy) void stop().catch(() => {}); else touch(); }, idleMs);
    idleTimer.unref();
  };
  const screenshotPage = async (body) => {
    if (!pages) {
      const [{ PageScreenshot }, { chromium }] = await Promise.all([import("../page-screenshot.mjs"), import("playwright-core")]);
      pages = new PageScreenshot({ root, service: false, browserProvider: async () => {
        const endpoint = await manager.ensure();
        if (!connection?.isConnected()) connection = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
        return connection;
      }, terminateBrowser: stop });
    }
    pages.timeoutMs = Math.max(100, Math.min(25_000, Number(body.timeoutMs) || 25_000));
    return pages.screenshot({ path: body.path });
  };
  const respond = (res, status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ pid: process.pid, ...value })); };
  const server = http.createServer(async (req, res) => {
    const given = Buffer.from(req.headers.authorization || ""), expected = Buffer.from(`Bearer ${token}`);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) { respond(res, 401, { error: "浏览器服务未授权" }); return; }
    if (req.method === "GET" && req.url === "/status") { respond(res, 200, { endpoint: manager.endpoint || null }); return; }
    if (req.method !== "POST" || !["/browser/ensure", "/browser/stop", "/browser/touch", "/screenshot"].includes(req.url)) { respond(res, 404, { error: "没有这个浏览器服务接口" }); return; }
    let screenshot = false;
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 8192) { respond(res, 413, { error: "浏览器请求过大" }); return; }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
      if (req.url === "/screenshot") {
        if (screenshotActive) { respond(res, 409, { error: "已有页面正在截图，请等它结束后再试" }); return; }
        screenshotActive = screenshot = true;
      }
      busy++; touch();
      try {
        if (req.url === "/browser/ensure") respond(res, 200, { endpoint: await manager.ensure() });
        else if (req.url === "/browser/stop") { await stop(); respond(res, 200, { ok: true }); }
        else if (req.url === "/browser/touch") respond(res, 200, { ok: true });
        else {
          const { data, ...metadata } = await (capture || screenshotPage)(body);
          respond(res, 200, { ...metadata, data: data.toString("base64") });
        }
      } finally { busy--; touch(); }
    } catch { respond(res, 400, { error: "浏览器操作未完成，请检查浏览器安装、页面路径与内存上限" }); }
    finally { if (screenshot) screenshotActive = false; }
  });
  server.requestTimeout = 35_000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(file), 0o700);
  try { writePrivateJson(file, { pid: process.pid, url: `http://127.0.0.1:${server.address().port}`, token }); }
  catch (e) { server.closeAllConnections(); server.close(); throw e; }
  return { server, manager, async close() {
    if (closing) return closing;
    closing = (async () => {
      clearTimeout(idleTimer); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await stop();
      try { const state = JSON.parse(fs.readFileSync(file, "utf8")); if (state.pid === process.pid && state.token === token) fs.rmSync(file); } catch {}
    })();
    return closing;
  } };
}
