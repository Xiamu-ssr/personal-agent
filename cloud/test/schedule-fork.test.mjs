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

const tool = (id, name, input) => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
const textReply = (text) => ({ content: [{ type: "text", text }] });
const blocks = (m) => Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
const forkRequest = (body) => body.messages.some((m) => blocks(m).some((b) => b.type === "text" && b.text.includes("You are a worker fork.")));
const resultFor = (body, id) => body.messages.flatMap(blocks).findLast((b) => b.type === "tool_result" && b.tool_use_id === id);
const hasInput = (body, text) => body.messages.some((m) => m.role === "user" && blocks(m).some((b) => b.type === "text" && b.text.includes(text)));
const shellQuote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";

function nativeHarness(t, api, release = () => {}) {
  const events = [], wire = [], logs = [], hooks = [];
  writeJson(config.stateFile, {});
  const h = new Harness({ hub: new DeviceHub(), bus: { emit: (e) => events.push(e) }, log: (...args) => logs.push(args.join(" ")),
    queryFactory: ({ prompt, options }) => query({ prompt, options: { ...options,
      systemPrompt: "Local fixture. Make a short brief, use Agent fork in the background.", settingSources: [], agentProgressSummaries: false,
      permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      hooks: { ...options.hooks, PreToolUse: [...options.hooks.PreToolUse, { hooks: [async (input) => {
        hooks.push({ name: input.tool_name, id: input.tool_use_id, agentId: input.agent_id, input: input.tool_input }); return {};
      }] }] },
      env: { ...options.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-local-only", ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_CONFIG_DIR: path.join(config.sessions, "schedule-fork-" + Math.random().toString(16).slice(2)),
        CLAUDE_CODE_TMPDIR: path.join(config.root, "native-tmp"), CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" } } }) });
  const receive = h.onMainMessage.bind(h);
  h.onMainMessage = (m, main) => { wire.push(m); receive(m, main); };
  h.startMain();
  t.after(async () => {
    release(); clearTimeout(h.restartTimer);
    h.main.intentionalClose = true; h.main.inbox.close(); h.main.q.close();
    await h.main.finished; await api.close();
  });
  const until = async (predicate) => {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("local schedule fixture did not settle: " + JSON.stringify({ logs, hooks, wire: wire.slice(-10).map((m) => ({ type: m.type, subtype: m.subtype, state: m.state, status: m.status, result: m.result })), toolRequests: wire.filter((m) => m.type === "assistant").flatMap((m) => m.message?.content || []).filter((b) => b.type === "tool_use"), toolResults: api.requests.at(-1)?.messages.flatMap(blocks).filter((b) => b.type === "tool_result") }));
      await delay(20);
    }
  };
  return { h, events, wire, logs, hooks, until };
}

test("schedule guard denies main Bash in Chinese, permits fork's Bash/Write, and native completion wakes main with a card", { timeout: 45_000 }, async (t) => {
  const blockedFile = path.join(config.root, "schedule-main-must-not-run.txt");
  const childFile = path.join(config.root, "schedule-child-bash.txt");
  const notificationFile = path.join(config.root, "schedule-notification-bash.txt");
  const brief = "data/briefs/2026-10-11/guard-brief.html";
  let rootStep = 0, childStep = 0, releaseChild;
  const childGate = new Promise((r) => { releaseChild = r; });
  const api = await fakeAnthropic(async (body) => {
    if (forkRequest(body)) {
      if (++childStep === 1) {
        await childGate;
        return tool("guard_child_bash", "Bash", { command: `printf 'fork-ok' > ${shellQuote(childFile)}` });
      }
      if (childStep === 2) {
        assert.ok(resultFor(body, "guard_child_bash"));
        assert.notEqual(resultFor(body, "guard_child_bash").is_error, true);
        return tool("guard_child_write", "Write", { file_path: path.join(config.root, brief), content: "<!doctype html><title>守卫简报</title><p>完成</p>" });
      }
      return textReply("守卫简报完成：" + brief);
    }
    if (hasInput(body, "task-notification")) {
      if (!resultFor(body, "guard_notification_bash")) return tool("guard_notification_bash", "Bash", { command: `printf 'notification-ok' > ${shellQuote(notificationFile)}` });
      return textReply("简报已完成：" + brief);
    }
    if (++rootStep === 1) return tool("guard_main_bash", "Bash", { command: `printf 'must-not-run' > ${shellQuote(blockedFile)}` });
    if (rootStep === 2) {
      const denied = resultFor(body, "guard_main_bash");
      assert.equal(denied?.is_error, true);
      assert.match(JSON.stringify(denied.content), /定时简报请先用 Agent/);
      return tool("guard_main_agent", "Agent", { subagent_type: "fork", run_in_background: true, description: "守卫简报", prompt: "LOCAL_GUARD_FORK: use Bash and Write to produce the brief." });
    }
    return textReply("已派到后台。");
  });
  const { h, events, wire, logs, hooks, until } = nativeHarness(t, api, releaseChild);
  await runScheduledTask(h, { id: "guard-brief", name: "守卫简报", prompt: "用本地假数据做简报" });
  await until(() => childStep > 0 && h.backgroundTasks().length === 1 && !h.busy);
  const id = h.backgroundTasks()[0].id;
  assert.equal(fs.existsSync(blockedFile), false, "denied parent command never executed");
  assert.equal(hooks.find((x) => x.id === "guard_main_agent")?.name, "Agent");
  assert.equal(hooks.find((x) => x.id === "guard_main_agent")?.input.run_in_background, undefined, "fork-gated CLI strips the background parameter before the hook");
  assert.ok(logs.some((s) => s === `[schedule] fork dispatched task_id=${id} tool_use_id=guard_main_agent`));
  releaseChild();
  await until(() => events.some((e) => e.t === "turn_end" && e.text === "简报已完成：" + brief) && !h.busy);
  assert.equal(fs.readFileSync(childFile, "utf8"), "fork-ok");
  assert.equal(fs.readFileSync(notificationFile, "utf8"), "notification-ok", "task_result main turn is unrestricted");
  assert.ok(fs.existsSync(path.join(config.root, brief)));
  const childHooks = hooks.filter((x) => ["guard_child_bash", "guard_child_write"].includes(x.id));
  assert.equal(childHooks.length, 2);
  assert.ok(childHooks.every((x) => x.agentId === id));
  assert.ok(wire.some((m) => m.subtype === "task_notification" && m.task_id === id && m.status === "completed"));
  assert.ok(events.some((e) => e.t === "status" && e.busy && e.reason === "task_result"));
  assert.equal(events.filter((e) => e.t === "job" && e.phase === "done" && e.taskId === id).length, 1);
  assert.deepEqual(tailJsonl(config.chatLog, 100).findLast((e) => e.role === "card" && e.taskId === id)?.outputs, [brief]);
  assert.equal(logs.some((s) => s === "[schedule] fork guard fail-open"), false);
});

test("three denied schedule calls fail open on the fourth; the next schedule resets the guard", { timeout: 45_000 }, async (t) => {
  const commandFiles = Array.from({ length: 4 }, (_, n) => path.join(config.root, `schedule-denial-${n + 1}.txt`));
  let step = 0;
  const api = await fakeAnthropic((body) => {
    step++;
    if (step > 1 && step <= 4) {
      const denied = resultFor(body, "schedule_denied_" + (step - 1));
      assert.equal(denied?.is_error, true);
      assert.match(JSON.stringify(denied.content), /定时简报请先用 Agent/);
    }
    if (step <= 4) return tool("schedule_denied_" + step, "Bash", { command: `printf 'fallback-ok' > ${shellQuote(commandFiles[step - 1])}` });
    return textReply("fail-open 原路径完成");
  });
  const { h, events, logs, until } = nativeHarness(t, api);
  await runScheduledTask(h, { id: "fail-open", prompt: "LOCAL_FAIL_OPEN" });
  await until(() => events.some((e) => e.t === "turn_end" && e.text === "fail-open 原路径完成") && !h.busy);
  for (const file of commandFiles.slice(0, 3)) assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(commandFiles[3], "utf8"), "fallback-ok");
  assert.equal(h.main.scheduleFork.denials, 3);
  assert.equal(h.main.scheduleFork.failOpen, true);
  assert.equal(logs.filter((s) => s === "[schedule] fork guard fail-open").length, 1);
  const count = events.filter((e) => e.t === "turn_end").length;
  await runScheduledTask(h, { id: "next-alarm", prompt: "LOCAL_NEXT_ALARM" });
  assert.equal(h.main.scheduleFork.denials, 0);
  assert.equal(h.main.scheduleFork.failOpen, false);
  assert.equal(h.main.scheduleFork.dispatched, false);
  await until(() => events.filter((e) => e.t === "turn_end").length > count && !h.busy);
});

test("user main Bash executes without the schedule guard", { timeout: 45_000 }, async (t) => {
  const file = path.join(config.root, "user-bash-unrestricted.txt");
  const api = await fakeAnthropic((body) => resultFor(body, "user_main_bash") ? textReply("用户命令完成") :
    tool("user_main_bash", "Bash", { command: `printf 'user-ok' > ${shellQuote(file)}` }));
  const { h, events, logs, until } = nativeHarness(t, api);
  await h.send("LOCAL_USER_BASH");
  await until(() => events.some((e) => e.t === "turn_end" && e.text === "用户命令完成") && !h.busy);
  assert.equal(fs.readFileSync(file, "utf8"), "user-ok");
  assert.equal(h.main.reason, "user");
  assert.equal(logs.some((s) => s.startsWith("[schedule]")), false);
});

test("guard validates exact fork/background values, excludes child and isolated tools, and resets every turn", async () => {
  const h = new Harness({ hub: new DeviceHub(), bus: { emit() {} }, log() {} });
  const main = {}; h.main = main;
  const bash = { tool_name: "Bash", tool_input: { command: "printf local" } };
  for (const input of [bash,
    { tool_name: "Agent", tool_input: { subagent_type: "general-purpose", run_in_background: true } },
    { tool_name: "Agent", tool_input: { subagent_type: "fork" } },
    { tool_name: "Agent", tool_input: { subagent_type: "fork", run_in_background: false } },
    { tool_name: "Agent", tool_input: { subagent_type: "fork", run_in_background: "true" } },
    { tool_name: "TaskCreate", tool_input: { subagent_type: "fork", run_in_background: true } }]) {
    h.beginMainTurn(main, null, "schedule");
    assert.equal(h.checkScheduleFork(input).hookSpecificOutput.permissionDecision, "deny");
    assert.deepEqual(h.checkScheduleFork({ ...input, agent_id: "child" }), {});
    assert.equal(main.scheduleFork.denials, 1, "child calls never consume the fail-open count");
  }
  for (const name of ["Agent", "Task"]) {
    h.beginMainTurn(main, null, "schedule");
    assert.deepEqual(h.checkScheduleFork({ tool_name: name, tool_input: { subagent_type: "fork", run_in_background: true } }), {});
    assert.equal(main.scheduleFork.dispatched, true);
    assert.deepEqual(h.checkScheduleFork(bash), {});
  }
  h.beginMainTurn(main, null, "schedule");
  h.onMainMessage({ type: "assistant", message: { content: [{ type: "tool_use", id: "original-background-fork", name: "Agent",
    input: { subagent_type: "fork", run_in_background: true } }] } });
  const parsed = { tool_name: "Agent", tool_use_id: "original-background-fork", tool_input: { subagent_type: "fork" } };
  assert.equal(h.checkScheduleFork({ ...parsed, tool_use_id: "other-tool-id" }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(h.checkScheduleFork({ ...parsed, tool_input: { subagent_type: "fork", run_in_background: false } }).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(h.checkScheduleFork(parsed), {}, "only this exact raw background request may use the normalized hook shape");
  for (const reason of ["user", "task_result"]) {
    h.beginMainTurn(main, null, reason);
    assert.deepEqual(h.checkScheduleFork(bash), {});
    assert.deepEqual(main.scheduleFork, { dispatched: false, denials: 0, failOpen: false, logged: false, requestedForks: new Set() });
  }
  h.beginMainTurn(main, null, "schedule");
  const isolated = h.options({ isolated: true, onWrite() {} });
  try {
    for (const matcher of isolated.hooks.PreToolUse) for (const hook of matcher.hooks) assert.deepEqual(await hook(bash), {});
    assert.equal(main.scheduleFork.denials, 0);
  } finally { for (const server of Object.values(isolated.mcpServers)) await server.instance.close(); }
});
