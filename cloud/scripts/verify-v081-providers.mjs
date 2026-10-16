import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const output = process.argv.includes("--output") ? process.argv[process.argv.indexOf("--output") + 1] : "/tmp/v081-cloud-demo/providers";
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync("/tmp/v081-providers-root-");
Object.assign(process.env, { AGENT_ROOT: root, AGENT_TOKEN: "fake-provider-demo-token", AGENT_ACTIVITY_SUMMARIES: "0", AGENT_BROWSER_SERVICE: "", NO_PROXY: "127.0.0.1,localhost", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" });
const [{ query }, { Harness }, { DeviceHub }, { startServer }, { Content }, { Schedules }, { migrateV08 }, { migrateV081 }, { CODE }, { putAppSettings }, { activitySummary }, { fakeAnthropic }, { hasInput, resultFor, textReply, toolReply }] = await Promise.all([
  import("@anthropic-ai/claude-agent-sdk"), import("../src/agent.mjs"), import("../src/devices.mjs"), import("../src/server.mjs"), import("../src/content.mjs"), import("../src/scheduler.mjs"), import("../src/migrate-v08.mjs"), import("../src/migrate-v081.mjs"), import("../src/config.mjs"), import("../src/app-settings.mjs"), import("../src/activity-summary.mjs"), import("../test/fake-anthropic.mjs"), import("../test/native-fixture.mjs"),
]);
const key = "fake-custom-provider-2468", model = "fixture-basic-v1", events = [], logs = [], requests = [], optionsUsed = [], listeners = new Set();
const bus = { on: (fn) => listeners.add(fn), emit: (event) => { events.push(event); for (const fn of listeners) fn(event); } };
let release, entered = false, failure, h, server, wireContextWindow;
const gate = new Promise((resolve) => { release = resolve; });
const file = path.join(root, "workspace/context.txt"), post = "data/feed/2026-10-16/1000-自定义服务.md";
const builtin = await fakeAnthropic(async (body) => {
  if (!resultFor(body, "builtin_read")) { entered = true; await gate; return toolReply("builtin_read", "Read", { file_path: file }); }
  if (!resultFor(body, "builtin_say")) return toolReply("builtin_say", "mcp__doudou__say", { text: "原来的上下文已经记下。" });
  return textReply(" ");
});
const api = await fakeAnthropic((body, _i, { headers }) => {
  try {
    const channel = body.max_tokens === 8 ? "probe" : body.max_tokens === 1024 ? "summary" : hasInput(body, "[动态]") ? "feed" : "main";
    assert.equal(body.model, model); assert.equal(body.thinking, undefined); assert.equal(body.output_config, undefined); assert.equal(body.context_management, undefined);
    assert.ok(body.messages.every((m) => ["user", "assistant"].includes(m.role)));
    assert.ok((body.tools || []).every((tool) => !tool.type && !tool.defer_loading && tool.input_schema));
    assert.equal(headers.authorization, "Bearer " + key); assert.equal(headers["anthropic-version"], "2023-06-01");
    if (channel === "probe") assert.equal(headers["x-api-key"], key); else assert.equal(headers["x-api-key"], undefined);
    assert.doesNotMatch(headers["anthropic-beta"] || "", /context-1m|interleaved-thinking|tool-search|advanced-tool/);
    requests.push({ channel, model: body.model, auth: channel === "probe" ? "x-api-key + Bearer" : "Bearer", keyHint: "2468", max_tokens: body.max_tokens, thinking: body.thinking ?? null, output_config: body.output_config ?? null, beta: headers["anthropic-beta"] ?? null });
    if (channel === "probe") return textReply("OK");
    if (channel === "summary") return textReply(JSON.stringify({ title: "自定义服务验证", summary: "使用自定义服务完成聊天和动态" }));
    if (channel === "feed") {
      if (!resultFor(body, "custom_feed_write")) return toolReply("custom_feed_write", "Write", { file_path: path.join(root, post), content: "---\ntitle: 自定义模型写动态\nsource: 本地假服务\nurl: https://example.test/fixture\npublished: 2026-10-16 10:00\nicon: 📰\n---\n已使用选中的自定义服务。\n" });
      return textReply(" ");
    }
    assert.ok(hasInput(body, "V081_PROVIDER_ORIGINAL_CONTEXT"), "resumed main context reaches the new service");
    if (!resultFor(body, "custom_main_say")) return toolReply("custom_main_say", "mcp__doudou__say", { text: "自定义模型已经接上，上下文也续上了。" });
    return textReply(" ");
  } catch (e) { failure = e; return { error: "local provider fixture rejected a request" }; }
});
async function until(predicate) {
  const end = Date.now() + 20_000;
  while (!predicate()) { if (failure) throw failure; if (Date.now() > end) throw new Error("provider fixture timed out"); await delay(10); }
}
try {
  migrateV081({ root }); migrateV08({ root, seedDir: path.join(CODE, "seed") });
  putAppSettings(root, { permissionMode: "bypassPermissions" });
  fs.writeFileSync(file, "Retain the original conversation.");
  const hub = new DeviceHub();
  h = new Harness({ hub, bus, log: (...args) => logs.push(args.join(" ")), queryFactory: ({ prompt, options }) => {
    optionsUsed.push(options);
    return query({ prompt, options: { ...options, agentProgressSummaries: false, env: { ...options.env, ...(options.settings.modelOverrides && { ANTHROPIC_BASE_URL: builtin.url, ANTHROPIC_API_KEY: "fake-builtin-demo-key", ANTHROPIC_AUTH_TOKEN: "" }), CLAUDE_CONFIG_DIR: path.join(root, "system/sessions") } } });
  } });
  const receive = h.onMainMessage.bind(h);
  h.onMainMessage = (message, main) => { wireContextWindow = message.modelUsage?.[model]?.contextWindow || wireContextWindow; receive(message, main); };
  h.startMain(); const content = new Content({ root, bus }), schedules = new Schedules({ harness: h, content });
  server = startServer({ harness: h, hub, bus, content, schedules, log: (...args) => logs.push(args.join(" ")), listen: { host: "127.0.0.1", port: 0 } }); await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  const request = async (route, method = "GET", value) => {
    const response = await fetch(base + route, { method, headers: { authorization: "Bearer fake-provider-demo-token", "content-type": "application/json" }, ...(value && { body: JSON.stringify(value) }) });
    const body = await response.json(); assert.ok(response.ok, JSON.stringify(body)); return body;
  };
  await request("/api/send", "POST", { text: "V081_PROVIDER_ORIGINAL_CONTEXT" }); await until(() => entered);
  const sessionId = h.main.sessionId;
  const { provider } = await request("/api/providers", "POST", { name: "本地 Anthropic 服务", baseUrl: api.url, apiKey: key, models: [{ id: model, name: "基础测试模型" }] });
  await request("/api/settings", "PUT", { model: { provider: provider.id, id: model } });
  assert.equal(optionsUsed.length, 1); assert.equal(h.busy, true, "service switch waits for the current turn");
  release(); await until(() => optionsUsed.length === 2 && !h.busy);
  assert.equal(optionsUsed[1].resume, sessionId); assert.equal(optionsUsed[1].env.ANTHROPIC_API_KEY, undefined);
  await request("/api/send", "POST", { text: "V081_PROVIDER_CUSTOM_CHAT" });
  await until(() => !h.busy && h.speech.history().some((m) => m.text === "自定义模型已经接上，上下文也续上了。"));
  assert.equal(h.main.sessionId, sessionId);
  assert.equal(wireContextWindow, 200000);
  const feed = await request("/api/feed/refresh", "POST"); await h.jobChain;
  if (h.history.get(feed.id).status !== "done") throw new Error(JSON.stringify(h.connectors.redact({ status: h.history.get(feed.id).status, result: h.history.get(feed.id).latestResult, logs, requests })));
  assert.ok(fs.existsSync(path.join(root, post)));
  const summary = await activitySummary({ title: "处理中", steps: [{ kind: "prompt", text: "自定义服务验证" }] }, { env: { AGENT_ACTIVITY_SUMMARIES: "1" } });
  assert.equal(summary.title, "自定义服务验证");
  if (failure) throw failure;
  const result = { ok: true, provider: provider.id, model, resumedSameSession: h.main.sessionId === sessionId, deferredUntilIdle: true, contextWindow: wireContextWindow, requests, summary, chat: (await request("/api/history")).items.map(({ role, text }) => ({ role, text })), feed: (await request("/api/feed")).items.map(({ path: p, title }) => ({ path: p, title })) };
  for (const value of [result, events, logs]) assert.equal(JSON.stringify(value).includes(key), false);
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  fs.writeFileSync(path.join(output, "demo.log"), logs.join("\n") + "\n");
  fs.writeFileSync(path.join(output, "events.jsonl"), events.map((ev) => JSON.stringify(ev)).join("\n") + "\n");
  console.log(JSON.stringify(result));
} finally {
  release(); if (h) await h.close();
  if (server) { server.closeSockets(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await builtin.close(); await api.close(); fs.rmSync(root, { recursive: true, force: true });
}
