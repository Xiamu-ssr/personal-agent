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
      options, received: [], closed: false,
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
