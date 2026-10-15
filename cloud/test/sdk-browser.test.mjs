import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("real Chrome + fake model: main and isolated takeover/return continue their original SDK streams", { timeout: 60_000 }, async () => {
  const output = fs.mkdtempSync(path.join(testRoot, "sdk-browser-demo-"));
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/verify-v08-browser.mjs", import.meta.url)), "--output", output], { timeout: 55_000 });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.ok, true); assert.equal(result.realChrome, true); assert.equal(result.launches, 1);
  assert.equal(result.mainStreamReused, true); assert.equal(result.backgroundStreamReused, true);
  assert.equal(result.returnedEvents, 2); assert.equal(result.chatUsers, 1); assert.equal(result.feedLazy, true);
  assert.ok(result.frames > 0); assert.deepEqual(result.viewport, [1280, 800]);
});
