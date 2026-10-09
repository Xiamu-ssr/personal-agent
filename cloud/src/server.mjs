// HTTP + WebSocket for the App and devices. nginx exposes it at https://<host>/agent/.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { config } from "./config.mjs";
import { readJson, writeJson, tailJsonl, dateIn } from "./store.mjs";
import { issuePairCode } from "./pair.mjs";
import { transcribe, audioFormat } from "./transcribe.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".json": "application/json",
  ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
};

function tokenOf(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)pa_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

function authed(req) {
  const t = Buffer.from(tokenOf(req));
  const want = Buffer.from(config.token);
  return config.token && t.length === want.length && crypto.timingSafeEqual(t, want);
}

// Resolve a path inside data/ only.
function dataPath(rel) {
  const abs = path.resolve(config.root, rel || "data");
  if (abs !== config.data && !abs.startsWith(config.data + path.sep)) return null;
  return abs;
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > max) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// What the cloud body itself can do, plus connectors installed under system/connectors/ and ones the agent can set up.
const CLOUD_BUILTIN = [
  { name: "web_search", title: "网页搜索", description: "上网搜最新信息" },
  { name: "web_fetch", title: "网页读取", description: "打开网页、读取公开数据接口" },
  { name: "shell", title: "命令行", description: "在云电脑上跑命令、写脚本、处理数据" },
  { name: "files", title: "文件", description: "云电脑上的数据区和草稿区" },
  { name: "schedule", title: "定时任务", description: "按时做简报、整理和提醒" },
  { name: "transcribe", title: "语音转写", description: "把语音笔记和按住说话转成文字" },
];
const CLOUD_CATALOG = [
  { name: "email", title: "邮箱", description: "QQ、163、Gmail、企业邮箱（IMAP）" },
  { name: "calendar", title: "在线日历", description: "iCloud、Google、飞书日历（CalDAV）" },
  { name: "github", title: "GitHub", description: "仓库、Issue、PR" },
  { name: "feishu", title: "飞书", description: "消息、文档、日历" },
  { name: "notion", title: "Notion", description: "笔记和知识库" },
  { name: "rss", title: "RSS 订阅", description: "博客、周刊、播客更新" },
  { name: "tavily", title: "Tavily 搜索", description: "另一个搜索引擎，适合深度检索和网页抽取" },
];

function cloudConnectors() {
  const installed = [];
  try {
    for (const d of fs.readdirSync(config.connectors, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const manifest = readJson(path.join(config.connectors, d.name, ".claude-plugin", "plugin.json"), {});
      installed.push({ name: d.name, title: manifest.displayName || manifest.name || d.name, description: manifest.description || "", status: "on" });
    }
  } catch {}
  const have = new Set(installed.map((c) => c.name));
  return {
    builtin: CLOUD_BUILTIN.map((c) => ({ ...c, status: "on" })),
    installed,
    catalog: CLOUD_CATALOG.filter((c) => !have.has(c.name)).map((c) => ({ ...c, status: "off" })),
  };
}

function skills() {
  const dir = path.join(config.root, ".claude", "skills");
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
      let text = "";
      try {
        text = fs.readFileSync(path.join(dir, d.name, "SKILL.md"), "utf8");
      } catch {}
      const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1] || "";
      const get = (k) => fm.match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "") || "";
      return { name: get("name") || d.name, description: get("description") };
    });
  } catch {
    return [];
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c).length > 1e6 && req.destroy());
    req.on("end", () => {
      try {
        resolve(JSON.parse(s || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

// One-time pairing code -> token. The code is single-use, expires, and dies after 5 wrong tries.
async function pair(req, res) {
  const file = path.join(config.system, "pair.json");
  const p = readJson(file, null);
  const { code } = await readBody(req);
  if (!p || Date.now() > p.expires) return json(res, 410, { error: "配对码过期了，重新要一个" });
  if (String(code || "").trim() !== p.code) {
    p.fails = (p.fails || 0) + 1;
    p.fails >= 5 ? fs.rmSync(file, { force: true }) : writeJson(file, p);
    return json(res, 403, { error: p.fails >= 5 ? "错太多次，配对码作废了" : "配对码不对" });
  }
  fs.rmSync(file, { force: true });
  return json(res, 200, { token: config.token });
}

export function startServer({ harness, hub, bus, log }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (p === "/health") return json(res, 200, { ok: true });
    if (p === "/api/login" && req.method === "POST") {
      const { token } = await readBody(req);
      req.headers.authorization = `Bearer ${token || ""}`;
      if (!authed(req)) return json(res, 401, { error: "bad token" });
      res.setHeader("set-cookie", `pa_token=${encodeURIComponent(token)}; Path=/agent; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
      return json(res, 200, { ok: true });
    }
    if (p === "/api/pair" && req.method === "POST") return pair(req, res);
    if (!authed(req)) return json(res, 401, { error: "unauthorized" });

    if (p === "/api/state") {
      return json(res, 200, {
        busy: harness.busy, devices: hub.online(), model: config.model,
        schedule: readJson(config.scheduleFile, []),
      });
    }
    if (p === "/api/pair/new" && req.method === "POST") return json(res, 200, { code: issuePairCode() });
    if (p === "/api/history") {
      return json(res, 200, { items: tailJsonl(config.chatLog, Number(url.searchParams.get("n") || 200)) });
    }
    if (p === "/api/send" && req.method === "POST") {
      const { text, attachments } = await readBody(req);
      if (!text?.trim() && !attachments?.length) return json(res, 400, { error: "empty" });
      await harness.send((text || "").trim(), "http", attachments || []);
      return json(res, 200, { ok: true });
    }
    if (p === "/api/connectors") {
      return json(res, 200, {
        cloud: { id: "cloud", name: "云电脑", kind: "cloud", online: true, ...cloudConnectors() },
        devices: hub.known(),
      });
    }
    if (p === "/api/jobs") {
      return json(res, 200, {
        running: [...harness.running].map(([label, started]) => ({ label, started })),
        recent: tailJsonl(path.join(config.system, "jobs.jsonl"), 50).reverse(),
      });
    }
    if (p === "/api/skills") return json(res, 200, { skills: skills() });
    // Raw body upload into data/uploads/<date>/; the App then sends the returned path as an attachment.
    if (p === "/api/upload" && req.method === "POST") {
      const name = (url.searchParams.get("name") || "file").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").slice(-80) || "file";
      let buf;
      try {
        buf = await readRaw(req, 20 * 1024 * 1024);
      } catch {
        return json(res, 413, { error: "文件太大（上限 20MB）" });
      }
      const day = dateIn(config.timezone);
      const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit", second: "2-digit" })
        .format(new Date()).replace(/:/g, "");
      const rel = path.join("data", "uploads", day, `${stamp}-${name}`);
      fs.mkdirSync(path.join(config.root, "data", "uploads", day), { recursive: true });
      fs.writeFileSync(path.join(config.root, rel), buf);
      return json(res, 200, { path: rel, name, size: buf.length });
    }
    // Hold-to-talk: audio in, text out. Nothing is stored.
    if (p === "/api/transcribe" && req.method === "POST") {
      const format = audioFormat(`x.${url.searchParams.get("format") || "aac"}`);
      if (!format) return json(res, 400, { error: "format 只支持 wav/mp3/aac/ogg/flac/m4a" });
      try {
        const buf = await readRaw(req, 10 * 1024 * 1024);
        return json(res, 200, { text: await transcribe(buf, format) });
      } catch (e) {
        return json(res, 502, { error: `转写失败：${e.message}` });
      }
    }
    if (p === "/api/run" && req.method === "POST") {
      const { id } = await readBody(req);
      const job = readJson(config.scheduleFile, []).find((j) => j.id === id);
      if (!job || job.kind) return json(res, 404, { error: "no such job" });
      const prompt = job.prompt?.startsWith("[") ? job.prompt : `[定时任务] ${job.name || job.id}\n\n${job.prompt || ""}`;
      harness.runIsolated(job.name || job.id, prompt);
      return json(res, 202, { ok: true });
    }
    if (p === "/api/tree") {
      const abs = dataPath(url.searchParams.get("dir"));
      if (!abs) return json(res, 400, { error: "outside data/" });
      try {
        const entries = fs.readdirSync(abs, { withFileTypes: true })
          .filter((d) => !d.name.startsWith("."))
          .map((d) => {
            const st = fs.statSync(path.join(abs, d.name));
            return { name: d.name, dir: d.isDirectory(), size: st.size, mtime: st.mtimeMs };
          })
          .sort((a, b) => b.mtime - a.mtime);
        return json(res, 200, { dir: path.relative(config.root, abs), entries });
      } catch {
        return json(res, 404, { error: "not found" });
      }
    }
    if (p.startsWith("/files/")) {
      const abs = dataPath(decodeURIComponent(p.slice("/files/".length)));
      if (!abs) return json(res, 400, { error: "outside data/" });
      let file = abs;
      try {
        if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
        const body = fs.readFileSync(file);
        res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-cache" });
        return res.end(body);
      } catch {
        return json(res, 404, { error: "not found" });
      }
    }
    json(res, 404, { error: "no route" });
  });

  const wss = new WebSocketServer({ noServer: true });
  const apps = new Set();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/ws" || !authed(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const role = url.searchParams.get("role") === "device" ? "device" : "app";
      ws.isAlive = true;
      ws.on("pong", () => (ws.isAlive = true));
      role === "device" ? onDevice(ws) : onApp(ws);
    });
  });

  function onApp(ws) {
    apps.add(ws);
    ws.on("close", () => apps.delete(ws));
    ws.send(JSON.stringify({ t: "hello", busy: harness.busy, devices: hub.online(), history: tailJsonl(config.chatLog, 100) }));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.t === "send" && (msg.text?.trim() || msg.attachments?.length)) {
        harness.send((msg.text || "").trim(), "app", msg.attachments || []).catch((e) => log("send failed:", e.message));
      }
      if (msg.t === "interrupt") harness.interrupt();
    });
  }

  function onDevice(ws) {
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.t === "register" && msg.device?.id) {
        log(`device online: ${msg.device.id} (${(msg.device.capabilities || []).length} caps)`);
        hub.register(ws, msg.device);
      }
      if (msg.t === "result") hub.handleResult(msg);
    });
  }

  bus.on((ev) => {
    const s = JSON.stringify(ev);
    for (const ws of apps) if (ws.readyState === 1) ws.send(s);
    // Devices show these as notifications when the App isn't open.
    if (ev.t === "turn_end" && ev.text) hub.broadcast({ t: "event", kind: "reply", text: ev.text.slice(0, 300) });
    if (ev.t === "job" && ev.phase === "done" && ev.outputs?.length) hub.broadcast({ t: "event", kind: "job", text: ev.title });
  });

  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  server.listen(config.port, config.host, () => log(`listening on ${config.host}:${config.port}`));
  return server;
}
