import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { validateMessage, userContent } from "../src/attachments.mjs";
import { Harness } from "../src/agent.mjs";
import { ConnectorManager } from "../src/connectors.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { startServer } from "../src/server.mjs";
import { config } from "../src/config.mjs";

function upload(root, name, data) {
  const file = path.join(root, "data/uploads/fixture", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return { path: path.relative(root, file), name, kind: "file" };
}

test("attachment size is the actual file size, ignoring any client-supplied size", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "sizes-")), att = upload(root, "报价.txt", Buffer.alloc(12 * 1024));
  for (const size of [0, 1, 100 * 1024 * 1024, -1, "forged", null]) {
    const value = validateMessage(root, " 文件 ", [{ ...att, size }]);
    assert.equal(value.text, "文件");
    assert.deepEqual(value.attachments, [{ ...att, size: fs.statSync(path.join(root, att.path)).size }]);
  }
});

test("legacy attachment requests without size still accept attachment-only messages", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "legacy-")), att = upload(root, "空文件.txt", Buffer.alloc(0));
  assert.deepEqual(validateMessage(root, "", [att]), { text: "", attachments: [{ ...att, size: 0 }] });
  assert.deepEqual(validateMessage(root, "  纯文本  "), { text: "纯文本", attachments: [] });
});

test("image, file and voice attachments retain kinds, names and sizes; images remain message blocks", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "kinds-"));
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const atts = [
    { ...upload(root, "图片.png", imageBytes), kind: "image" },
    upload(root, "文件.txt", Buffer.from("文件内容")),
    { ...upload(root, "语音.m4a", Buffer.from("local voice fixture")), kind: "voice" },
  ];
  const value = validateMessage(root, "", atts);
  assert.deepEqual(value.attachments, atts.map((att) => ({ ...att, size: fs.statSync(path.join(root, att.path)).size })));
  assert.deepEqual(validateMessage(root, "", value.attachments), value, "HTTP/WS and harness validation can run twice");
  value.attachments[2].transcript = "本地转写";
  const content = userContent(root, "", value.attachments);
  assert.match(content[0].text, /语音笔记，转写：本地转写/);
  assert.deepEqual(content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: imageBytes.toString("base64") } });
});

test("file lines include readable sizes and legacy records without size remain readable", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "content-"));
  for (const [size, label] of [[0, "0 B"], [12 * 1024, "12 KB"], [1536, "1.5 KB"], [2 * 1024 * 1024, "2 MB"]]) {
    const att = upload(root, "参考.txt", Buffer.alloc(size));
    const { attachments } = validateMessage(root, "看文件", [att]);
    assert.ok(userContent(root, "看文件", attachments)[0].text.includes(`（文件，${label}，需要时自己读）`));
    assert.ok(userContent(root, "看文件", [att])[0].text.includes("（文件，需要时自己读）"));
  }
  assert.equal(userContent(root, "旧纯文本"), "旧纯文本");
});

test("forged small sizes cannot bypass existing file and image limits", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "limits-"));
  const file = upload(root, "超大.txt", Buffer.alloc(0)), image = { ...upload(root, "超大.png", Buffer.alloc(0)), kind: "image" };
  fs.truncateSync(path.join(root, file.path), 20 * 1024 * 1024 + 1);
  fs.truncateSync(path.join(root, image.path), 5 * 1024 * 1024 + 1);
  assert.throws(() => validateMessage(root, "", [{ ...file, size: 1 }]), /附件超过 20MB/);
  assert.throws(() => validateMessage(root, "", [{ ...image, size: 1 }]), /不能超过 5MB/);
});

test("local HTTP/WS echoes, chat history and task continuation history retain server sizes", { timeout: 15000 }, async (t) => {
  const listeners = new Set(), options = [];
  const bus = { on: (fn) => listeners.add(fn), emit: (event) => listeners.forEach((fn) => fn(event)) };
  const hub = new DeviceHub(), connectors = new ConnectorManager();
  const harness = new Harness({ hub, bus, connectors, log() {}, queryFactory: ({ prompt, options: opts }) => {
    options.push(opts);
    const q = (async function* () {
      yield { type: "system", subtype: "init", session_id: "attachment-fixture" };
      for await (const input of prompt) {
        yield { type: "result", subtype: "success" };
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
      }
    })();
    q.close = () => {};
    return q;
  } });
  // Task execution is a stand-in; sendTask validation and persisted TaskHistory are real.
  harness.runIsolated = async () => {};
  harness.startMain();
  const server = startServer({ harness, hub, bus, log() {}, listen: { host: "127.0.0.1", port: 0 } });
  let ws;
  t.after(async () => {
    ws?.terminate(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    clearTimeout(harness.restartTimer);
    harness.main.intentionalClose = true; harness.main.inbox.close();
    await harness.main.finished;
    for (const opts of options) for (const mcp of Object.values(opts.mcpServers)) await mcp.instance.close();
  });
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port, headers = { Authorization: "Bearer " + config.token };
  const req = async (route, body) => {
    const response = await fetch(base + route, { headers: { ...headers, "Content-Type": "application/json" },
      ...(body !== undefined && { method: "POST", body: JSON.stringify(body) }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  ws = new WebSocket(base.replace("http:", "ws:") + "/ws?role=app", { headers });
  const hello = once(ws, "message"); await once(ws, "open"); await hello;
  function nextUser() {
    return new Promise((resolve) => {
      const receive = (raw) => {
        const event = JSON.parse(raw);
        if (event.t === "user") { ws.off("message", receive); resolve(event); }
      };
      ws.on("message", receive);
    });
  }
  const att = upload(config.root, "链路.txt", Buffer.alloc(12 * 1024));
  const httpEcho = nextUser(), accepted = await req("/api/send", { text: "HTTP 附件", attachments: [{ ...att, size: 1 }] });
  const httpUser = await httpEcho;
  assert.equal(httpUser.id, accepted.id); assert.equal(httpUser.attachments[0].size, 12 * 1024);
  const wsEcho = nextUser();
  ws.send(JSON.stringify({ t: "send", text: "旧 WS 客户端", attachments: [att] }));
  const wsUser = await wsEcho; await harness.inputChain;
  assert.equal(wsUser.attachments[0].size, 12 * 1024);
  const history = (await req("/api/history")).items.filter((item) => item.role === "user");
  assert.deepEqual(history.map((item) => item.id), [accepted.id, wsUser.id]);
  assert.ok(history.every((item) => item.attachments[0].size === 12 * 1024));
  harness.history.put("attachment-task", { kind: "isolated", title: "本地任务", status: "done" });
  assert.deepEqual(await req("/api/activities/attachment-task/send", { text: "", attachments: [att] }), { ok: true, id: "attachment-task" });
  const taskHistory = await req("/api/activities/attachment-task/history");
  assert.equal(taskHistory.items.find((item) => item.from === "user").attachments[0].size, 12 * 1024);
  const reloaded = JSON.parse(fs.readFileSync(path.join(config.system, "activity-index.json"), "utf8"));
  assert.equal(reloaded["attachment-task"].prompts[0].attachments[0].size, 12 * 1024);
});
