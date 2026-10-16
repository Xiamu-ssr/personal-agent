import "./environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Speech } from "../src/say.mjs";
import { SPEECH_REMINDER } from "../src/turn-speech.mjs";
import { Schedules } from "../src/scheduler.mjs";
import { fakeAnthropic } from "./fake-anthropic.mjs";
import { nativeHarness, isFork, toolReply, resultFor, textReply, hasInput } from "./native-fixture.mjs";

test("native Stop blocks prose after say once, the model adds say, and a following prose-only turn terminates after one reminder", { timeout: 25_000 }, async (t) => {
  let second = 0;
  const api = await fakeAnthropic((body) => {
    if (hasInput(body, "NO_SAY_NEXT_TURN")) return textReply(++second === 1 ? "没有 say 的正文" : "第二次依旧只写正文");
    if (resultFor(body, "supplement_say")) return textReply("补发给用户的短句。");
    if (JSON.stringify(body.messages).includes(SPEECH_REMINDER)) return toolReply("supplement_say", "mcp__doudou__say", { text: "补发给用户的短句。" });
    if (resultFor(body, "native_say")) return textReply("都办完了，分头说：这段正文不会显示。");
    return toolReply("native_say", "mcp__doudou__say", { text: "开始处理了。" });
  });
  const { harness, events, until } = nativeHarness(t, api);
  await harness.send("SAY_WITH_POSTSCRIPT"); await until(() => !harness.busy);
  const id = events.find((e) => e.t === "say").activityId;
  assert.deepEqual(harness.speech.history().filter((m) => m.role === "assistant").map((m) => m.text), ["开始处理了。", "补发给用户的短句。"]);
  assert.equal(harness.taskHistory(id).items.filter((i) => i.tool === "Stop").length, 1);
  assert.ok(harness.taskHistory(id).items.some((i) => i.text.includes("这段正文不会显示")));
  assert.equal(events.some((e) => e.t === "delta" || e.fallback), false);
  await harness.send("NO_SAY_NEXT_TURN"); await until(() => !harness.busy);
  assert.equal(second, 2); assert.equal(harness.speech.history().filter((m) => m.role === "assistant").length, 2);
  assert.equal(harness.taskHistory(harness.main.activityId).items.filter((i) => i.tool === "Stop").length, 1);
});

test("native fork say is rejected through the exact MCP tool-use id and remains in its process", { timeout: 20_000 }, async (t) => {
  const contexts = [], tools = Speech.prototype.tools; let denied = false;
  t.mock.method(Speech.prototype, "tools", function(...args) { return tools.apply(this, args).map((tool) => ({ ...tool, handler: async (input, extra) => {
    contexts.push(extra?._meta); return tool.handler(input, extra);
  } })); });
  const api = await fakeAnthropic((body) => {
    if (isFork(body)) {
      const result = resultFor(body, "child_say");
      if (result) { assert.match(JSON.stringify(result), /后台运行不能对用户说话/); denied = true; return textReply("只向主会话汇报结果。"); }
      return toolReply("child_say", "mcp__doudou__say", { text: "这句后台说话应被拒绝" });
    }
    if (!resultFor(body, "spawn_say") && !hasInput(body, "task-notification")) return toolReply("spawn_say", "Agent", { subagent_type: "fork", run_in_background: true, description: "后台工作", prompt: "CHILD_SAY" });
    return textReply(" ");
  });
  const { harness, events, wire, until } = nativeHarness(t, api);
  await harness.send("测试后台说话限制"); await until(() => denied && wire.some((m) => m.subtype === "task_notification") && !harness.busy);
  const child = wire.find((m) => m.subtype === "task_started" && m.subagent_type === "fork");
  assert.equal(events.some((e) => e.t === "say"), false);
  const history = harness.taskHistory(child.task_id);
  assert.ok(history.items.some((i) => i.kind === "prompt" && i.text.includes("CHILD_SAY")));
  assert.ok(history.items.some((i) => i.kind === "tool" && i.tool === "mcp__doudou__say"));
  assert.equal(contexts[0]["claudecode/toolUseId"], "child_say"); assert.equal(contexts.length, 1);
});

test("native side Stop reminds once and its repaired say stays in the side chat; feed say is a tool error", { timeout: 25_000 }, async (t) => {
  let denied = false, sideRequests = 0;
  const api = await fakeAnthropic((body) => {
    if (hasInput(body, "SILENT_FEED")) {
      const result = resultFor(body, "feed_say");
      if (result) { assert.match(JSON.stringify(result), /后台运行不能对用户说话/); denied = true; return textReply("后台正文记录"); }
      return toolReply("feed_say", "mcp__doudou__say", { text: "后台不该出现的气泡" });
    }
    sideRequests++;
    if (resultFor(body, "side_repaired")) return textReply("给旁聊的短句。");
    if (JSON.stringify(body.messages).includes(SPEECH_REMINDER)) return toolReply("side_repaired", "mcp__doudou__say", { text: "给旁聊的短句。" });
    return textReply("用户看不到的旁聊正文");
  });
  const { harness } = nativeHarness(t, api);
  const mainBefore = harness.speech.history();
  const id = await harness.createSideChat("SIDE_STOP_CHECK"); await harness.jobChain;
  assert.equal(sideRequests, 3);
  assert.deepEqual(harness.taskHistory(id).messages.filter((m) => m.role === "assistant").map((m) => m.text), ["给旁聊的短句。"]);
  assert.equal(harness.taskHistory(id).items.filter((i) => i.tool === "Stop").length, 1);
  assert.equal((await harness.runIsolated("动态", "[动态] SILENT_FEED")).ok, true); assert.equal(denied, true);
  assert.deepEqual(harness.speech.history(), mainBefore);
});

test("native goal check-in waits for the busy main turn and its say is already in the same conversation for the user's reply", { timeout: 25_000 }, async (t) => {
  let release; const gate = new Promise((r) => { release = r; });
  let started = false, sawGoal = false, sawContext = false;
  const api = await fakeAnthropic(async (body) => {
    if (hasInput(body, "USER_REPLY_TO_GOAL")) { sawContext = JSON.stringify(body.messages).includes("今天训练了吗"); return textReply("收到。"); }
    if (hasInput(body, "[目标跟进] 增肌")) {
      sawGoal = true; return resultFor(body, "goal_say") ? textReply("今天训练了吗？") : toolReply("goal_say", "mcp__doudou__say", { text: "今天训练了吗？" });
    }
    started = true; await gate;
    return resultFor(body, "busy_say") ? textReply("主聊天完成。") : toolReply("busy_say", "mcp__doudou__say", { text: "主聊天完成。" });
  });
  const { harness, until, wire } = nativeHarness(t, api, { release });
  await harness.send("BUSY_MAIN"); await until(() => started);
  const service = new Schedules({ harness });
  const accepted = await service.run({ id: "goal:增肌", kind: "goal", goal: "增肌" }), done = service.active.get("goal:增肌").done;
  assert.equal(accepted.mode, "main"); assert.equal(sawGoal, false); assert.equal(harness.mainRuns.length, 1);
  release(); await done; await until(() => !harness.busy);
  assert.equal(sawGoal, true); assert.equal(harness.history.get(accepted.id).title, "跟进目标：增肌");
  assert.equal(harness.speech.history().some((m) => m.role === "user" && m.text.startsWith("[目标跟进]")), false);
  await harness.send("USER_REPLY_TO_GOAL 练完了"); await until(() => !harness.busy); assert.equal(sawContext, true);
  assert.equal(new Set(wire.filter((m) => m.type === "result").map((m) => m.session_id)).size, 1);
});
