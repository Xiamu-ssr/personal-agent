import "./environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Speech } from "../src/say.mjs";
import { fakeAnthropic } from "./fake-anthropic.mjs";
import { nativeHarness, isFork, toolReply, resultFor, textReply, hasInput } from "./native-fixture.mjs";

test("native say suppresses its surrounding prose and the next no-say turn still falls back", { timeout: 25_000 }, async (t) => {
  const before = "开始自检浏览器", after = "云端浏览器自检完成，已把 HN 排第一的标题发给用户";
  const api = await fakeAnthropic((body) => {
    if (hasInput(body, "NO_SAY_NEXT_TURN")) return textReply("没有 say 的真实 SDK 回复");
    if (resultFor(body, "native_say")) return textReply(after);
    return { stop_reason: "tool_use", content: [{ type: "text", text: before },
      { type: "tool_use", id: "native_say", name: "mcp__doudou__say", input: { text: "HN 第一条标题：本地测试结果" } }] };
  });
  const { harness, events, until } = nativeHarness(t, api);
  await harness.send("SAY_WITH_POSTSCRIPT"); await until(() => !harness.busy);
  const id = events.find((e) => e.t === "say").activityId;
  assert.deepEqual(harness.speech.history().filter((m) => m.role === "assistant").map((m) => m.text), ["HN 第一条标题：本地测试结果"]);
  for (const text of [before, after]) assert.equal(harness.taskHistory(id).items.filter((i) => i.text === text).length, 1);
  assert.equal(events.some((e) => e.t === "delta"), false);
  await harness.send("NO_SAY_NEXT_TURN"); await until(() => !harness.busy);
  const fallback = harness.speech.history().at(-1);
  assert.equal(fallback.text, "没有 say 的真实 SDK 回复"); assert.equal(fallback.fallback, true);
  assert.ok(events.some((e) => e.t === "delta" && e.id === fallback.id));
});

test("native fork say is associated through the exact MCP tool-use id and its own activity keeps prompt, speech and tools", { timeout: 20_000 }, async (t) => {
  const contexts = [], tools = Speech.prototype.tools;
  t.mock.method(Speech.prototype, "tools", function(...args) { return tools.apply(this, args).map((tool) => ({ ...tool, handler: async (input, extra) => {
    contexts.push({ keys: Object.keys(extra || {}), meta: extra?._meta, requestId: extra?.requestId }); return tool.handler(input, extra);
  } })); });
  const api = await fakeAnthropic((body) => {
    if (isFork(body)) return resultFor(body, "child_say") ? textReply(" ") : toolReply("child_say", "mcp__doudou__say", { text: "后台说话" });
    if (!resultFor(body, "spawn_say") && !hasInput(body, "task-notification")) return toolReply("spawn_say", "Agent", { subagent_type: "fork", run_in_background: true, description: "后台说话活动", prompt: "CHILD_SAY" });
    return textReply(" ");
  });
  const { harness, events, wire, until } = nativeHarness(t, api);
  await harness.send("测试后台说话"); await until(() => events.some((e) => e.t === "say" && e.text === "后台说话") && wire.some((m) => m.subtype === "task_notification") && !harness.busy);
  const child = wire.find((m) => m.subtype === "task_started" && m.subagent_type === "fork");
  assert.equal(events.find((e) => e.t === "say").activityId, child.task_id);
  const history = harness.taskHistory(child.task_id);
  assert.ok(history.items.some((i) => i.kind === "prompt" && i.text.includes("CHILD_SAY")));
  assert.ok(history.items.some((i) => i.text === "后台说话"));
  assert.ok(history.items.some((i) => i.kind === "tool" && i.tool === "mcp__doudou__say"));
  assert.equal(contexts[0].meta["claudecode/toolUseId"], "child_say");
  assert.equal(contexts.length, 1);
});
