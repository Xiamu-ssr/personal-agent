import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { config } from "../src/config.mjs";
import { writeJson } from "../src/store.mjs";

export const toolReply = (id, name, input) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] });
export const textReply = (text) => ({ content: [{ type: "text", text }] });
export const blocks = (m) => Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
export const resultFor = (body, id) => body.messages.flatMap(blocks).findLast((b) => b.type === "tool_result" && b.tool_use_id === id);
export const hasInput = (body, text) => body.messages.some((m) => m.role === "user" && blocks(m).some((b) => b.type === "text" && b.text.includes(text)));
export const isFork = (body) => hasInput(body, "You are a worker fork.");

export function nativeHarness(t, api, { connectors, hub = new DeviceHub(), release = () => {} } = {}) {
  const events = [], wire = [], listeners = new Set();
  const bus = { emit: (e) => { events.push(e); for (const fn of listeners) fn(e); }, on: (fn) => listeners.add(fn) };
  fs.mkdirSync(config.root, { recursive: true }); writeJson(config.stateFile, {});
  const harness = new Harness({ hub, bus, log() {}, ...(connectors && { connectors }),
    queryFactory: ({ prompt, options }) => query({ prompt, options: { ...options,
      systemPrompt: "Local test fixture. Write brief HTML with Write/Edit. Use background Agent fork for scheduled briefs.",
      settingSources: [], agentProgressSummaries: false, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      env: { ...options.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-local-only", ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_CONFIG_DIR: path.join(config.sessions, "v04-" + Math.random().toString(16).slice(2)), CLAUDE_CODE_TMPDIR: path.join(config.root, "native-tmp"),
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" } } }) });
  const receive = harness.onMainMessage.bind(harness);
  harness.onMainMessage = (m, main) => { wire.push(m); receive(m, main); };
  harness.startMain();
  t.after(async () => {
    release(); clearTimeout(harness.restartTimer);
    harness.main.intentionalClose = true; harness.main.inbox.close(); harness.main.q.close();
    await harness.main.finished; await api.close();
  });
  async function until(predicate) {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("local v0.4 fixture timed out: " + JSON.stringify(wire.slice(-8).map((m) => ({ type: m.type, subtype: m.subtype, state: m.state, status: m.status }))));
      await delay(10);
    }
  }
  return { harness, events, wire, hub, bus, until };
}
