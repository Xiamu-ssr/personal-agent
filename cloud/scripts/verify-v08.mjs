import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const index = process.argv.indexOf("--output");
const output = path.resolve(index < 0 ? "/tmp/v08-cloud-demo" : process.argv[index + 1]);
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, "root-"));
for (const name of ["demo.log", "events.jsonl"]) fs.writeFileSync(path.join(output, name), "");
Object.assign(process.env, { AGENT_ROOT: root, AGENT_TOKEN: "fake-local-v08-demo-token", AGENT_HOST: "127.0.0.1", AGENT_PORT: "0" });
const [{ query }, { default: WebSocket }, { Harness }, { DeviceHub }, { Content }, { startServer }, { Schedules }, { migrateV08 }, { CODE }, { fakeAnthropic }, fixtures] = await Promise.all([
  import("@anthropic-ai/claude-agent-sdk"), import("ws"), import("../src/agent.mjs"), import("../src/devices.mjs"), import("../src/content.mjs"), import("../src/server.mjs"), import("../src/scheduler.mjs"), import("../src/migrate-v08.mjs"), import("../src/config.mjs"), import("../test/fake-anthropic.mjs"), import("../test/native-fixture.mjs"),
]);
const { hasInput, toolReply, textReply, resultFor } = fixtures;
const lines = [], events = [], requests = [], listeners = new Set();
const log = (value) => { lines.push(value); fs.appendFileSync(path.join(output, "demo.log"), value + "\n"); };
const bus = { on: (fn) => listeners.add(fn), emit: (e) => { events.push(e); fs.appendFileSync(path.join(output, "events.jsonl"), JSON.stringify(e) + "\n"); for (const fn of listeners) fn(e); } };
let releaseRead, readStarted = false, results = 0, modelError;
const readGate = new Promise((r) => { releaseRead = r; });
const post = "data/feed/2026-10-15/1000-本地验证.md";
const api = await fakeAnthropic((body) => {
  try {
  const feed = hasInput(body, "[动态]");
  requests.push({ request: requests.length + 1, model: body.model, feed, interjection: JSON.stringify(body.messages).includes("DEMO_INTERJECTION"), resultsBeforeRequest: results });
  if (feed) {
    assert.equal(body.model, "anthropic/claude-haiku-5.5");
    if (!resultFor(body, "feed_write")) return toolReply("feed_write", "Write", { file_path: path.join(root, post), content: "---\ntitle: 本地假模型验证完成\nsource: 回环测试\nurl: https://example.test/local\npublished: 2026-10-15 10:00\nicon: 📰\n---\n这是一条本地测试动态。\n" });
    return textReply(" ");
  }
  if (hasInput(body, "DEMO_OPTION_REPLY")) return textReply("收到，继续处理。这句普通正文也显示为气泡。");
  if (!resultFor(body, "say_first")) return toolReply("say_first", "mcp__doudou__say", { text: "我先看一下，稍后再跟你说。", cards: [{ type: "link", url: "https://example.test/local", title: "本地示例" }] });
  if (!resultFor(body, "read_pause")) return toolReply("read_pause", "Read", { file_path: path.join(root, "workspace/demo/context.txt") });
  assert.equal(JSON.stringify(body.messages).includes("DEMO_INTERJECTION"), true);
  assert.equal(results, 0, "interjection must reach the request before the first result");
  if (!resultFor(body, "say_second")) return toolReply("say_second", "mcp__doudou__say", { text: "补充已经收到了，要继续吗？", options: [{ label: "继续", reply: "DEMO_OPTION_REPLY" }, { label: "先等一下" }] });
  return textReply(" ");
  } catch (e) { modelError = e; return { error: "local demo assertion failed" }; }
});
let h, server, ws;
try {
  migrateV08({ root, seedDir: path.join(CODE, "seed") });
  fs.mkdirSync(path.join(root, "workspace/demo"), { recursive: true }); fs.writeFileSync(path.join(root, "workspace/demo/context.txt"), "local fixture");
  const hub = new DeviceHub();
  h = new Harness({ hub, bus, log() {}, queryFactory: ({ prompt, options }) => {
    const pre = options.hooks.PreToolUse;
    return query({ prompt, options: { ...options, settingSources: [], agentProgressSummaries: false, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      hooks: { ...options.hooks, PreToolUse: [...pre, { matcher: "Read", hooks: [async (input) => { if (input.tool_use_id === "read_pause") { readStarted = true; await readGate; } return {}; }] }] },
      env: { ...options.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-local-demo-only", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CONFIG_DIR: path.join(root, "system/sessions"), CLAUDE_CODE_TMPDIR: path.join(root, "native-tmp"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
    } });
  } });
  const receive = h.onMainMessage.bind(h); h.onMainMessage = (m, main) => { if (m.type === "result") results++; receive(m, main); };
  const content = new Content({ root, bus }), schedules = new Schedules({ harness: h, content }); h.startMain();
  server = startServer({ harness: h, hub, bus, content, schedules, log() {}, listen: { host: "127.0.0.1", port: 0 } }); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${process.env.AGENT_TOKEN}`, "Content-Type": "application/json" };
  const request = async (route, method = "GET", value) => { const r = await fetch(base + route, { method, headers, signal: AbortSignal.timeout(15_000), ...(value !== undefined && { body: JSON.stringify(value) }) }); return { status: r.status, body: await r.json() }; };
  const until = async (predicate) => { const end = Date.now() + 15_000; while (!predicate()) { if (modelError) throw modelError; if (Date.now() > end) throw new Error("local demo timed out"); await delay(10); } };
  const appEvents = []; ws = new WebSocket(base.replace("http:", "ws:") + "/ws", { headers }); ws.on("message", (raw) => appEvents.push(JSON.parse(raw))); await once(ws, "open");
  assert.equal((await request("/api/send", "POST", { text: "DEMO_START：请先说一句，读资料后再问我是否继续。" })).status, 200);
  await until(() => readStarted); assert.equal(results, 0);
  assert.equal((await request("/api/send", "POST", { text: "DEMO_INTERJECTION：工具执行时的新交代。" })).status, 200);
  log("busy interjection accepted while Read is running; results=0");
  await delay(250); releaseRead();
  await until(() => events.filter((e) => e.t === "say").length === 2 && !h.busy);
  const speech = events.filter((e) => e.t === "say"); assert.equal(h.avatar.value.state, "waiting");
  log("say #1: " + speech[0].text); log("say #2: " + speech[1].text + "; options=" + speech[1].options.map((o) => o.label).join("/")); log("avatar: working -> waiting");
  const choice = { messageId: speech[1].id, optionId: "0" };
  assert.equal((await request("/api/options/choose", "POST", choice)).status, 200); const duplicate = await request("/api/options/choose", "POST", choice); assert.equal(duplicate.status, 409);
  await until(() => results === 2 && !h.busy); log("option click=200; repeat click=409; reply=DEMO_OPTION_REPLY");
  const history = (await request("/api/history")).body.items; assert.equal(history.filter((m) => m.role === "assistant").length, 3); assert.equal(history.find((m) => m.id === speech[1].id).optionsUsed, true);
  log("ordinary assistant prose preserved as bubble #3");
  const activities = (await request("/api/activities")).body; assert.equal(activities.recent.length, 2);
  const detail = (await request(`/api/activities/${speech[0].activityId}/history`)).body; assert.ok(detail.items.some((i) => i.kind === "tool" && i.tool === "Read")); assert.ok(detail.items.some((i) => i.kind === "prompt" && i.text.includes("DEMO_INTERJECTION")));
  log(`activities: ${activities.recent.length} chat rounds; first activity steps=${detail.items.length}; interjection and Read recorded`);
  assert.equal((await request("/api/settings", "PUT", { model: "anthropic/claude-opus-5.5" })).status, 200); await h.inputChain;
  assert.equal((await request("/api/feed/refresh", "POST")).status, 202); await h.jobChain; await until(() => events.some((e) => e.t === "feed_new"));
  assert.equal((await request("/api/feed?days=1")).body.items[0].path, post); assert.ok(requests.filter((r) => r.feed).every((r) => r.model === "anthropic/claude-haiku-5.5"));
  log("chat model=Opus 5.5; feed wire model=Haiku 5.5; new post event received; main busy=false");
  assert.equal(appEvents.some((e) => e.t === "tool" || e.t === "queue_update"), false);
  const summary = { ok: true, sdk: "0.3.295", chatBubbles: 3, chatActivities: 2, firstActivitySteps: detail.items.length, interjectionBeforeResult: true, optionStatuses: [200, 409], feedModel: "anthropic/claude-haiku-5.5", feedNew: true, requests, log: lines };
  fs.writeFileSync(path.join(output, "requests.json"), JSON.stringify(requests, null, 2) + "\n"); fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
} finally {
  releaseRead(); ws?.terminate(); await h?.close();
  if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  await api.close();
}
