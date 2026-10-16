import "./environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { ConnectorManager } from "../src/connectors.mjs";
import { Providers } from "../src/providers.mjs";
import { putAppSettings, readAppSettings } from "../src/app-settings.mjs";
import { config } from "../src/config.mjs";
import { queryFixture } from "./query-fixture.mjs";

test("key and model-list edits reopen idle main with its session, preserve live background credentials and strip inherited auth", async (t) => {
  const calls = [], connectors = new ConnectorManager(), oldKey = "fake-original-key-1111", newKey = "fake-rotated-key-2222";
  const providers = new Providers({ root: config.root, connectors, selected: () => readAppSettings(config.root).model, probe: async () => ({ ok: true, ms: 1 }) });
  const p = await providers.create({ name: "本地服务", baseUrl: "https://models.example.test", apiKey: oldKey, models: [{ id: "basic-a", name: "模型一" }] });
  putAppSettings(config.root, { model: { provider: p.id, id: "basic-a" } });
  const h = new Harness({ connectors, hub: new DeviceHub(), bus: { emit() {} }, log() {}, queryFactory: queryFixture(calls) }); h.startMain(); t.after(() => h.close());
  const flush = async () => { await tick(); await h.inputChain; await tick(); };
  await flush(); const sessionId = h.main.sessionId;
  await h.send("正在处理"); const running = h.runIsolated("动态", "[动态] 测试环境"); await flush();
  await providers.patch(p.id, { apiKey: newKey }); await h.settingsChanged();
  assert.equal(calls.length, 2); assert.equal(calls[0].closed, false); assert.equal(calls[1].options.env.ANTHROPIC_AUTH_TOKEN, oldKey);
  calls[0].emit({ type: "result", subtype: "success" }); await flush();
  assert.equal(calls.length, 3); assert.equal(calls[2].options.resume, sessionId);
  assert.equal(calls[2].options.env.ANTHROPIC_AUTH_TOKEN, newKey); assert.equal(calls[1].closed, false); assert.deepEqual(calls[1].flagSettings, []);
  calls[1].emit({ type: "result", subtype: "success" }); await running;
  const second = { id: "basic-b", name: "模型二" }; await providers.patch(p.id, { models: [...p.models, second] }); await h.settingsChanged();
  assert.equal(calls.length, 4); assert.equal(calls[3].options.resume, sessionId); assert.ok(calls[3].options.settings.availableModels.includes(second.id));
  putAppSettings(config.root, { model: { provider: p.id, id: second.id } }); await h.settingsChanged();
  assert.equal(calls.length, 4); assert.equal(calls[3].model, second.id);
  const child = calls[3].options.spawnClaudeCodeProcess({ command: process.execPath, cwd: config.root, args: ["-e", 'process.stdout.write(JSON.stringify({hasApiKey:"ANTHROPIC_API_KEY" in process.env,hasOldHeaders:"ANTHROPIC_CUSTOM_HEADERS" in process.env,correctToken:process.env.ANTHROPIC_AUTH_TOKEN==="fake-rotated-key-2222",proxy:process.env.HTTPS_PROXY}))'],
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "fake-inherited-key", ANTHROPIC_AUTH_TOKEN: "fake-inherited-token", ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer fake-inherited-header", HTTPS_PROXY: "http://127.0.0.1:18901" } });
  let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); assert.deepEqual(await once(child, "close"), [0, null]);
  assert.deepEqual(JSON.parse(output), { hasApiKey: false, hasOldHeaders: false, correctToken: true, proxy: "http://127.0.0.1:18901" });
});
