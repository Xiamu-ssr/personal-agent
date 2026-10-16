import "./environment.mjs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../src/config.mjs";
import { Speech } from "../src/say.mjs";
import { fakeAnthropic } from "./fake-anthropic.mjs";
import { hasInput, toolReply, textReply } from "./native-fixture.mjs";

test("SDK 0.3.295 Stop block continues an open streaming query and stop_hook_active prevents a loop on the next turn too", { timeout: 25_000 }, async (t) => {
  const pending = [], waiters = [], stops = [], results = [], says = [];
  let first = 0, second = 0, closed = false;
  const push = (text) => {
    const value = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    waiters.length ? waiters.shift()({ value, done: false }) : pending.push(value);
  };
  const prompt = { [Symbol.asyncIterator]: () => ({ next: () => pending.length ? Promise.resolve({ value: pending.shift(), done: false }) : closed ? Promise.resolve({ done: true }) : new Promise((r) => waiters.push(r)) }) };
  const api = await fakeAnthropic((body) => {
    if (hasInput(body, "SECOND_STOP_TURN")) return textReply(++second === 1 ? "第二轮第一次正文" : "第二轮仍然只写正文");
    if (++first === 1) return textReply("第一轮用户看不到的正文");
    if (first === 2) {
      assert.match(JSON.stringify(body.messages), /用户看不到/);
      return toolReply("stop_say", "mcp__doudou__say", { text: "补发给用户的短句。" });
    }
    return textReply("补发给用户的短句。");
  });
  const speech = new Speech({ root: config.root, bus: { emit: (e) => says.push(e) } });
  const q = query({ prompt, options: {
    cwd: config.root, model: "claude-haiku-4-5", systemPrompt: "Local Stop hook fixture", settingSources: [],
    permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
    mcpServers: { doudou: speech.mcpServer() },
    hooks: { Stop: [{ hooks: [async (input) => {
      stops.push({ active: input.stop_hook_active, text: input.last_assistant_message });
      return input.stop_hook_active || !input.last_assistant_message?.trim() ? {} : { decision: "block", reason: "你最后写的这段正文用户看不到，请用 say 发出。" };
    }] }] },
    env: { ...process.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-local-stop", ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_CONFIG_DIR: path.join(config.root, "stop-config"), CLAUDE_CODE_TMPDIR: path.join(config.root, "stop-tmp"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
  } });
  t.after(async () => { closed = true; for (const r of waiters.splice(0)) r({ done: true }); q.close(); await api.close(); });
  push("FIRST_STOP_TURN");
  for await (const m of q) if (m.type === "result") {
    results.push(m.subtype);
    if (results.length === 1) push("SECOND_STOP_TURN"); else break;
  }
  assert.deepEqual(results, ["success", "success"]);
  assert.deepEqual(says.filter((e) => e.t === "say").map((e) => e.text), ["补发给用户的短句。"]);
  assert.deepEqual(stops.map((s) => s.active), [false, true, false, true]);
  assert.equal(first, 3); assert.equal(second, 2);
  console.log("Stop streaming evidence:", JSON.stringify({ stops, results, requests: { first, second }, bubbles: 1 }));
});
