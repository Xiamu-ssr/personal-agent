import "./environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/agent.mjs";
import { ConnectorManager } from "../src/connectors.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { config } from "../src/config.mjs";
import { readJson, writeJson, tailJsonl } from "../src/store.mjs";
import { runScheduledTask } from "../src/scheduler.mjs";
import email from "../connectors/qq-mail/index.mjs";
import { setImmediate as tick } from "node:timers/promises";

// Purely local SDK query stand-in: it exercises lifecycle/queue boundaries without launching the CLI or a model.
function queryFixture(calls) {
  return ({ prompt, options }) => {
    const messages = [], waiters = [];
    let closed = false;
    const q = {
      options, received: [], stopped: [], closed: false, flagSettings: [],
      async applyFlagSettings(settings) { q.flagSettings.push(settings); },
      emit(message) { const waiter = waiters.shift(); waiter ? waiter({ value: message, done: false }) : messages.push(message); },
      close() {
        closed = true; q.closed = true;
        for (const waiter of waiters.splice(0)) waiter({ done: true });
        for (const server of Object.values(options.mcpServers)) server.instance.close().catch(() => {});
      },
      async interrupt() { q.emit({ type: "result", subtype: "success" }); },
      async stopTask(id) { q.stopped.push(id); q.emit({ type: "system", subtype: "task_notification", task_id: id, status: "stopped" }); },
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (messages.length) return { value: messages.shift(), done: false };
        if (closed) return { done: true };
        return new Promise((resolve) => waiters.push(resolve));
      },
    };
    calls.push(q);
    q.emit({ type: "system", subtype: "init", session_id: options.resume || "fictional-main-session" });
    q.inputFinished = (async () => { for await (const message of prompt) q.received.push(message); })();
    return q;
  };
}

async function flush(harness) {
  await tick();
  await harness.dispatchChain;
  await tick();
}
const values = { address: "fixture@qq.test", password: "fictional-harness-password" };
function setup(t) {
  const calls = [], events = [];
  writeJson(config.stateFile, { mainSessionId: "same-fictional-session" });
  const connectors = new ConnectorManager({ definitions: [{ ...email, test: async () => {} }] });
  const harness = new Harness({ hub: new DeviceHub(), bus: { emit: (event) => events.push(event) }, log: () => {}, connectors, queryFactory: queryFixture(calls) });
  harness.startMain();
  t.after(async () => {
    clearTimeout(harness.restartTimer);
    harness.main.intentionalClose = true;
    harness.main.inbox.close();
    harness.main.q.close();
    await harness.main.finished;
    await harness.main.q.inputFinished;
  });
  return { calls, events, harness, connectors };
}

test("active turn finishes; queued next turn uses rebuilt MCP and resumes same session; pending messages survive", async (t) => {
  const { calls, harness, connectors } = setup(t);
  await flush(harness);
  assert.equal("qq-mail" in calls[0].options.mcpServers, false);
  assert.equal(calls[0].options.allowedTools.includes("mcp__connectors__add_account"), true);
  await harness.send("first");
  await flush(harness);
  assert.equal(calls[0].received.length, 1);
  const account = await connectors.addAccount("qq-mail", values);
  await harness.send("second");
  await harness.send("third");
  assert.equal(calls.length, 1, "a config mutation cannot close the query inside a running turn");
  calls[0].emit({ type: "assistant", message: { content: [{ type: "text", text: "first reply" }] } });
  calls[0].emit({ type: "result", subtype: "success" });
  await flush(harness);
  assert.equal(calls[0].closed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.resume, "same-fictional-session");
  assert.equal(calls[1].options.mcpServers["qq-mail"].type, "sdk");
  assert.equal(calls[1].received.length, 1);
  assert.equal(calls[1].received[0].message.content, "second");
  calls[1].emit({ type: "result", subtype: "success" });
  await flush(harness);
  assert.equal(calls[1].received.length, 2);
  assert.equal(calls[1].received[1].message.content, "third");
  calls[1].emit({ type: "result", subtype: "success" });
  await flush(harness);
  const previousServer = calls[1].options.mcpServers["qq-mail"];
  await connectors.updateAccount("qq-mail", account.id, { label: "Changed" });
  await harness.send("after update");
  await flush(harness);
  assert.equal(calls.length, 3);
  assert.notEqual(calls[2].options.mcpServers["qq-mail"].instance, previousServer.instance);
  assert.equal(calls[2].options.resume, "same-fictional-session");
  calls[2].emit({ type: "result", subtype: "success" });
  await flush(harness);
  await connectors.removeAccount("qq-mail", account.id);
  await harness.send("after removal");
  await flush(harness);
  assert.equal(calls.length, 4);
  assert.equal("qq-mail" in calls[3].options.mcpServers, false);
  assert.equal(readJson(config.stateFile, {}).mainSessionId, "same-fictional-session");
});

test("harness hooks enforce secret isolation and each main/isolated query gets distinct SDK transports", async (t) => {
  const { harness } = setup(t);
  const mainOptions = harness.options({ isolated: false, onWrite: () => {} });
  const jobOptions = harness.options({ isolated: true, onWrite: () => {} });
  assert.notEqual(mainOptions.mcpServers.connectors.instance, jobOptions.mcpServers.connectors.instance);
  assert.notEqual(mainOptions.mcpServers.devices.instance, jobOptions.mcpServers.devices.instance);
  assert.equal(JSON.stringify(mainOptions.env).includes(values.password), false);
  const guard = mainOptions.hooks.PreToolUse[0].hooks[0];
  assert.equal((await guard({ tool_name: "Read", tool_input: { file_path: "system/connectors/x/accounts.json" } })).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(await guard({ tool_name: "Read", tool_input: { file_path: "data/example.md" } }), {});
  assert.deepEqual(await mainOptions.hooks.PreToolUse[1].hooks[0]({ tool_name: "Write", tool_input: { file_path: "data/memory/work/example.md" } }), {});
  for (const opts of [mainOptions, jobOptions]) for (const server of Object.values(opts.mcpServers)) await server.instance.close();
});

test("a message arriving after the SDK query ended is dispatched to a new query, not a closed inbox", async (t) => {
  const { calls, harness } = setup(t);
  await flush(harness);
  calls[0].close();
  await flush(harness);
  assert.equal(harness.main.ended, true);
  await harness.send("arrived during reconnect delay");
  await flush(harness);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].received[0].message.content, "arrived during reconnect delay");
  assert.equal(calls[1].options.resume, "same-fictional-session");
});

test("withdrawing the last queued message while compaction restore awaits cannot dispatch an empty queue", async (t) => {
  const { calls, harness, events } = setup(t);
  await flush(harness);
  let release, entered = false;
  const gate = new Promise((r) => { release = r; });
  calls[0].applyFlagSettings = async () => { entered = true; await gate; };
  harness.main.compaction.active = true;
  const sending = harness.send("withdraw while restore waits");
  await tick(); assert.equal(entered, true);
  const id = events.findLast((e) => e.t === "user").id;
  assert.deepEqual(harness.updateQueued(id), { t: "queue_update", id, state: "removed" });
  release(); await sending; await flush(harness);
  assert.equal(harness.busy, false);
  assert.equal(calls[0].received.length, 0);
  assert.equal(harness.turnQueue.length, 0);
  assert.equal(tailJsonl(config.chatLog, 100).some((e) => e.id === id), false);
});

test("main, isolated and subagent env share the model cap and the 167K estimated input trigger", async (t) => {
  const { calls, harness } = setup(t);
  await flush(harness);
  const opts = harness.options({ isolated: true, onWrite: () => {} });
  for (const o of [calls[0].options, opts]) {
    assert.equal(o.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "128000");
    assert.equal(o.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
    assert.equal(o.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "100");
    assert.equal(o.env.CLAUDE_CODE_SUBAGENT_MODEL, config.model);
    assert.ok(o.settings.modelPicker.options.every((row) => row.behavesAs === "claude-haiku-5-5"));
    assert.equal(o.systemPrompt.preset, "claude_code");
  }
  for (const server of Object.values(opts.mcpServers)) await server.instance.close();
  await calls[0].options.hooks.PreCompact[0].hooks[0]();
  assert.deepEqual(calls[0].flagSettings.at(-1), { effortLevel: "low", maxEffortLevel: "low" });
  await calls[0].options.hooks.PostCompact[0].hooks[0]();
  assert.deepEqual(calls[0].flagSettings.at(-1), { effortLevel: config.effort, maxEffortLevel: "max" });
});

test("stuck resumed conversation resets once, replays only a turn without tools, and keeps queued turns/data/state", async (t) => {
  const { calls, harness, events } = setup(t);
  writeJson(config.stateFile, { mainSessionId: "same-fictional-session", unrelated: "keep" });
  await flush(harness);
  await harness.send("继续处理 data/todos.md");
  await harness.send("queued after recovery");
  calls[0].emit({ type: "assistant", message: { content: [{ type: "text", text: "本轮刚确认：待办还有一个供应商报价要核对。" }] } });
  calls[0].emit({ type: "assistant", error: "invalid_request", message: { content: [{ type: "text", text: "Prompt is too long · automatic compaction failed: API Error: exceeded the 32000 output token maximum" }] } });
  calls[0].emit({ type: "result", subtype: "error_during_execution", errors: ["Prompt is too long"] });
  await flush(harness);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.resume, undefined);
  assert.match(calls[1].received[0].message.content, /会话恢复交接/);
  assert.match(calls[1].received[0].message.content, /data\/todos.md/);
  assert.match(calls[1].received[0].message.content, /供应商报价/);
  assert.equal(readJson(config.stateFile, {}).unrelated, "keep");
  assert.equal(tailJsonl(config.chatLog, 100).filter((e) => e.role === "user" && e.text === "继续处理 data/todos.md").length, 1, "automatic replay never appends the same user envelope twice");
  assert.ok(events.some((e) => e.t === "turn_end" && e.text.includes("记忆不受影响")));
  assert.equal(JSON.stringify(events).includes("32000"), false);
  calls[1].emit({ type: "assistant", message: { content: [{ type: "text", text: "recovered reply" }] } });
  calls[1].emit({ type: "result", subtype: "success" });
  await flush(harness);
  assert.equal(readJson(config.stateFile, {}).mainRecovery, undefined);
  assert.equal(calls[1].received[1].message.content, "queued after recovery");
});

test("fallback has a bounded retry and does not repeat a turn that already used tools", async (t) => {
  const { calls, harness } = setup(t);
  await flush(harness);
  await harness.send("a large message");
  for (let i = 0; i < 2; i++) {
    calls[i].emit({ type: "assistant", error: "invalid_request", message: { content: [{ type: "text", text: "Prompt is too long" }] } });
    calls[i].emit({ type: "result", subtype: "error_during_execution" });
    await flush(harness);
  }
  assert.equal(calls.length, 3);
  assert.equal(calls[2].received.length, 0, "no third automatic model turn");
  await harness.send("execute once");
  calls[2].emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "data/todos.md" } }] } });
  calls[2].emit({ type: "system", subtype: "status", compact_result: "failed", compact_error: "output token maximum", status: null });
  calls[2].emit({ type: "result", subtype: "error_during_execution" });
  await flush(harness);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].received.length, 0, "side effects are never automatically replayed");
});

test("ordinary API errors become Chinese without erasing a resumable session", async (t) => {
  const { calls, harness, events } = setup(t);
  await flush(harness);
  await harness.send("hello");
  calls[0].emit({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "API Error: 401 Unauthorized" }] } });
  calls[0].emit({ type: "result", subtype: "error_during_execution" });
  await flush(harness);
  assert.equal(calls.length, 1);
  assert.equal(readJson(config.stateFile, {}).mainSessionId, "same-fictional-session");
  assert.match(events.findLast((e) => e.t === "turn_end").text, /授权/);
  assert.equal(JSON.stringify(events).includes("Unauthorized"), false);
});

test("manual compaction failure opens a fresh session without replaying /compact", async (t) => {
  const { calls, harness, events } = setup(t);
  await flush(harness);
  assert.equal(harness.compactMain(), true);
  await flush(harness);
  assert.equal(calls[0].received[0].message.content, "/compact");
  calls[0].emit({ type: "system", subtype: "status", status: "compacting", compact_output_chars: 0 });
  calls[0].emit({ type: "system", subtype: "status", status: "compacting", compact_output_chars: 12 });
  calls[0].emit({ type: "system", subtype: "local_command_output", content: "Error during compaction: API Error: exceeded the 32000 output token maximum" });
  calls[0].emit({ type: "result", subtype: "success" });
  await flush(harness);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].received.length, 0);
  assert.equal(calls[1].options.resume, undefined);
  assert.equal(JSON.stringify(events).includes("API Error"), false);
  assert.equal(events.filter((e) => e.t === "delta" && e.text.includes("正在整理上下文")).length, 1);
});

test("a normal answer discussing a past API error does not reset the session", async (t) => {
  const { calls, harness } = setup(t);
  await flush(harness);
  await harness.send("Explain that error.");
  calls[0].emit({ type: "assistant", message: { model: config.model, content: [{ type: "text", text: "Prompt is too long 是以前的错误，现在可以继续。" }] } });
  calls[0].emit({ type: "result", subtype: "success" });
  await flush(harness);
  assert.equal(calls.length, 1);
  assert.equal(readJson(config.stateFile, {}).mainSessionId, "same-fictional-session");
});

test("a process ending during a turn releases busy state and reports a Chinese failure", async (t) => {
  const { calls, harness, events } = setup(t);
  await flush(harness);
  await harness.send("hello");
  calls[0].close();
  await flush(harness);
  assert.equal(harness.busy, false);
  assert.match(events.findLast((e) => e.t === "turn_end").text, /模型服务/);
  assert.equal(readJson(config.stateFile, {}).mainSessionId, "same-fictional-session");
});

test("native task-result turn resets stale state, stays busy until idle, and queues users in order", async (t) => {
  const { harness, calls, events } = setup(t), q = calls[0];
  await flush(harness);
  q.emit({ type: "system", subtype: "session_state_changed", state: "requires_action" });
  await flush(harness);
  assert.equal(harness.busy, true);
  assert.notEqual(harness.main.turnOpen, true, "waiting alone does not invent a result-bearing main turn");
  q.emit({ type: "system", subtype: "session_state_changed", state: "idle" });
  await flush(harness);
  assert.equal(harness.busy, false);
  harness.main.failure = { raw: "previous failure" };
  harness.main.active = { input: { message: { content: "old user" } } };
  harness.main.reply = "old reply"; harness.main.toolsUsed = true;
  q.emit({ type: "system", subtype: "task_notification", task_id: "native-fork", status: "completed", summary: "done" });
  q.emit({ type: "system", subtype: "session_state_changed", state: "running" });
  await flush(harness);
  assert.equal(harness.busy, true);
  assert.equal(harness.main.active, null);
  assert.equal(harness.main.failure, null);
  assert.equal(harness.main.reply, "");
  assert.equal(harness.main.toolsUsed, false);
  assert.deepEqual(events.findLast((e) => e.t === "status"), { t: "status", busy: true, reason: "task_result" });
  await harness.send("queued first"); await harness.send("queued second");
  assert.equal(q.received.length, 0);
  q.emit({ type: "assistant", message: { content: [{ type: "text", text: "background result" }] } });
  q.emit({ type: "result", subtype: "success" });
  await flush(harness);
  assert.equal(harness.busy, true, "result is not authoritative idle");
  assert.equal(q.received.length, 0);
  q.emit({ type: "system", subtype: "session_state_changed", state: "idle" });
  await flush(harness);
  assert.equal(q.received[0].message.content, "queued first");
  q.emit({ type: "system", subtype: "session_state_changed", state: "running" });
  q.emit({ type: "system", subtype: "session_state_changed", state: "idle" });
  await flush(harness);
  assert.equal(q.received.length, 1, "idle before result must also wait for the reply to be saved");
  q.emit({ type: "result", subtype: "success" });
  await flush(harness);
  assert.equal(q.received[1].message.content, "queued second");
  assert.ok(tailJsonl(config.chatLog, 100).some((e) => e.role === "assistant" && e.text === "background result"));
});

test("a spontaneous context failure uses recovery without replaying a notification or an old user", async (t) => {
  const { harness, calls, events } = setup(t);
  await flush(harness);
  calls[0].emit({ type: "system", subtype: "session_state_changed", state: "running" });
  await flush(harness);
  calls[0].emit({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "Prompt is too long" });
  calls[0].emit({ type: "result", subtype: "error_during_execution" });
  calls[0].emit({ type: "system", subtype: "session_state_changed", state: "idle" });
  await flush(harness);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.resume, undefined);
  assert.equal(calls[1].received.length, 0);
  assert.ok(events.some((e) => e.t === "turn_end" && e.text.includes("记忆不受影响")));
  await harness.send("continue after native failure");
  await flush(harness);
  assert.equal(calls[1].received.length, 1);
  assert.match(calls[1].received[0].message.content, /会话恢复交接/);
});

test("background level replaces activity, stop targets one task, and process end clears activity", async (t) => {
  const { harness, calls, events } = setup(t), q = calls[0];
  const a = { task_id: "task-a", description: "A", task_type: "local_agent", run_id: "001" };
  const b = { task_id: "task-b", description: "B", task_type: "local_agent" };
  const shell = { task_id: "shell-1", description: "echo", task_type: "local_bash" };
  q.emit({ type: "system", subtype: "background_tasks_changed", tasks: [a, b, shell, { task_id: "ambient", ambient: true }] });
  q.emit({ type: "system", subtype: "task_started", ...a, is_backgrounded: true });
  q.emit({ type: "system", subtype: "task_progress", task_id: "task-a", description: "Running step" });
  q.emit({ type: "system", subtype: "task_notification", task_id: "shell-1", status: "completed", summary: "done" });
  await flush(harness);
  assert.deepEqual(harness.backgroundTasks().map((x) => [x.id, x.description]), [["task-a", "A"], ["task-b", "B"]]);
  assert.ok(!events.some((e) => e.t === "task" && e.id === "shell-1"), "background shell commands are not tasks");
  const startedAt = harness.backgroundTasks()[0].startedAt;
  await harness.stopTask("task-a");
  await flush(harness);
  assert.deepEqual(q.stopped, ["task-a"]);
  await assert.rejects(harness.stopTask("task-a"), (e) => e.status === 409);
  await assert.rejects(harness.stopTask("unknown"), (e) => e.status === 404);
  await assert.rejects(harness.stopTask(undefined), (e) => e.status === 400);
  q.emit({ type: "system", subtype: "background_tasks_changed", tasks: [b] });
  q.emit({ type: "system", subtype: "task_started", ...a, is_backgrounded: true }); // late edge cannot resurrect A
  await flush(harness);
  assert.deepEqual(harness.backgroundTasks().map((x) => x.id), ["task-b"]);
  assert.ok(startedAt > 0);
  assert.ok(events.some((e) => e.t === "task" && e.phase === "notification" && e.id === "task-a" && e.status === "stopped"));
  const stop = q.stopTask;
  q.stopTask = async () => { throw new Error("fictional SDK control failure"); };
  await assert.rejects(harness.stopTask("task-b"), (e) => e.status === 502 && /停止任务失败/.test(e.message));
  assert.equal(harness.main.tasks.records.get("task-b").stopping, false, "failed control permits retry");
  q.stopTask = stop;
  q.close(); await flush(harness);
  assert.deepEqual(harness.backgroundTasks(), []);
  assert.deepEqual(events.findLast((e) => e.t === "task").tasks, []);
});

test("an alarm joins the same queue, retains its source, and native turn during restore cannot interleave it", async (t) => {
  const { harness, calls } = setup(t), q = calls[0];
  await flush(harness);
  let raced = false;
  harness.main.compaction.restore = async () => {
    if (raced) return;
    raced = true; q.emit({ type: "system", subtype: "session_state_changed", state: "running" });
    await tick();
  };
  assert.equal(await runScheduledTask(harness, { id: "brief", name: "报价简报", prompt: "按最近的报价做简报" }), "alarm");
  await flush(harness);
  assert.equal(q.received.length, 0);
  assert.equal(harness.turnQueue.length, 1);
  q.emit({ type: "result", subtype: "success" });
  q.emit({ type: "system", subtype: "session_state_changed", state: "idle" });
  await flush(harness);
  assert.equal(q.received[0].message.content, "按最近的报价做简报");
  assert.ok(tailJsonl(config.chatLog, 100).some((e) => e.role === "user" && e.source === "schedule" && e.text.includes("按最近的报价")));
});
