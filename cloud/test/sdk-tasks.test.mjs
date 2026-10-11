import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { config } from "../src/config.mjs";
import { writeJson, tailJsonl } from "../src/store.mjs";
import { runScheduledTask } from "../src/scheduler.mjs";
import { fakeAnthropic } from "./fake-anthropic.mjs";

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const contentText = (content) => typeof content === "string" ? content : (content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
const forkDirective = (body) => body.messages.map((m) => contentText(m.content)).findLast((s) => s.includes("You are a worker fork."));
const hasAgentCall = (body) => body.messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use" && b.name === "Agent"));
// UserPromptSubmit appends an additionalContext reminder; inspect the actual fixture input, not that reminder.
const latestInput = (body) => body.messages.filter((m) => m.role === "user").map((m) => contentText(m.content))
  .findLast((s) => /USER_DURING_NOTIFICATION|task-notification|INTERRUPT_LOCAL_MAIN|\[定时\]|SPAWN_TWO_FORKS/.test(s)) || "";
const tool = (id, name, input) => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });

function nativeHarness(t, api, release = () => {}) {
  const events = [], wire = [], optionsUsed = [], spawnedEnv = [];
  writeJson(config.stateFile, {});
  const h = new Harness({ hub: new DeviceHub(), bus: { emit: (e) => events.push(e) }, log() {},
    queryFactory: ({ prompt, options }) => {
      optionsUsed.push(options);
      return query({ prompt, options: { ...options, systemPrompt: "Local fixture. Use Agent fork for alarms; write briefs with Write.",
        settingSources: [], agentProgressSummaries: false, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
        spawnClaudeCodeProcess: (o) => {
          spawnedEnv.push({ fork: o.env.CLAUDE_CODE_FORK_SUBAGENT, emitState: o.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS,
            backgroundState: o.env.CLAUDE_CODE_BG_TASKS_REPORT_RUNNING });
          return options.spawnClaudeCodeProcess(o);
        },
        env: { ...options.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-local-only", ANTHROPIC_AUTH_TOKEN: "",
          CLAUDE_CONFIG_DIR: path.join(config.sessions, "tasks-" + Math.random().toString(16).slice(2)),
          CLAUDE_CODE_TMPDIR: path.join(config.root, "native-tmp"), CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" } } });
    } });
  const receive = h.onMainMessage.bind(h);
  h.onMainMessage = (m, main) => {
    wire.push(m);
    if (process.env.SDK_TASK_DEBUG && m.type === "system") console.log("LOCAL TASK", JSON.stringify(m).slice(0, 900));
    receive(m, main);
  };
  h.startMain();
  t.after(async () => {
    release(); clearTimeout(h.restartTimer);
    h.main.intentionalClose = true; h.main.inbox.close(); h.main.q.close();
    await h.main.finished; await api.close();
  });
  const until = async (predicate) => {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("local SDK task did not settle: " + JSON.stringify(wire.slice(-12).map((m) => ({ type: m.type, subtype: m.subtype, state: m.state, status: m.status, result: m.result }))));
      await delay(20);
    }
  };
  return { h, events, wire, optionsUsed, spawnedEnv, until };
}

test("real streaming CLI forks from an alarm, interrupt spares it, and its notification wakes a queued main turn with a brief card", { timeout: 60_000 }, async (t) => {
  const child = deferred(), interrupted = deferred(), notification = deferred();
  let childStep = 0, interruptRequest = false, notificationRequest = false;
  const brief = "data/briefs/2026-10-10/local-fork.json";
  const api = await fakeAnthropic(async (body) => {
    const last = latestInput(body);
    if (forkDirective(body)) {
      if (++childStep === 1) {
        await child.promise;
        return tool("local_write", "Write", { file_path: path.join(config.root, brief), content: JSON.stringify({"v": 1, "name": "\u672c\u5730\u7b80\u62a5", "time": "2026-10-11T07:30:00+08:00", "cards": [{"chip": "2026-10-11", "title": "\u672c\u5730\u5b8c\u6210"}]}) });
      }
      return { content: [{ type: "text", text: "本地简报完成，位置：" + brief }] };
    }
    if (last.includes("USER_DURING_NOTIFICATION")) return { content: [{ type: "text", text: last.includes("SECOND") ? "第二条排队回复" : "第一条排队回复" }] };
    if (last.includes("task-notification")) {
      notificationRequest = true; await notification.promise;
      return { content: [{ type: "text", text: "简报好了：" + brief }] };
    }
    if (last.includes("INTERRUPT_LOCAL_MAIN")) {
      interruptRequest = true; await interrupted.promise; return {};
    }
    if (last.includes("[定时]") && !hasAgentCall(body)) return tool("local_agent", "Agent", { subagent_type: "fork", run_in_background: true,
      description: "本地简报", prompt: "LOCAL_FORK_WORK: write the local brief, then report its path." });
    return { content: [{ type: "text", text: "已安排简报。" }] };
  });
  const { h, events, wire, optionsUsed, spawnedEnv, until } = nativeHarness(t, api, () => { child.resolve(); interrupted.resolve(); notification.resolve(); });
  assert.equal(await runScheduledTask(h, { id: "local-brief", name: "本地简报", prompt: "做本地简报" }), "alarm");
  await until(() => childStep > 0 && h.backgroundTasks().length === 1 && events.some((e) => e.t === "turn_end" && e.text === "已安排简报。") && !h.busy);
  const id = h.backgroundTasks()[0].id;
  assert.equal(optionsUsed[0].perTaskStopAffordance, true);
  assert.equal(optionsUsed[0].env.CLAUDE_CODE_FORK_SUBAGENT, "1");
  assert.deepEqual(spawnedEnv[0], { fork: "1", emitState: "1", backgroundState: "0" });
  const childRequest = api.requests.find(forkDirective);
  assert.ok(childRequest, "fork accepted by the real SDK in open streaming input mode");
  assert.match(JSON.stringify(childRequest.messages), /该出「本地简报」/); // inherited parent history
  await h.send("INTERRUPT_LOCAL_MAIN");
  await until(() => interruptRequest && h.busy);
  await h.interrupt();
  await until(() => !h.busy);
  assert.deepEqual(h.backgroundTasks().map((x) => x.id), [id]);
  assert.equal(wire.some((m) => m.subtype === "task_notification" && m.status === "stopped"), false);
  child.resolve();
  await until(() => notificationRequest && h.busy);
  assert.equal(h.main.active, null);
  assert.ok(events.some((e) => e.t === "status" && e.busy && e.reason === "task_result"));
  await h.send("USER_DURING_NOTIFICATION FIRST");
  await h.send("USER_DURING_NOTIFICATION SECOND");
  assert.equal(h.turnQueue.length, 2);
  assert.equal(api.requests.some((r) => latestInput(r).includes("USER_DURING_NOTIFICATION")), false);
  notification.resolve();
  await until(() => events.some((e) => e.t === "turn_end" && e.text === "第二条排队回复") && !h.busy);
  const ended = events.filter((e) => e.t === "turn_end").map((e) => e.text);
  assert.ok(ended.indexOf("简报好了：" + brief) < ended.indexOf("第一条排队回复"));
  assert.ok(ended.indexOf("第一条排队回复") < ended.indexOf("第二条排队回复"));
  assert.deepEqual(h.backgroundTasks(), []);
  const cards = tailJsonl(config.chatLog, 100).filter((e) => e.role === "card" && e.taskId === id);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].outputs, [brief]);
  assert.equal(cards[0].path, brief);
  assert.equal(cards[0].ok, true);
  assert.ok(fs.existsSync(path.join(config.root, brief)));
  assert.ok(events.some((e) => e.t === "job" && e.phase === "done" && e.taskId === id && e.outputs.includes(brief)));
  assert.ok(tailJsonl(config.chatLog, 100).some((e) => e.role === "user" && e.source === "schedule"));
});

test("real CLI stopTask stops only the selected fork and reports stopped; another fork completes", { timeout: 60_000 }, async (t) => {
  const gates = { A: deferred(), B: deferred() };
  const api = await fakeAnthropic(async (body) => {
    const directive = forkDirective(body);
    if (directive) { await gates[directive.includes("LOCAL_STOP_A") ? "A" : "B"].promise; return {}; }
    const last = latestInput(body);
    if (last.includes("SPAWN_TWO_FORKS") && !hasAgentCall(body)) return { stop_reason: "tool_use", content: ["A", "B"].map((name) => ({ type: "tool_use",
      id: "stop_agent_" + name, name: "Agent", input: { subagent_type: "fork", run_in_background: true, description: "本地任务 " + name, prompt: "LOCAL_STOP_" + name } })) };
    return {};
  });
  const { h, wire, until } = nativeHarness(t, api, () => { gates.A.resolve(); gates.B.resolve(); });
  await h.send("SPAWN_TWO_FORKS");
  await until(() => h.backgroundTasks().length === 2 && !h.busy && api.requests.filter(forkDirective).length === 2);
  const a = h.backgroundTasks().find((x) => x.description.endsWith("A"));
  const b = h.backgroundTasks().find((x) => x.description.endsWith("B"));
  await h.stopTask(a.id);
  await until(() => wire.some((m) => m.subtype === "task_notification" && m.task_id === a.id && m.status === "stopped") && h.backgroundTasks().length === 1);
  assert.equal(h.backgroundTasks()[0].id, b.id);
  await assert.rejects(h.stopTask(a.id), (e) => e.status === 409 && e.message === "任务已经结束");
  await assert.rejects(h.stopTask("nonexistent-local-task"), (e) => e.status === 404);
  gates.B.resolve();
  await until(() => wire.some((m) => m.subtype === "task_notification" && m.task_id === b.id && m.status === "completed") && !h.busy && !h.backgroundTasks().length);
});
