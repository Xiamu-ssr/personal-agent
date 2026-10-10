import "./environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/agent.mjs";
import { ConnectorManager } from "../src/connectors.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { config } from "../src/config.mjs";
import { readJson, writeJson } from "../src/store.mjs";
import email from "../connectors/email/index.mjs";
import { setImmediate as tick } from "node:timers/promises";

// Purely local SDK query stand-in: it exercises lifecycle/queue boundaries without launching the CLI or a model.
function queryFixture(calls) {
  return ({ prompt, options }) => {
    const messages = [], waiters = [];
    let closed = false;
    const q = {
      options, received: [], closed: false, flagSettings: [],
      async applyFlagSettings(settings) { q.flagSettings.push(settings); },
      emit(message) { const waiter = waiters.shift(); waiter ? waiter({ value: message, done: false }) : messages.push(message); },
      close() {
        closed = true; q.closed = true;
        for (const waiter of waiters.splice(0)) waiter({ done: true });
        for (const server of Object.values(options.mcpServers)) server.instance.close().catch(() => {});
      },
      async interrupt() { q.emit({ type: "result", subtype: "success" }); },
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
const values = { preset: "qq", address: "fixture@qq.test", password: "fictional-harness-password" };
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
  assert.equal("email" in calls[0].options.mcpServers, false);
  assert.equal(calls[0].options.allowedTools.includes("mcp__connectors__add_account"), true);
  await harness.send("first");
  await flush(harness);
  assert.equal(calls[0].received.length, 1);
  const account = await connectors.addAccount("email", values);
  await harness.send("second");
  await harness.send("third");
  assert.equal(calls.length, 1, "a config mutation cannot close the query inside a running turn");
  calls[0].emit({ type: "assistant", message: { content: [{ type: "text", text: "first reply" }] } });
  calls[0].emit({ type: "result", subtype: "success" });
  await flush(harness);
  assert.equal(calls[0].closed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.resume, "same-fictional-session");
  assert.equal(calls[1].options.mcpServers.email.type, "sdk");
  assert.equal(calls[1].received.length, 1);
  assert.equal(calls[1].received[0].message.content, "second");
  calls[1].emit({ type: "result", subtype: "success" });
  await flush(harness);
  assert.equal(calls[1].received.length, 2);
  assert.equal(calls[1].received[1].message.content, "third");
  calls[1].emit({ type: "result", subtype: "success" });
  await flush(harness);
  const previousServer = calls[1].options.mcpServers.email;
  await connectors.updateAccount("email", account.id, { label: "Changed" });
  await harness.send("after update");
  await flush(harness);
  assert.equal(calls.length, 3);
  assert.notEqual(calls[2].options.mcpServers.email.instance, previousServer.instance);
  assert.equal(calls[2].options.resume, "same-fictional-session");
  calls[2].emit({ type: "result", subtype: "success" });
  await flush(harness);
  await connectors.removeAccount("email", account.id);
  await harness.send("after removal");
  await flush(harness);
  assert.equal(calls.length, 4);
  assert.equal("email" in calls[3].options.mcpServers, false);
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

test("main, isolated and subagent env share the model cap and the 95K estimated input trigger", async (t) => {
  const { calls, harness } = setup(t);
  await flush(harness);
  const opts = harness.options({ isolated: true, onWrite: () => {} });
  for (const o of [calls[0].options, opts]) {
    assert.equal(o.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "128000");
    assert.equal(o.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "128000");
    assert.equal(o.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "100");
    assert.equal(o.env.CLAUDE_CODE_SUBAGENT_MODEL, config.model);
    assert.deepEqual(o.settings.modelOverrides, { "claude-haiku-5-5": config.model });
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
  assert.match(calls[0].received[0].message.content, /^\/compact .*1500 tokens/);
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
