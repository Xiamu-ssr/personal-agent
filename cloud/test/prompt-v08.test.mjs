import "./environment.mjs";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { config } from "../src/config.mjs";

test("system prompt appends only the instruction body below its divider, with placeholders filled", async () => {
  const h = new Harness({ hub: new DeviceHub(), bus: { emit() {} }, log() {} });
  const options = h.options({ isolated: true, onWrite() {} });
  try {
    const raw = fs.readFileSync(config.promptFile, "utf8"), parts = raw.split(/\n---\n/);
    assert.ok(parts.length > 1); assert.equal(options.systemPrompt.preset, "claude_code");
    assert.ok(options.systemPrompt.append.trim());
    assert.doesNotMatch(options.systemPrompt.append, /\{(?:名字|称呼|时区)\}/);
    assert.equal(options.systemPrompt.append.startsWith(parts[0].trim()), false);
    if (parts.slice(1).join("\n---\n").includes("{时区}")) assert.ok(options.systemPrompt.append.includes(config.timezone));
  } finally { for (const server of Object.values(options.mcpServers)) await server.instance.close(); await h.close(); }
});
