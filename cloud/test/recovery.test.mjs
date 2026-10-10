import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.mjs";
import { appendJsonl } from "../src/store.mjs";
import { contextFailure, humanError, recoveryContext, recentChat, withRecovery } from "../src/conversation-recovery.mjs";

test("compaction/overflow errors become Chinese; ordinary auth/rate/output errors do not trigger a reset", () => {
  for (const raw of ["Prompt is too long · automatic compaction failed: API Error", "Error during compaction: exceeded the 32000 output token maximum", "Conversation too long."]) assert.equal(contextFailure(raw), true);
  for (const raw of ["401 authentication_failed", "rate_limit", "API Error: exceeded the 32000 output token maximum"]) assert.equal(contextFailure(raw), false);
  assert.match(humanError("Prompt is too long"), /记忆/);
  assert.match(humanError("Unauthorized 401"), /授权/);
  assert.match(humanError("", "max_output_tokens"), /回复过长/);
});

test("bounded recovery preserves recent intent, attachments and memory/todo pointers without modifying data", () => {
  fs.mkdirSync(path.join(config.data, "memory/project"), { recursive: true });
  const todo = path.join(config.data, "todos.md");
  fs.writeFileSync(todo, "待办：继续报价\n");
  fs.writeFileSync(path.join(config.data, "memory/project/报价.md"), "报价线索\n");
  appendJsonl(config.chatLog, { role: "user", text: "我的待办在 data/todos.md", attachments: [{ path: "data/uploads/a.txt" }] });
  appendJsonl(config.chatLog, { role: "assistant", text: "Error during compaction: sensitive error", error: true });
  const summary = recoveryContext({ root: config.root, chatLog: config.chatLog });
  assert.match(summary, /data\/todos.md/);
  assert.match(summary, /data\/memory\/project\/报价.md/);
  assert.match(summary, /data\/uploads\/a.txt/);
  assert.equal(summary.includes("sensitive error"), false);
  assert.equal(fs.readFileSync(todo, "utf8"), "待办：继续报价\n");
  assert.ok(summary.length < 20000);
  const image = { type: "image", source: { type: "base64", data: "fake" } };
  const input = { type: "user", message: { role: "user", content: [image] } };
  assert.equal(withRecovery(input, summary).message.content[1], image);
  assert.equal(input.message.content.length, 1);
});

test("tail reads discard incomplete records and do not allocate the whole archive", () => {
  const file = path.join(config.system, "large-chat.jsonl");
  fs.writeFileSync(file, JSON.stringify({ role: "user", text: "x".repeat(4096) }) + "\n" + JSON.stringify({ role: "user", text: "latest" }) + "\n");
  assert.deepEqual(recentChat(file, 128), [{ role: "user", text: "latest" }]);
});
