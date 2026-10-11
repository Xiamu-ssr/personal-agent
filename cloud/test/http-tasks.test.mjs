import "./environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { config } from "../src/config.mjs";
import { writeJson } from "../src/store.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { ConnectorManager } from "../src/connectors.mjs";
import { TaskError } from "../src/background-tasks.mjs";
import { startServer } from "../src/server.mjs";

test("authenticated HTTP/WS task stop has clear errors and manual briefs use schedule alarms", async (t) => {
  const tasks = new Map([["local-a", { id: "local-a", description: "A", startedAt: 123 }], ["local-b", { id: "local-b", description: "B", startedAt: 456 }]]);
  const ended = new Set(), calls = [], sent = [], isolated = [];
  const harness = { busy: false, connectors: new ConnectorManager(), log() {}, backgroundTasks: () => [...tasks.values()],
    send: async (...args) => sent.push(args), runIsolated: async (...args) => isolated.push(args),
    stopTask: async (id) => {
      if (!id) throw new TaskError("请提供任务 id", 400, "invalid_task_id");
      if (ended.has(id)) throw new TaskError("任务已经结束", 409, "task_ended");
      if (!tasks.has(id)) throw new TaskError("没有这个运行中的后台任务", 404, "task_not_found");
      calls.push(id); tasks.delete(id); ended.add(id);
    } };
  const bus = { on() {} };
  const server = startServer({ harness, hub: new DeviceHub(), bus, log() {}, listen: { host: "127.0.0.1", port: 0 } });
  await once(server, "listening");
  let ws;
  t.after(async () => { ws?.terminate(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const base = "http://127.0.0.1:" + server.address().port;
  const curl = async (route, method = "GET", body, auth = true) => {
    const args = ["--silent", "--show-error", "--max-time", "10", "--write-out", "\n%{http_code}", "--request", method];
    if (auth) args.push("--header", "Authorization: Bearer " + config.token);
    if (body) args.push("--header", "Content-Type: application/json", "--data-binary", JSON.stringify(body));
    const { stdout } = await promisify(execFile)("curl", [...args, base + route]);
    const lines = stdout.trimEnd().split("\n"); return { status: Number(lines.pop()), body: JSON.parse(lines.join("\n")) };
  };
  assert.equal((await curl("/api/tasks/local-a/stop", "POST", {}, false)).status, 401);
  assert.deepEqual((await curl("/api/state")).body.tasks, [...tasks.values()]);
  assert.equal((await curl("/api/tasks/local-a/stop", "POST")).status, 200);
  assert.equal((await curl("/api/tasks/local-a/stop", "POST")).status, 409);
  assert.equal((await curl("/api/tasks/missing/stop", "POST")).status, 404);
  assert.equal((await curl("/api/tasks/%E0/stop", "POST")).status, 400);
  assert.deepEqual((await curl("/api/state")).body.tasks.map((x) => x.id), ["local-b"]);
  ws = new WebSocket(base.replace("http:", "ws:") + "/ws", { headers: { Authorization: "Bearer " + config.token } });
  const hello = once(ws, "message");
  await once(ws, "open");
  assert.deepEqual(JSON.parse((await hello)[0]).tasks.map((x) => x.id), ["local-b"]);
  const stop = async (id) => {
    const response = once(ws, "message"); ws.send(JSON.stringify({ t: "stop_task", id })); return JSON.parse((await response)[0]);
  };
  assert.deepEqual(await stop("local-b"), { t: "task_stop", id: "local-b", ok: true });
  assert.equal((await stop("local-b")).code, "task_ended");
  assert.equal((await stop("unknown")).code, "task_not_found");
  assert.equal((await stop()).code, "invalid_task_id");
  assert.deepEqual(calls, ["local-a", "local-b"]);
  writeJson(config.scheduleFile, [{ id: "brief", kind: "brief", name: "报价简报", prompt: "总结报价" },
    { id: "night", prompt: "[夜间整理]" }, { id: "compact", kind: "compact" }]);
  assert.deepEqual((await curl("/api/run", "POST", { id: "brief" })).body, { ok: true, mode: "alarm" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], "schedule");
  assert.equal(sent[0][0], "总结报价");
  assert.equal((await curl("/api/run", "POST", { id: "night" })).body.mode, "isolated");
  assert.deepEqual(isolated, [["night", "[夜间整理]"]]);
  assert.equal((await curl("/api/run", "POST", { id: "compact" })).status, 404);
  assert.equal((await curl("/api/state")).status, 200, "errors leave the server usable");
});
