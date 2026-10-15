import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { sharedBrowser } from "./browser.mjs";
import { inputSchema } from "./input.mjs";

export function browserAuthed(req, token) {
  let supplied = "";
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) supplied = header.slice(7);
  else {
    const match = (req.headers.cookie || "").match(/(?:^|;\s*)pa_token=([^;]+)/);
    try { supplied = match ? decodeURIComponent(match[1]) : ""; } catch { return false; }
  }
  const actual = Buffer.from(supplied), expected = Buffer.from(token || "");
  return expected.length > 0 && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) { chunks.length = 0; continue; }
    chunks.push(chunk);
  }
  if (size > 64 * 1024) throw Object.assign(new Error("输入超过 64KB"), { status: 413 });
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result;
  }
  catch { throw Object.assign(new Error("JSON 格式不正确"), { status: 400 }); }
}

export function attachBrowserRoutes(server, { browser, token = process.env.AGENT_TOKEN || "", authenticate, ...options } = {}) {
  browser ||= sharedBrowser(options);
  const authed = (req) => {
    try { return authenticate ? !!authenticate(req) : browserAuthed(req, token); }
    catch { return false; }
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const clients = new Map();
  const send = (ws, value) => {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.terminate(); return; }
    if (value.t === "browser_frame" && ws.bufferedAmount > 1024 * 1024) return;
    ws.send(JSON.stringify(value));
  };
  const updateViewers = () => browser.setViewers([...clients.values()].filter((watch) => watch).length);
  const onState = (state) => { for (const ws of clients.keys()) send(ws, state); };
  const onFrame = (frame) => { for (const [ws, watch] of clients) if (watch) send(ws, frame); };
  browser.on("state", onState); browser.on("frame", onFrame);

  async function handleRequest(req, res, pathname) {
    try {
      if (!authed(req)) return json(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && pathname === "/api/browser/state") return json(res, 200, browser.state());
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      const args = await body(req);
      let result;
      switch (pathname) {
        case "/api/browser/open": result = await browser.open(); break;
        case "/api/browser/takeover":
          if (args.reason !== undefined && (typeof args.reason !== "string" || args.reason.length > 300)) return json(res, 400, { error: "reason 必须是 300 字以内的文本" });
          result = await browser.takeover(args.reason || "用户主动接管"); break;
        case "/api/browser/return": result = await browser.handBack(); break;
        case "/api/browser/close": await browser.close(); result = browser.state(); break;
        case "/api/browser/input": result = await browser.input(inputSchema.parse(args)); break;
        default: return json(res, 404, { error: "no route" });
      }
      json(res, 200, result);
    } catch (error) {
      json(res, error.status || (error.name === "ZodError" ? 400 : 503), { error: error.status ? error.message : error.name === "ZodError" ? "输入字段不正确" : "浏览器暂不可用，请检查安装或重新打开" });
    }
  }

  function handleUpgrade(req, socket, head) {
    if (!authed(req)) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.set(ws, true); ws.isAlive = true;
      send(ws, browser.state());
      if (browser.lastFrame) send(ws, browser.lastFrame);
      updateViewers();
      ws.on("pong", () => { ws.isAlive = true; });
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.t !== "browser_watch" || typeof msg.watch !== "boolean") return;
          clients.set(ws, msg.watch); updateViewers();
          if (msg.watch && browser.lastFrame) send(ws, browser.lastFrame);
        } catch {}
      });
      ws.on("error", () => {});
      ws.on("close", () => { clients.delete(ws); updateViewers(); });
    });
  }

  // Existing server.mjs has catch-all request/upgrade handlers. Dispatch before them, forwarding all other routes.
  const previousRequest = server.rawListeners("request"), previousUpgrade = server.rawListeners("upgrade");
  for (const listener of previousRequest) server.removeListener("request", listener);
  for (const listener of previousUpgrade) server.removeListener("upgrade", listener);
  const request = function (req, res) {
    let pathname;
    try { pathname = new URL(req.url, "http://localhost").pathname; }
    catch { return json(res, 400, { error: "invalid URL" }); }
    if (pathname === "/api/browser" || pathname.startsWith("/api/browser/")) { void handleRequest(req, res, pathname); return; }
    for (const listener of previousRequest) listener.call(this, req, res);
  };
  const upgrade = function (req, socket, head) {
    let pathname;
    try { pathname = new URL(req.url, "http://localhost").pathname; }
    catch { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
    if (pathname === "/ws/browser") return handleUpgrade(req, socket, head);
    for (const listener of previousUpgrade) listener.call(this, req, socket, head);
    if (!previousUpgrade.length) socket.destroy();
  };
  server.on("request", request); server.on("upgrade", upgrade);
  const heartbeat = setInterval(() => {
    for (const ws of clients.keys()) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 30_000);
  heartbeat.unref?.();
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true; clearInterval(heartbeat);
    browser.off("state", onState); browser.off("frame", onFrame);
    for (const ws of clients.keys()) ws.terminate();
    clients.clear(); browser.setViewers(0); wss.close();
    server.removeListener("request", request); server.removeListener("upgrade", upgrade);
    for (const listener of previousRequest) server.on("request", listener);
    for (const listener of previousUpgrade) server.on("upgrade", listener);
    server.off("close", close);
    await browser.close();
  }
  server.on("close", close);
  return { browser, close };
}
