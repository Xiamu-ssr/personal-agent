import "./environment.mjs";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { config } from "../src/config.mjs";

test("system prompt joins both instruction bodies once as a static custom string", async () => {
  const h = new Harness({ hub: new DeviceHub(), bus: { emit() {} }, log() {} });
  const options = h.options({ isolated: true, onWrite() {} });
  try {
    const sources = [config.basePromptFile, config.promptFile].map((file) => fs.readFileSync(file, "utf8").split(/\r?\n---[ \t]*\r?\n/));
    assert.ok(sources.every((parts) => parts.length > 1)); assert.equal(typeof options.systemPrompt, "string");
    assert.doesNotMatch(options.systemPrompt, /\{(?:名字|称呼|时区)\}/);
    const bodies = sources.map((parts) => parts.slice(1).join("\n---\n").trim());
    const expected = bodies.join("\n\n").replaceAll("{名字}", config.agentName).replaceAll("{称呼}", config.userCall).replaceAll("{时区}", config.timezone);
    assert.equal(options.systemPrompt.replaceAll(" ", ""), expected.replaceAll(" ", ""));
    for (const parts of sources) assert.equal(options.systemPrompt.includes(parts[0].trim()), false);
    const base = config.basePromptFile, prompt = config.promptFile;
    try {
      config.basePromptFile = "/missing/base.md"; config.promptFile = "/missing/system-prompt.md";
      const later = h.options({ isolated: false, onWrite() {} });
      assert.equal(later.systemPrompt, options.systemPrompt);
      for (const server of Object.values(later.mcpServers)) await server.instance.close();
    } finally { config.basePromptFile = base; config.promptFile = prompt; }
  } finally { for (const server of Object.values(options.mcpServers)) await server.instance.close(); await h.close(); }
});
