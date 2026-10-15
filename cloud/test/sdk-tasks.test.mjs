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
      return query({ prompt, options: { ...options, systemPrompt: "Local fixture. Use native Agent forks for background work.",
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
