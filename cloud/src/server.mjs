import { UsageService } from './usage.mjs';
// HTTP + WebSocket for the App and devices. nginx exposes it at https://<host>/agent/.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { config, CODE, VERSION, PROTOCOL } from "./config.mjs";
import { readJson, writeJson, tailJsonl, firstTs, dateIn } from "./store.mjs";
import { issuePairCode } from "./pair.mjs";
import { transcribe, audioFormat } from "./transcribe.mjs";
import { ConnectorManager } from "./connectors.mjs";
import { schedulerFor } from "./scheduler.mjs";
import { Content } from "./content.mjs";
import { paginateJobs } from "./task-history.mjs";
import { validateMessage } from "./attachments.mjs";
import { HealthSync } from "./health.mjs";
import { getAppSettings, putAppSettings, readAppSettings } from "./app-settings.mjs";
import { Providers } from "./providers.mjs";
import { fileType } from "./media.mjs";
import { localFile, inside, resolvedPath } from "./local-paths.mjs";
import { ClientRequests } from "./client-requests.mjs";
import { listedActivity } from "./task-history.mjs";

function tokenOf(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)pa_token=([^;]+)/);
  try { return m ? decodeURIComponent(m[1]) : ""; } catch { return ""; }
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
  const dir = path.join(config.root, "skills");
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

export function startServer({ harness, hub, bus, log, connectors = harness.connectors || new ConnectorManager(), health = new HealthSync({root:config.root,hub,timezone:config.timezone}), listen = config, content = new Content({ root: config.root, bus, timezone: config.timezone }), schedules = schedulerFor({ harness, log, health, content }) }) {
  const clientRequests = new ClientRequests();
  const providers = new Providers({ root: config.root, connectors, selected: () => readAppSettings(config.root).model, select: model => putAppSettings(config.root, { model }) });
  const usage = new UsageService({ root: config.root, connectors });
  connectors.usage = list => usage.connectorList(list);
  const settingsWithUsage = async () => { const settings = getAppSettings(config.root); settings.providers = await usage.providerList(settings.providers); return settings; };
  const settingsUpdated = async () => { await harness.settingsChanged?.(); bus.emit?.(connectors.redact({ t: "settings", ...await settingsWithUsage() })); };
  const once = async (res, clientId, status, execute) => {
    const response = await clientRequests.run(clientId, async () => {
      try { return { status, body: await execute() }; }
      catch (e) { return { status: e.status || (e.code === "ENOENT" ? 404 : 400), body: { error: connectors.redact(e.message), ...(e.code && { code: e.code }) } }; }
    });
    return json(res, response.status, response.body);
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (p === "/health") return json(res, 200, {ok:true,ready:harness.runtime?.ready===true,kernel:"openclaw",version:VERSION,protocol:PROTOCOL});
    if(p.startsWith("/internal/")) {
      if(req.method!=="POST"||!authed(req)||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||Object.keys(req.headers).some(h=>h==='forwarded'||h==='x-real-ip'||h.startsWith('x-forwarded-')))return json(res,403,{error:"private endpoint"});
      try {const args=JSON.parse((await readRaw(req,1024*1024)).toString('utf8'));return json(res,200,await harness.productTool(p.slice(10),args));}catch(e){return json(res,400,{error:connectors.redact(e.message)});}
    }
    if(p.startsWith("/api/")&&req.headers['x-doudou-protocol']!==PROTOCOL)return json(res,426,{error:"请升级豆豆至 1.3 或更新版本，客户端与云端协议不一致",code:"update_required"});
    if (p === "/api/login" && req.method === "POST") {
      const { token } = await readBody(req);
      req.headers.authorization = `Bearer ${token || ""}`;
      if (!authed(req)) return json(res, 401, { error: "bad token" });
      res.setHeader("set-cookie", `pa_token=${encodeURIComponent(token)}; Path=/agent; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
      return json(res, 200, { ok: true });
    }
    if (p === "/api/pair" && req.method === "POST") return pair(req, res);
    if (!authed(req)) return json(res, 401, { error: "unauthorized" });

    try {
      if (p === "/api/state" && req.method === "GET") return json(res, 200, {
        version: VERSION, busy: harness.busy, avatar: harness.avatar?.value || { state: "idle" },
        devices: hub.online(), activities: harness.runningJobs?.() || [], schedule: schedules.list(),
        firstChat: firstTs(config.chatLog), chatEmpty: !firstTs(config.chatLog), userCall: config.userCall, agentName: content.memory().soul.name,
      });
      if (p === "/api/first-chat" && req.method === "POST") return json(res, 200, await harness.firstChat((await readBody(req)).device));
      if (p === "/api/options/choose" && req.method === "POST") {
        const { messageId, optionId, activityId } = await readBody(req);
        return json(res, 200, await harness.chooseOption(messageId, optionId, activityId));
      }
      if (p === "/api/feed" && req.method === "GET") return json(res, 200, content.feed({ before: url.searchParams.get("before") ?? undefined, days: Number(url.searchParams.get("days") ?? 7) }));
      if (p === "/api/feed/item" && req.method === "GET") return json(res, 200, content.post(url.searchParams.get("path")));
      if (p === "/api/feed/feedback" && req.method === "POST") {
        const body = JSON.parse((await readRaw(req, 64 * 1024)).toString("utf8"));
        return json(res, 200, content.feedback(body));
      }
      if (p === "/api/feed/settings") {
        if (req.method === "GET") return json(res, 200, content.feedSettings());
        if (req.method === "PUT") return json(res, 200, content.putFeedSettings(JSON.parse((await readRaw(req, 160 * 1024)).toString("utf8"))));
        return json(res, 405, { error: "只支持 GET / PUT" });
      }
      if (p === "/api/feed/refresh" && req.method === "POST") return json(res, 202, await schedules.run("feed"));
      if (p === "/api/ideas" && req.method === "GET") return json(res, 200, content.ideas());
      if (p === "/api/ideas/refresh" && req.method === "POST") return json(res, 202, await schedules.run("ideas"));
      if (p === "/api/goals" && req.method === "GET") {
        const result = content.goals({ done: url.searchParams.get("done") === "true" });
        const enabled = new Map(schedules.jobs().map((j) => [j.id, j.enabled !== false]));
        for (const item of result.items) if (enabled.get(`goal:${item.name}`) === false) item.nextCheckin = null;
        return json(res, 200, result);
      }
      if (p === "/api/goals/item" && req.method === "GET") {
        const goal = content.goal(url.searchParams.get("name"), url.searchParams.get("done") === "true");
        if (schedules.jobs().find((j) => j.id === `goal:${goal.name}`)?.enabled === false) goal.nextCheckin = null;
        return json(res, 200, goal);
      }
      if (p === "/api/library" && req.method === "GET") return json(res, 200, content.library());
      if (p === "/api/library/thumbnail" && req.method === "GET") {
        const image = await harness.pages.thumbnail({ path: url.searchParams.get("path") });
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=60" }); return res.end(image.data);
      }
      if (p === "/api/memory" && req.method === "GET") return json(res, 200, content.memory());
      if (p === "/api/memory/item") {
        const rel = url.searchParams.get("path");
        if (typeof rel !== "string" || /[\\\x00-\x1f]/.test(rel) || rel.split("/").includes("..") || !/^(?:(?:SOUL|USER|MEMORY)\.md|memory\/(?:[^/]+\/)*[^/]+\.md|data\/health\/days\.json)$/.test(rel)) return json(res, 400, { error: "记忆路径不正确" });
        if (req.method === "GET") return json(res, 200, { path: rel, text: content.read(rel), readOnly: rel.startsWith("data/health/") });
        if (req.method === "PUT" && !rel.startsWith("data/health/")) {
          const { text } = JSON.parse((await readRaw(req, 160 * 1024)).toString("utf8"));
          if (typeof text !== "string" || text.length > 40000) return json(res, 400, { error: "text 必须是 40000 字以内的文字" });
          content.write(rel, text); bus.emit({ t: "memory_updated", path: rel }); return json(res, 200, { ok: true });
        }
        return json(res, 405, { error: "这个记忆不支持此操作" });
      }
      if (p === "/api/schedules" && req.method === "GET") return json(res, 200, { items: schedules.list() });
      const scheduleRoute = p.match(/^\/api\/schedules\/([^/]+)(?:\/(run))?$/);
      if (scheduleRoute) {
        const id = decodeURIComponent(scheduleRoute[1]);
        if (scheduleRoute[2] && req.method === "POST") return json(res, 202, await schedules.run(id));
        if (!scheduleRoute[2] && req.method === "PUT") return json(res, 200, schedules.setEnabled(id, (await readBody(req)).enabled));
        return json(res, 405, { error: "不支持这个定时操作" });
      }
      if (p === "/api/side-chats" && req.method === "POST") {
        const body = JSON.parse((await readRaw(req, 64 * 1024)).toString("utf8"));
        return await once(res, body?.clientId, 201, async () => ({ ok: true, id: await harness.createSideChat(body.text ?? "", body.attachments ?? [], body.title), chatType: "side" }));
      }
      if (p === "/api/activities" && req.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 30), cursor = url.searchParams.get("before"), before = cursor === null ? undefined : Number(cursor);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || before !== undefined && (!Number.isSafeInteger(before) || before < 1)) return json(res, 400, { error: "limit 要 1–100 的整数，before 要毫秒时间戳" });
        return json(res, 200, { running: before === undefined ? harness.runningJobs?.() || [] : [], ...paginateJobs(harness.recentJobs?.() || [], { before, limit }) });
      }
      const activityRoute = p.match(/^\/api\/activities\/([^/]+)\/(history|send|stop)$/);
      if (activityRoute) {
        const id = decodeURIComponent(activityRoute[1]);
        if (activityRoute[2] === "history" && req.method === "GET") return json(res, 200, harness.taskHistory(id));
        if (activityRoute[2] === "stop" && req.method === "POST") { await harness.stopTask(id); return json(res, 200, { ok: true, id }); }
        if (activityRoute[2] === "send" && req.method === "POST") {
          const body = JSON.parse((await readRaw(req, 64 * 1024)).toString("utf8"));
          return await once(res, body?.clientId, 200, async () => {
            const message = validateMessage(config.root, body.text ?? "", body.attachments ?? []);
            await harness.sendTask(id, message.text, message.attachments); return { ok: true, id };
          });
        }
        return json(res, 405, { error: "不支持这个活动操作" });
      }
    } catch (e) {
      return json(res, e.status || (e instanceof SyntaxError || e instanceof URIError ? 400 : e.code === "ENOENT" ? 404 : 400), { error: connectors.redact(e instanceof SyntaxError ? "请提交有效的 JSON" : e.message), ...(e.code && { code: e.code }) });
    }
    if(p==="/api/health"&&req.method==="GET"||p==="/api/health/sync"&&req.method==="POST") {
      try{return json(res,200,await health.sync());}
      catch{ return json(res,500,{error:"健康同步暂不可用，请稍后重试"}); }
    }
    if (p === "/api/settings") {
      if (req.method === "GET") {
        try { return json(res,200,connectors.redact(await settingsWithUsage())); }
        catch (e) { return json(res,500,{error:e.message}); }
      }
      if (req.method !== "PUT") return json(res,405,{error:"只支持 GET / PUT"});
      try {
        const body=JSON.parse((await readRaw(req,4096)).toString("utf8"));
        putAppSettings(config.root,body);
        await settingsUpdated();
        return json(res,200,connectors.redact(await settingsWithUsage()));
      } catch (e) { return json(res,400,{error:e instanceof SyntaxError?"请提交有效的 JSON 设置":connectors.redact(e.message)}); }
    }
    if (p === "/api/providers/test" || p === "/api/providers" || p.startsWith("/api/providers/")) {
      try {
        if (p === "/api/providers/test" && req.method === "POST") return json(res, 200, await providers.test(JSON.parse((await readRaw(req, 64 * 1024)).toString("utf8"))));
        if (p === "/api/providers" && req.method === "POST") {
          const provider = await providers.create(JSON.parse((await readRaw(req, 64 * 1024)).toString("utf8")));
          await settingsUpdated(); return json(res, 200, connectors.redact({ provider }));
        }
        const match = p.match(/^\/api\/providers\/([^/]+)$/);
        if (match && req.method === "PATCH") {
          const provider = await providers.patch(decodeURIComponent(match[1]), JSON.parse((await readRaw(req, 64 * 1024)).toString("utf8")));
          await settingsUpdated(); return json(res, 200, connectors.redact({ provider }));
        }
        if (match && req.method === "DELETE") { const value = await providers.remove(decodeURIComponent(match[1])); await settingsUpdated(); return json(res, 200, value); }
        return json(res, 405, { error: "不支持这个模型服务操作" });
      } catch (e) { return json(res, e.status || 400, { error: e instanceof SyntaxError ? "请提交有效的 JSON 模型服务" : connectors.redact(e.message) }); }
    }
    if (p === "/api/pair/new" && req.method === "POST") return json(res, 200, { code: issuePairCode() });
    if (p === "/api/history") {
      const n = Number(url.searchParams.get("n") ?? 200);
      if (!Number.isInteger(n) || n < 1 || n > 1000) return json(res, 400, { error: "n 必须是 1–1000 的整数" });
      return json(res, 200, { items: harness.speech?.history(n) || tailJsonl(config.chatLog, n) });
    }
    if (p === "/api/send" && req.method === "POST") {
      try {
        const body=JSON.parse((await readRaw(req,64*1024)).toString("utf8"));
        return await once(res, body?.clientId, 200, async () => {
          return content.sendMessage(body, harness.send.bind(harness));
        });
      }catch(e){return json(res,e.status||400,{error:e instanceof SyntaxError?"请提交有效的 JSON 消息":connectors.redact(e.message)});}
    }
    if (p === "/api/connectors") {
      return json(res, 200, {
        cloud: { id: "cloud", name: "云端", kind: "cloud", online: true, ...await usage.connectorList(connectors.list({ forApp: true })) },
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
        res.writeHead(200, { "content-type": fileType(icon).mime, "cache-control": "private, max-age=2592000" });
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
    if (p === "/api/tree") {
      const abs = dataPath(url.searchParams.get("dir"));
      if (!abs || !inside(resolvedPath(abs), path.join(fs.realpathSync(config.root), "data"))) return json(res, 400, { error: "outside data/" });
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
      let rel;
      try { rel = decodeURIComponent(p.slice("/files/".length)); }
      catch { return json(res, 400, { error: "invalid path" }); }
      const abs = dataPath(rel);
      if (!abs) return json(res, 400, { error: "outside data/" });
      let file = abs;
      try {
        if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
        if (!fs.statSync(file).isFile()) return json(res, 404, { error: "not found" });
        file = localFile(config.root, path.relative(config.root, file), "data");
        const size = fs.statSync(file).size;
        const headers = { "content-type": fileType(file).mime, "cache-control": "no-cache", "accept-ranges": "bytes" };
        let start = 0, end = size - 1, status = 200;
        if (req.headers.range !== undefined) {
          const range = req.headers.range.trim().match(/^bytes=(\d*)-(\d*)$/);
          if (range && (range[1] || range[2])) {
            if (range[1]) { start = Number(range[1]); end = range[2] ? Number(range[2]) : size - 1; }
            else { start = Math.max(0, size - Number(range[2])); }
          }
          if (!range || !(range[1] || range[2]) || !size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
              start >= size || end < start || !range[1] && (!Number.isSafeInteger(Number(range[2])) || Number(range[2]) === 0)) {
            res.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": 0 });
            return res.end();
          }
          end = Math.min(end, size - 1);
          status = 206;
          headers["content-range"] = `bytes ${start}-${end}/${size}`;
        }
        headers["content-length"] = status === 206 ? end - start + 1 : size;
        if (req.method === "HEAD") { res.writeHead(status, headers); return res.end(); }
        const stream = fs.createReadStream(file, status === 206 ? { start, end } : undefined);
        stream.once("error", () => { if (res.headersSent) res.destroy(); else json(res, 404, { error: "not found" }); });
        res.once("close", () => stream.destroy());
        stream.once("open", () => { res.writeHead(status, headers); stream.pipe(res); });
        return;
      } catch (e) {
        return json(res, e.code ? 404 : 400, { error: e.code ? "not found" : "outside data/" });
      }
    }
    json(res, 404, { error: "no route" });
  });

  const wss = new WebSocketServer({ noServer: true });
  const apps = new Set();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/ws" || !authed(req) || req.headers["x-doudou-protocol"] !== PROTOCOL) {
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
    ws.send(JSON.stringify({ t: "hello", version: VERSION, busy: harness.busy, avatar: harness.avatar?.value || { state: "idle" }, activities: harness.runningJobs?.() || [], devices: hub.online(), history: harness.speech?.history(100) || tailJsonl(config.chatLog, 100) }));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.t === "send") {
        try {
          const message=validateMessage(config.root,msg.text??"",msg.attachments??[]);
          harness.send(message.text,"app",message.attachments).catch((e)=>{if(ws.readyState===1)ws.send(JSON.stringify({t:"error",error:connectors.redact(e.message)}));});
        }catch(e){if(ws.readyState===1)ws.send(JSON.stringify({t:"error",error:e.message}));}
      }
      if (msg.t === "interrupt") harness.interrupt().catch(e=>ws.send(JSON.stringify({t:"error",error:connectors.redact(e.message)})));
      if (msg.t === "choose_option") Promise.resolve().then(() => harness.chooseOption(msg.messageId, msg.optionId, msg.activityId)).catch((e) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: "error", error: e.message, status: e.status || 400 }));
      });
      if (msg.t === "stop_activity") harness.stopTask(msg.id).then(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: "activity_stop", id: msg.id, ok: true }));
      }).catch((e) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: "activity_stop", id: msg.id, ok: false, error: connectors.redact(e.message), code: e.code }));
      });
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
        ws.send(JSON.stringify({t:"registered",id:msg.device.id}));
      }
      if (msg.t === "result") hub.handleResult(msg);
    });
  }

  bus.on((ev) => {
    if (ev.t === "activity" && !listedActivity(harness.history?.records.get(ev.id))) return;
    const event = ev.t === "task" ? { ...ev, t: "background_activities", ...(ev.tasks && { items: ev.tasks }) } : ev;
    if (ev.t === "task") delete event.tasks;
    if (ev.t === "tool") return;
    const s = JSON.stringify(event);
    for (const ws of apps) if (ws.readyState === 1) ws.send(s);
    if (ev.t === "say" && ev.text) hub.broadcast({ t: "event", kind: "reply", messageId: ev.id, text: ev.text.slice(0, 300) });
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
  server.closeSockets = () => { for (const ws of wss.clients) ws.terminate(); };
  server.on("close", () => { clearInterval(heartbeat); server.closeSockets(); wss.close(); });

  server.listen(listen.port, listen.host, () => log("listening on " + listen.host + ":" + server.address().port));
  return server;
}
