import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../src/config.mjs";
import { fakeAnthropic } from "./fake-anthropic.mjs";

test("streaming input delivers a busy interjection before the next model request, between two tools", { timeout: 25_000 }, async (t) => {
  const items = [], waiters = [], wire = [], evidence = [];
  let closed = false, q;
  const push = (text) => {
    const value = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    waiters.length ? waiters.shift()({ value, done: false }) : items.push(value);
  };
  const prompt = { [Symbol.asyncIterator]: () => ({ next: () => items.length ? Promise.resolve({ value: items.shift(), done: false }) :
    closed ? Promise.resolve({ done: true }) : new Promise((resolve) => waiters.push(resolve)) }) };
  const file = path.join(config.root, "interjection.txt");
  fs.writeFileSync(file, "local fixture");
  const api = await fakeAnthropic((body, index) => {
    const text = JSON.stringify(body.messages);
    evidence.push({ request: index + 1, seesInterjection: text.includes("INTERJECTION_DURING_TOOL"), resultsBeforeRequest: wire.filter((m) => m.type === "result").length });
    if (index < 2) return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "read_" + index, name: "Read", input: { file_path: file } }] };
    return { content: [{ type: "text", text: "INTERJECTION_ACKNOWLEDGED" }] };
  });
  t.after(async () => {
    closed = true;
    for (const resolve of waiters.splice(0)) resolve({ done: true });
    q?.close();
    await api.close();
  });
  q = query({ prompt, options: {
    cwd: config.root, systemPrompt: "Local fixture", settingSources: [], model: "claude-haiku-4-5",
    permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
    hooks: { PreToolUse: [{ matcher: "Read", hooks: [async (input) => {
      if (input.tool_use_id === "read_0") {
        assert.equal(wire.some((m) => m.type === "result"), false);
        push("INTERJECTION_DURING_TOOL: use my new instruction now");
        await delay(250);
      }
      return {};
    }] }] },
    env: { ...process.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-local-interjection", ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_CONFIG_DIR: path.join(config.root, "interjection-config"), CLAUDE_CODE_TMPDIR: path.join(config.root, "interjection-tmp"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
  } });
  push("INITIAL_REQUEST: read the fixture twice");
  for await (const m of q) {
    wire.push(m);
    if (m.type === "result") break;
  }
  assert.equal(evidence[0].seesInterjection, false);
  assert.equal(evidence[1].seesInterjection, true, JSON.stringify(evidence));
  assert.equal(evidence[1].resultsBeforeRequest, 0);
  assert.equal(evidence[2].seesInterjection, true);
  assert.equal(wire.find((m) => m.type === "result")?.subtype, "success");
  console.log("streaming-interjection evidence:", JSON.stringify(evidence));
});
