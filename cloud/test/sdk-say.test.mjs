import "./environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Speech } from "../src/say.mjs";
import { fakeAnthropic } from "./fake-anthropic.mjs";
import { nativeHarness, isFork, toolReply, resultFor, textReply, hasInput } from "./native-fixture.mjs";

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
