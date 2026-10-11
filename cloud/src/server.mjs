// HTTP + WebSocket for the App and devices. nginx exposes it at https://<host>/agent/.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { config, CODE } from "./config.mjs";
import { readJson, writeJson, tailJsonl, firstTs, dateIn } from "./store.mjs";
import { issuePairCode } from "./pair.mjs";
import { transcribe, audioFormat } from "./transcribe.mjs";
import { ConnectorManager } from "./connectors.mjs";
import { runScheduledTask } from "./scheduler.mjs";
import { listBriefs } from "./briefs.mjs";
import { getProfile, putProfile } from "./profile.mjs";
import { getAppSettings, putAppSettings } from "./app-settings.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".json": "application/json",
  ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".ico": "image/x-icon", ".webp": "image/webp",
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

export function startServer({ harness, hub, bus, log, connectors = harness.connectors || new ConnectorManager(), listen = config }) {
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
        busy: harness.busy, devices: hub.online(), userCall: config.userCall, agentName: config.agentName,
        tasks: harness.backgroundTasks?.() || [],
        schedule: readJson(config.scheduleFile, []), firstChat: firstTs(config.chatLog),
      });
    }
    if (p === "/api/briefs" && req.method === "GET") {
      const days = Number(url.searchParams.get("days") || 7);
      if (!Number.isInteger(days) || days < 1 || days > 365) return json(res, 400, { error: "days 必须是 1 到 365 的整数" });
      return json(res, 200, { items: listBriefs(config.root, { days, timezone: config.timezone }) });
    }
    if (p === "/api/profile") {
      if (req.method === "GET") return json(res, 200, getProfile(config.root));
      if (req.method !== "PUT") return json(res, 405, { error: "只支持 GET / PUT" });
      try {
        const value = JSON.parse((await readRaw(req, 4096)).toString("utf8"));
        return json(res, 200, putProfile(config.root, value));
      } catch (e) { return json(res, 400, { error: e instanceof SyntaxError ? "请提交有效的 JSON 头像设置" : e.message }); }
    }
    if (p === "/api/settings") {
      if (req.method === "GET") {
        try { return json(res,200,getAppSettings(config.root)); }
        catch (e) { return json(res,500,{error:e.message}); }
      }
      if (req.method !== "PUT") return json(res,405,{error:"只支持 GET / PUT"});
      try {
        const body=JSON.parse((await readRaw(req,4096)).toString("utf8"));
        const value=putAppSettings(config.root,body);
        harness.settingsChanged?.();
        return json(res,200,value);
      } catch (e) { return json(res,400,{error:e instanceof SyntaxError?"请提交有效的 JSON 设置":e.message}); }
    }
    if (p === "/api/pair/new" && req.method === "POST") return json(res, 200, { code: issuePairCode() });
    if (p === "/api/history") {
      return json(res, 200, { items: tailJsonl(config.chatLog, Number(url.searchParams.get("n") || 200)) });
    }
    if (p === "/api/send" && req.method === "POST") {
      const { text, attachments } = await readBody(req);
      if (!text?.trim() && !attachments?.length) return json(res, 400, { error: "empty" });
      const id = await harness.send((text || "").trim(), "http", attachments || []);
      return json(res, 200, { ok: true, id });
    }
    const taskStop = p.match(/^\/api\/tasks\/([^/]+)\/stop$/);
    if (taskStop && req.method === "POST") {
      try {
        const id = decodeURIComponent(taskStop[1]);
        await harness.stopTask(id);
        return json(res, 200, { ok: true, id });
      } catch (e) {
        if (e instanceof URIError) return json(res, 400, { error: "任务 id 格式不对", code: "invalid_task_id" });
        if (!e.status) log("task stop failed:", connectors.redact(e.message));
        return json(res, e.status || 502, { error: e.status ? e.message : "停止任务失败，请稍后再试", code: e.code || "task_stop_failed" });
      }
    }
    const taskRoute=p.match(/^\/api\/tasks\/([^/]+)\/(history|send)$/);
    if (taskRoute) {
      try {
        const id=decodeURIComponent(taskRoute[1]);
        if (taskRoute[2]==="history"&&req.method==="GET") return json(res,200,await harness.taskHistory(id));
        if (taskRoute[2]==="send"&&req.method==="POST") {
          let body;
          try { body=JSON.parse((await readRaw(req,40*1024)).toString("utf8")); }
          catch { return json(res,400,{error:"请提交有效的 JSON 续聊消息",code:"invalid_task_text"}); }
          await harness.sendTask(id,body?.text);
          return json(res,200,{ok:true,id});
        }
        return json(res,405,{error:"不支持这个任务操作"});
      } catch (e) {
        if (e instanceof URIError) return json(res,400,{error:"任务 id 格式不对",code:"invalid_task_id"});
        if (!e.status) log("task history/send failed:",connectors.redact(e.message));
        return json(res,e.status||502,{error:e.status?e.message:"任务操作失败，请稍后再试",code:e.code||"task_failed"});
      }
    }
    if (p === "/api/connectors") {
      return json(res, 200, {
        cloud: { id: "cloud", name: "云电脑", kind: "cloud", online: true, ...connectors.list() },
        devices: hub.known(),
      });
    }
    const iconRoute = p.match(/^\/api\/connectors\/([^/]+)\/icon$/);
    if (iconRoute && req.method === "GET") {
      try {
        const definition = connectors.definition(decodeURIComponent(iconRoute[1]));
        const dir = path.join(CODE, "connectors", definition.name);
        const icon = path.resolve(dir, definition.icon);
        if (!icon.startsWith(dir + path.sep)) throw new Error("invalid icon");
        const body = fs.readFileSync(icon);
        res.writeHead(200, { "content-type": TYPES[path.extname(icon)] || "application/octet-stream", "cache-control": "private, max-age=2592000" });
        return res.end(body);
      } catch { return json(res, 404, { error: "没有这个连接器图标" }); }
    }
    const accountRoute = p.match(/^\/api\/connectors\/([^/]+)\/accounts(?:\/([^/]+))?(?:\/(test))?$/);
    if (accountRoute) {
      try {
        const name = decodeURIComponent(accountRoute[1]);
        const id = accountRoute[2] && decodeURIComponent(accountRoute[2]);
        if (req.method === "DELETE" && id && !accountRoute[3]) return json(res, 200, await connectors.removeAccount(name, id));
        if (req.method === "POST" && id && accountRoute[3]) {
          const account = await connectors.testAccount(name, id);
          return json(res, account.status === "ok" ? 200 : 400, account);
        }
        if ((req.method === "POST" && !id) || (req.method === "PUT" && id && !accountRoute[3])) {
          let body;
          try { body = JSON.parse((await readRaw(req, 1024 * 1024)).toString("utf8")); }
          catch { return json(res, 400, { error: "请提交有效的 JSON 配置" }); }
          const account = id ? await connectors.updateAccount(name, id, body?.values) : await connectors.addAccount(name, body?.values);
          return json(res, id ? 200 : 201, account);
        }
        return json(res, 405, { error: "不支持这个连接器操作" });
      } catch (e) {
        return json(res, e.status || 400, { error: connectors.redact(e.message || "连接器操作失败") });
      }
    }
    const deviceRoute = p.match(/^\/api\/devices\/([^/]+)$/);
    if (deviceRoute && req.method === "DELETE") {
      try { return json(res, 200, hub.forget(decodeURIComponent(deviceRoute[1]))); }
      catch (e) { return json(res, e.status || 400, { error: e.message || "设备移除失败" }); }
    }
    if (p === "/api/jobs") {
      return json(res, 200, {
        running: harness.runningJobs?.() || [],
        recent: harness.recentJobs?.() || [],
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
      fs.mkdirSync(path.join(config.root, "data", "uploads", day), { recursive: true });
      // Phones often name every photo image.jpg; never overwrite an earlier upload from the same second.
      const ext = path.extname(name);
      let rel;
      for (let i = 1; ; i++) {
        rel = path.join("data", "uploads", day, `${stamp}-${i === 1 ? name : `${name.slice(0, name.length - ext.length)}-${i}${ext}`}`);
        try {
          fs.writeFileSync(path.join(config.root, rel), buf, { flag: "wx" });
          break;
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
        }
      }
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
      if (!job || (job.kind && job.kind !== "brief")) return json(res, 404, { error: "no such job" });
      try {
        const mode = await runScheduledTask(harness, job);
        return json(res, 202, { ok: true, mode });
      } catch (e) {
        log("manual run failed:", connectors.redact(e.message));
        return json(res, 503, { error: "任务暂时无法启动，请稍后再试" });
      }
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
      if (abs.startsWith(path.join(config.data,"briefs")+path.sep) && path.extname(abs)===".json") return json(res,404,{error:"简报只提供 HTML"});
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
    ws.send(JSON.stringify({ t: "hello", busy: harness.busy, tasks: harness.backgroundTasks?.() || [], devices: hub.online(), history: tailJsonl(config.chatLog, 100), queued: harness.queuedMessages?.() || [] }));
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
      if (["unqueue", "edit_queued"].includes(msg.t)) {
        if (typeof msg.id !== "string" || !msg.id || (msg.t === "edit_queued" && typeof msg.text !== "string")) {
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: "error", error: "请提供消息 id 和有效的修改文本" }));
          return;
        }
        try {
          const update = harness.updateQueued(msg.id, msg.t === "edit_queued" ? msg.text : undefined);
          if (update.state === "too_late" && ws.readyState === 1) ws.send(JSON.stringify(update));
        } catch (e) {
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: "error", error: e.message }));
        }
      }
      if (msg.t === "stop_task") {
        harness.stopTask(msg.id).then(() => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: "task_stop", id: msg.id, ok: true }));
        }).catch((e) => {
          if (!e.status) log("task stop failed:", connectors.redact(e.message));
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: "task_stop", id: msg.id, ok: false,
            error: e.status ? e.message : "停止任务失败，请稍后再试", code: e.code || "task_stop_failed" }));
        });
      }
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

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  server.on("close", () => { clearInterval(heartbeat); wss.close(); });

  server.listen(listen.port, listen.host, () => log("listening on " + listen.host + ":" + server.address().port));
  return server;
}
