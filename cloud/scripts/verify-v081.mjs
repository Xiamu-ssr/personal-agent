import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const option = process.argv.indexOf("--output"), output = path.resolve(option < 0 ? "/tmp/v081-cloud-demo" : process.argv[option + 1]);
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, "root-"));
Object.assign(process.env, { AGENT_ROOT: root, AGENT_TOKEN: "fake-v081-local-token", AGENT_HOST: "127.0.0.1", AGENT_PORT: "0", AGENT_BROWSER_SERVICE: "" });
const [{ query }, { Harness }, { DeviceHub }, { Content }, { startServer }, { Schedules }, { migrateV08 }, { CODE }, { activitySummary }, { SPEECH_REMINDER }, { fakeAnthropic }, { resultFor, toolReply, textReply, blocks }] = await Promise.all([
  import("@anthropic-ai/claude-agent-sdk"), import("../src/agent.mjs"), import("../src/devices.mjs"), import("../src/content.mjs"), import("../src/server.mjs"), import("../src/scheduler.mjs"),
  import("../src/migrate-v08.mjs"), import("../src/config.mjs"), import("../src/activity-summary.mjs"), import("../src/turn-speech.mjs"), import("../test/fake-anthropic.mjs"), import("../test/native-fixture.mjs"),
]);
const events = [], listeners = new Set(), lines = [], stops = [], requests = [];
for (const name of ["events.jsonl", "demo.log"]) fs.writeFileSync(path.join(output, name), "");
const log = (line) => { lines.push(line); fs.appendFileSync(path.join(output, "demo.log"), line + "\n"); };
const bus = { on: (fn) => listeners.add(fn), emit: (event) => { events.push(event); fs.appendFileSync(path.join(output, "events.jsonl"), JSON.stringify(event) + "\n"); for (const fn of listeners) fn(event); } };
let goalError, feedError, modelError, readStarted = false, releaseRead;
const readGate = new Promise((r) => { releaseRead = r; });
const api = await fakeAnthropic((body) => {
  try {
    if (body.max_tokens === 1024) {
      assert.equal(body.model, "z-ai/glm-5.3-flash");
      const record = JSON.parse(body.messages[0].content), goal = record.instruction.includes("[目标跟进]");
      requests.push({ model: body.model, kind: "summary" });
      return textReply(JSON.stringify(goal ? { title: "跟进目标：增肌", summary: "询问了今天的训练进展" } : { title: "查询本地资料", summary: "读取资料并向用户说明了结果" }));
    }
    const current = body.messages.filter((m) => m.role === "user").flatMap(blocks).filter((b) => b.type === "text").findLast((b) => /V081_|^\[目标跟进\]/.test(b.text))?.text || "";
    requests.push({ model: body.model, kind: "chat", goal: current.startsWith("[目标跟进]"), busy: current.includes("V081_BUSY") });
    if (current.includes("V081_FEED")) {
      const result = resultFor(body, "feed_say");
      if (!result) return toolReply("feed_say", "mcp__doudou__say", { text: "这句后台说话不能出现。" });
      feedError = JSON.stringify(result); assert.match(feedError, /后台运行不能对用户说话/);
      return textReply("[动态] 本次不发帖，内部处理完成。");
    }
    const sayThenStop = (id, text) => resultFor(body, id) ? textReply(text) : toolReply(id, "mcp__doudou__say", { text });
    if (current.startsWith("[目标跟进]")) return sayThenStop("checkin_say", "今天训练了吗？");
    if (current.includes("V081_PURE")) return sayThenStop("pure_say", "好呀，随时聊。");
    if (current.includes("V081_BUSY")) {
      if (!resultFor(body, "busy_read")) return toolReply("busy_read", "Read", { file_path: path.join(root, "workspace/demo/check.txt") });
      return sayThenStop("busy_say", "这件事处理完了。");
    }
    if (current.includes("V081_GOAL")) {
      const result = resultFor(body, "missing_goal");
      if (!result) return toolReply("missing_goal", "mcp__doudou__say", { text: "目标已经建好了。", cards: [{ type: "goal", name: "演示目标" }] });
      goalError = JSON.stringify(result); assert.match(goalError, /还没写好/);
      return sayThenStop("goal_correction", "目标文件还没写好，暂时不给你卡片。");
    }
    if (current.includes("V081_DISCUSS")) { assert.ok(current.includes("完整帖子正文")); return sayThenStop("discuss_say", "读到了引用的动态，接着聊它对你的影响。"); }
    if (!resultFor(body, "process_read")) return { stop_reason: "tool_use", content: [{ type: "text", text: "这段中间念叨不应进入聊天。" }, { type: "tool_use", id: "process_read", name: "Read", input: { file_path: path.join(root, "workspace/demo/check.txt") } }] };
    if (!resultFor(body, "main_say")) return toolReply("main_say", "mcp__doudou__say", { text: "我已经检查了一部分。" });
    if (JSON.stringify(body.messages).includes(SPEECH_REMINDER)) return sayThenStop("main_completion", "资料已读完，这是给你的短句结果。");
    return textReply("都办完了，分头说：这段较长正文必须先被 Stop 提醒，不直接显示。");
  } catch (e) { modelError = e; return { error: "local v081 fixture assertion failed" }; }
});
let h, server;
try {
  migrateV08({ root, seedDir: path.join(CODE, "seed") });
  const { putAppSettings } = await import("../src/app-settings.mjs");
  putAppSettings(root, { model: { provider: "zenmux", id: "z-ai/glm-5.3-flash" } });
  fs.mkdirSync(path.join(root, "workspace/demo"), { recursive: true }); fs.writeFileSync(path.join(root, "workspace/demo/check.txt"), "local fixture");
  const rel = "data/feed/2026-10-16/0900-新品.md";
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), "---\ntitle: 新工具发布\nsource: 本地发布站\nicon: 🚀\nurl: https://example.test/new\n---\n完整帖子正文，含原文事实。\n");
  fs.writeFileSync(path.join(root, "data/goals/增肌.md"), '---\ntitle: 增肌\ndomain: 健康\ncadence: "0 21 * * *"\nstatus: 追踪中\nprogress: 10\n---\n## 计划\n训练。\n## 步骤\n- [ ] 练习\n## 记录\n');
  const hub = new DeviceHub();
  h = new Harness({ hub, bus, log() {}, summarize: (record, options) => activitySummary(record, { ...options, env: { ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-v081-summary" } }),
    queryFactory: ({ prompt, options }) => query({ prompt, options: { ...options,
      settingSources: [], agentProgressSummaries: false,
      permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      hooks: { ...options.hooks,
        ...(options.hooks.Stop && { Stop: options.hooks.Stop.map((group) => ({ ...group, hooks: group.hooks.map((hook) => async (input) => {
          const result = await hook(input); stops.push({ activityId: h.main?.activityId, active: input.stop_hook_active, decision: result.decision || "allow", text: input.last_assistant_message }); return result;
        }) })) }),
        PreToolUse: [...options.hooks.PreToolUse, { matcher: "Read", hooks: [async (input) => { if (input.tool_use_id === "busy_read") { readStarted = true; await readGate; } return {}; }] }],
      },
      env: { ...options.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-v081-model", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CONFIG_DIR: path.join(root, "system/sessions"),
        CLAUDE_CODE_TMPDIR: path.join(root, "sdk-tmp"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" } } }) });
  h.startMain(); const content = new Content({ root, bus }), schedules = new Schedules({ harness: h, content });
  server = startServer({ harness: h, hub, bus, content, schedules, log() {}, listen: { host: "127.0.0.1", port: 0 } }); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${process.env.AGENT_TOKEN}`, "content-type": "application/json" };
  const request = async (route, body) => { const r = await fetch(base + route, { headers, signal: AbortSignal.timeout(20_000), ...(body !== undefined && { method: "POST", body: JSON.stringify(body) }) }); return { status: r.status, body: await r.json() }; };
  const until = async (fn) => { const end = Date.now() + 20_000; while (!fn()) { if (modelError) throw modelError; if (Date.now() > end) throw new Error("v081 local demo timed out"); await delay(10); } };
  const main = await request("/api/send", { text: "V081_MAIN 先说话，再写正文", clientId: "demo-main" }); assert.equal(main.status, 200); await until(() => !h.busy); await Promise.all([...h.summaryJobs]);
  let chat = (await request("/api/history")).body;
  assert.deepEqual(chat.items.filter((m) => m.role === "assistant").map((m) => m.text), ["我已经检查了一部分。", "资料已读完，这是给你的短句结果。"]);
  assert.deepEqual(stops.filter((s) => s.activityId === main.body.id).map((s) => [s.active, s.decision]), [[false, "block"], [true, "allow"]]);
  log("main: say -> prose -> Stop block once -> repaired say; chat contains only 2 say bubbles, no fallback");
  const pure = await request("/api/send", { text: "V081_PURE 纯聊天", clientId: "demo-pure" }); await until(() => !h.busy);
  const workActivities = (await request("/api/activities")).body;
  assert.equal(workActivities.recent.length, 1); assert.equal(workActivities.recent[0].id, main.body.id); assert.ok(workActivities.recent[0].summary);
  assert.ok((await request(`/api/activities/${pure.body.id}/history`)).body.items.length);
  log("activities: pure chat hidden, research listed with selected-model title/summary; both process histories readable");
  const busy = await request("/api/send", { text: "V081_BUSY 先查资料", clientId: "demo-busy" }); await until(() => readStarted);
  const accepted = await request("/api/schedules/" + encodeURIComponent("goal:增肌") + "/run", {}); assert.equal(accepted.body.mode, "main");
  const goalDone = schedules.active.get("goal:增肌").done;
  const queued = { mode: accepted.body.mode, id: accepted.body.id, busyActivityId: h.main.activityId, waiting: h.mainRuns.length, goalRequested: requests.some((r) => r.goal) };
  assert.equal(queued.goalRequested, false); assert.equal(queued.busyActivityId, busy.body.id); assert.equal(queued.waiting, 1);
  releaseRead(); await goalDone; await until(() => !h.busy); await Promise.all([...h.summaryJobs]);
  assert.ok(requests.some((r) => r.goal)); assert.equal(h.speech.history().some((m) => m.role === "user" && m.text.startsWith("[目标跟进]")), false);
  log("goal: busy main keeps check-in pending; native idle -> same main stream starts goal -> say; no trigger user bubble");
  chat = (await request("/api/history")).body;
  const feed = await h.runIsolated("动态", "[动态] V081_FEED"); assert.equal(feed.ok, true);
  assert.equal((await request("/api/history")).body.items.length, chat.items.length); assert.match(feedError, /后台运行不能对用户说话/);
  log("feed: say returned tool error '后台运行不能对用户说话'; prose stayed in process; no-post activity hidden");
  await request("/api/send", { text: "V081_GOAL 测试尚未写好的目标卡", clientId: "demo-goal" }); await until(() => !h.busy);
  assert.match(goalError, /data\/goals\/演示目标\.md.*还没写好/); assert.equal(h.speech.history().some((m) => m.text === "目标已经建好了。" || m.cards?.some((c) => c.name === "演示目标")), false);
  log("goal card: missing file rejected the complete say, model corrected with a valid say");
  const discussion = { path: rel, action: "discuss", text: "V081_DISCUSS 这对我有什么用？", clientId: "demo-discuss" };
  const [first, repeat] = await Promise.all([request("/api/feed/feedback", discussion), request("/api/feed/feedback", discussion)]);
  assert.deepEqual(first, repeat); assert.equal(first.status, 200); await until(() => !h.busy);
  chat = (await request("/api/history")).body;
  const user = chat.items.find((m) => m.id === first.body.id); assert.equal(user.text, discussion.text); assert.equal(user.quote.path, rel); assert.equal(chat.items.filter((m) => m.quote).length, 1);
  log("discussion: user words + feed quote persisted; repeated clientId reused one result and message");
  const activities = (await request("/api/activities")).body;
  assert.deepEqual(activities.running, []); assert.equal(activities.recent.length, 3); assert.equal(activities.recent.some((a) => [pure.body.id, feed.id].includes(a.id)), false);
  assert.ok(activities.recent.every((a) => a.title !== "处理中" && a.summary));
  assert.equal(chat.items.some((m) => m.fallback), false);
  const result = { ok: true, version: "0.8.1", sdk: "0.3.295", chatRoute: "/api/history", chat, activities, workActivities, queued, stops, requests,
    goalToolError: true, feedToolError: "后台运行不能对用户说话", discussDuplicateId: first.body.id, log: lines };
  for (const [name, value] of [["chat.json", chat], ["activities.json", activities], ["work-activities.json", workActivities], ["goal-queued.json", queued], ["stops.json", stops], ["summary.json", result]]) fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + "\n");
  console.log(JSON.stringify(result));
} finally {
  releaseRead(); await h?.close();
  if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  await api.close();
}
