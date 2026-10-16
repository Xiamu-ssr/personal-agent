import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("real SDK + local HTTP/WS demo: two say calls, busy interjection, one-shot option, activities and selected feed wire model", { timeout: 30_000 }, async () => {
  const output = fs.mkdtempSync(path.join(testRoot, "v08-demo-"));
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/verify-v08.mjs", import.meta.url)), "--output", output], { timeout: 25_000 });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.ok, true); assert.equal(result.interjectionBeforeResult, true);
  assert.equal(result.chatBubbles, 3); assert.equal(result.chatActivities, 1);
  assert.deepEqual(result.optionStatuses, [200, 409]); assert.equal(result.feedModel, "anthropic/claude-opus-5.5"); assert.equal(result.feedNew, true);
  assert.ok(result.requests.some((r) => r.interjection && r.resultsBeforeRequest === 0));
  assert.ok(fs.statSync(path.join(output, "events.jsonl")).size > 0);
});
