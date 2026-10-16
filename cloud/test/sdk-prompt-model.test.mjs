import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { config } from "../src/config.mjs";
import { putAppSettings } from "../src/app-settings.mjs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { fakeAnthropic } from "./fake-anthropic.mjs";
import { toolReply, textReply, resultFor } from "./native-fixture.mjs";

test("real SDK custom string retains skills, Agent fork, compaction, Stop and MCP; live switch reaches feed and summary", { timeout: 45_000 }, async () => {
  const output = fs.mkdtempSync(path.join(testRoot, "prompt-model-"));
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/verify-v081-prompt.mjs", import.meta.url)), "--output", output], { timeout: 40_000 });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.ok, true); assert.equal(result.cacheStable, true);
  assert.ok(Object.values(result.features).every(Boolean));
  assert.equal([...result.first300].length, 300); assert.ok(result.systemLength > result.customLength);
  assert.deepEqual(result.stops.slice(0, 2), [{ active: false, decision: "block" }, { active: true, decision: "allow" }]);
  assert.notEqual(result.liveModels.before, result.liveModels.feed);
  assert.ok(result.liveModels.after.every((m) => m === result.liveModels.feed));
  assert.equal(result.liveModels.feed, result.liveModels.summary);
  const blocks = JSON.parse(fs.readFileSync(path.join(output, "system.json"), "utf8"));
  assert.equal(blocks.length, 3, "only SDK billing metadata and SDK agent identity accompany the exact custom body");
  assert.equal(blocks.at(-1).text.length, result.customLength);
});

test("a live isolated background or side conversation switches on its next request without losing its turn", { timeout: 30_000 }, async (t) => {
  const file = path.join(config.root, "live-model-fixture.txt"); fs.writeFileSync(file, "local fixture");
  let started, release, entered = false;
  let gate;
  const api = await fakeAnthropic(async (body) => {
    if (!resultFor(body, "live_read")) { entered = true; started(); await gate; return toolReply("live_read", "Read", { file_path: file }); }
    return textReply("只保留在过程。");
  });
  const h = new Harness({ hub: new DeviceHub(), bus: { emit() {} }, log() {}, queryFactory: ({ prompt, options }) => query({ prompt, options: { ...options,
    agentProgressSummaries: false, settingSources: [], env: { ...options.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-live-isolated-key", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  } }) });
  t.after(async () => { release?.(); await h.close(); await api.close(); });
  for (const chatType of [undefined, "side"]) {
    putAppSettings(config.root, { model: { provider: "zenmux", id: "z-ai/glm-5.3-flash" }, permissionMode: "bypassPermissions" });
    gate = new Promise((resolve) => { release = resolve; });
    const ready = new Promise((resolve) => { started = resolve; });
    const before = api.requests.length;
    const run = h.runIsolated("切换模型", "V081_ISOLATED_LIVE", { ...(chatType && { chatType }) });
    await ready; assert.equal(entered, true); assert.equal(api.requests[before].model, "z-ai/glm-5.3-flash");
    putAppSettings(config.root, { model: { provider: "zenmux", id: "anthropic/claude-opus-5.5" } }); await h.settingsChanged();
    release(); assert.equal((await run).ok, true);
    assert.ok(api.requests.slice(before + 1).length > 0);
    assert.ok(api.requests.slice(before + 1).every((b) => b.model === "anthropic/claude-opus-5.5"));
  }
});
