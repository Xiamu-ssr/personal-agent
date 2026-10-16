import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { ConnectorManager } from "../src/connectors.mjs";
import { config } from "../src/config.mjs";
import { Providers } from "../src/providers.mjs";
import { putAppSettings, readAppSettings } from "../src/app-settings.mjs";
import { writeJson } from "../src/store.mjs";
import { fakeAnthropic } from "./fake-anthropic.mjs";
import { isFork, hasInput, resultFor, toolReply, textReply } from "./native-fixture.mjs";

test("real SDK uses basic custom Messages auth for resumed main, feed and summaries; a busy service switch waits for idle", { timeout: 35_000 }, async () => {
  const output = fs.mkdtempSync(path.join(testRoot, "providers-sdk-"));
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/verify-v081-providers.mjs", import.meta.url)), "--output", output], { timeout: 30_000 });
  const value = JSON.parse(stdout.trim());
  assert.equal(value.ok, true); assert.equal(value.resumedSameSession, true); assert.equal(value.deferredUntilIdle, true); assert.equal(value.contextWindow, 200000);
  for (const channel of ["main", "feed", "summary"]) {
    const rows = value.requests.filter((r) => r.channel === channel); assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.model === "fixture-basic-v1" && r.auth === "Bearer" && r.thinking === null && r.output_config === null));
    for (const r of rows) assert.doesNotMatch(r.beta || "", /context-1m|interleaved-thinking|tool-search|advanced-tool/);
  }
  assert.equal(value.requests[0].auth, "x-api-key + Bearer"); assert.equal(value.chat.filter((m) => m.role === "assistant").length, 2);
});

test("changing provider preserves a running native fork's original service while new main and forks use the new service", { timeout: 30_000 }, async (t) => {
  let release, entered = false, oldContinued = false, newFork = false, failure;
  const gate = new Promise((resolve) => { release = resolve; }), wire = [], optionsUsed = [];
  const file = path.join(config.root, "provider-fork.txt"); fs.writeFileSync(file, "local fixture");
  const apiA = await fakeAnthropic(async (body, _i, { headers }) => {
    try {
      if (body.max_tokens === 8) return {};
      assert.equal(body.model, "custom-original"); assert.equal(headers.authorization, "Bearer fake-original-provider-key");
      assert.ok(body.messages.every((m) => ["user", "assistant"].includes(m.role)));
      if (isFork(body)) {
        if (!resultFor(body, "old_child_read")) { entered = true; await gate; return toolReply("old_child_read", "Read", { file_path: file }); }
        oldContinued = true; return textReply("OLD_FORK_RESULT");
      }
      if (!resultFor(body, "old_spawn")) return toolReply("old_spawn", "Agent", { subagent_type: "fork", run_in_background: true, description: "原服务任务", prompt: "V081_PROVIDER_OLD_FORK" });
      if (!resultFor(body, "old_say")) return toolReply("old_say", "mcp__doudou__say", { text: "已经开始原服务任务。" });
      return textReply(" ");
    } catch (e) { failure = e; return { error: "original provider fixture failed" }; }
  });
  const apiB = await fakeAnthropic((body, _i, { headers }) => {
    try {
      if (body.max_tokens === 8) return {};
      assert.equal(body.model, "custom-current"); assert.equal(headers.authorization, "Bearer fake-current-provider-key");
      assert.ok(body.messages.every((m) => ["user", "assistant"].includes(m.role)));
      assert.equal(body.thinking, undefined); assert.equal(body.output_config, undefined);
      if (isFork(body)) { newFork = true; return textReply("NEW_FORK_RESULT"); }
      assert.ok(hasInput(body, "V081_PROVIDER_OLD_MAIN"));
      if (hasInput(body, "V081_PROVIDER_NEW_MAIN") && !resultFor(body, "new_spawn")) return toolReply("new_spawn", "Agent", { subagent_type: "fork", run_in_background: true, description: "新服务任务", prompt: "V081_PROVIDER_NEW_FORK" });
      if (!resultFor(body, "new_say")) return toolReply("new_say", "mcp__doudou__say", { text: "已经使用新服务。" });
      return textReply(" ");
    } catch (e) { failure = e; return { error: "new provider fixture failed" }; }
  });
  const connectors = new ConnectorManager(), providers = new Providers({ root: config.root, connectors, selected: () => readAppSettings(config.root).model });
  const make = (name, baseUrl, apiKey, id) => providers.create({ name, baseUrl, apiKey, models: [{ id, name }] });
  const a = await make("原服务", apiA.url, "fake-original-provider-key", "custom-original"), b = await make("新服务", apiB.url, "fake-current-provider-key", "custom-current");
  putAppSettings(config.root, { model: { provider: a.id, id: a.models[0].id }, permissionMode: "bypassPermissions" }); writeJson(config.stateFile, {});
  const h = new Harness({ hub: new DeviceHub(), connectors, bus: { emit() {} }, log() {}, queryFactory: ({ prompt, options }) => {
    optionsUsed.push(options);
    return query({ prompt, options: { ...options, agentProgressSummaries: false, settingSources: [], env: { ...options.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" } } });
  } });
  const receive = h.onMainMessage.bind(h); h.onMainMessage = (m, main) => { wire.push(m); receive(m, main); };
  t.after(async () => { release(); await h.close(); await apiA.close(); await apiB.close(); }); h.startMain();
  const until = async (predicate) => { const end = Date.now() + 20_000; while (!predicate()) { if (failure) throw failure; if (Date.now() > end) throw new Error("provider fork fixture timed out"); await delay(10); } };
  await h.send("V081_PROVIDER_OLD_MAIN"); await until(() => entered && !h.busy && h.backgroundTasks().length === 1);
  const old = h.main, sessionId = old.sessionId, id = h.backgroundTasks()[0].id;
  putAppSettings(config.root, { model: { provider: b.id, id: b.models[0].id } }); await h.settingsChanged();
  assert.equal(h.retired.has(old), true); assert.equal(old.intentionalClose, undefined); assert.equal(optionsUsed.at(-1).resume, sessionId);
  await h.send("V081_PROVIDER_NEW_MAIN"); await until(() => newFork && !h.busy);
  assert.equal(oldContinued, false, "the old child is still in its original API request");
  release(); await until(() => oldContinued && h.history.get(id).status === "done" && !h.retired.size && !h.busy);
  assert.equal(h.main.sessionId, sessionId); assert.equal(h.history.get(id).status, "done");
  assert.ok(wire.some((m) => m.subtype === "task_notification" && m.task_id === id && m.status === "completed"));
  if (failure) throw failure;
});

test("custom unknown and Claude-shaped ids stay verbatim with basic parameters when setModel switches the live query", { timeout: 20_000 }, async (t) => {
  const ids = ["vendor/basic-messages-v1", "anthropic/claude-opus-5.5"], optionsUsed = []; let selected = ids[0], failure;
  const api = await fakeAnthropic((body, _i, { headers }) => {
    try {
      if (body.max_tokens === 8) return {};
      assert.equal(body.model, selected); assert.equal(body.thinking, undefined); assert.equal(body.output_config, undefined);
      assert.equal(body.max_tokens, 8192); assert.equal(headers["anthropic-beta"], "claude-code-20250219");
      assert.ok(body.messages.every((m) => ["user", "assistant"].includes(m.role)));
      const id = "shape_say_" + ids.indexOf(selected);
      return resultFor(body, id) ? textReply(" ") : toolReply(id, "mcp__doudou__say", { text: "模型参数验证 " + selected });
    } catch (e) { failure = e; return { error: "custom model shape fixture failed" }; }
  });
  const connectors = new ConnectorManager(), providers = new Providers({ root: config.root, connectors, selected: () => readAppSettings(config.root).model });
  const p = await providers.create({ name: "基础模型服务", baseUrl: api.url, apiKey: "fake-shape-provider-key", models: ids.map((id, i) => ({ id, name: "模型" + i })) });
  putAppSettings(config.root, { model: { provider: p.id, id: selected }, permissionMode: "bypassPermissions" }); writeJson(config.stateFile, {});
  const h = new Harness({ hub: new DeviceHub(), connectors, bus: { emit() {} }, log() {}, queryFactory: ({ prompt, options }) => {
    optionsUsed.push(options); return query({ prompt, options: { ...options, settingSources: [], agentProgressSummaries: false, env: { ...options.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" } } });
  } }); t.after(async () => { await h.close(); await api.close(); }); h.startMain();
  for (const id of ids) {
    selected = id; putAppSettings(config.root, { model: { provider: p.id, id } }); await h.settingsChanged(); await h.send("V081_MODEL_SHAPE " + id);
    const end = Date.now() + 10_000; while (h.busy) { if (failure) throw failure; if (Date.now() > end) throw new Error("model shape fixture timed out"); await delay(10); }
  }
  assert.equal(optionsUsed.length, 1); if (failure) throw failure;
});
