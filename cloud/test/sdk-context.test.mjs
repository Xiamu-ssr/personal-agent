import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { config } from "../src/config.mjs";
import { readJson, writeJson } from "../src/store.mjs";
import { fakeAnthropic, compactRequest } from "./fake-anthropic.mjs";

class Input {
  constructor() { this.items = []; this.waiters = []; }
  push(text) {
    const value = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    const waiter = this.waiters.shift();
    waiter ? waiter({ value, done: false }) : this.items.push(value);
  }
  close() { this.closed = true; this.waiters.splice(0).forEach((r) => r({ done: true })); }
  [Symbol.asyncIterator]() { return { next: () => this.items.length ? Promise.resolve({ value: this.items.shift(), done: false }) : this.closed ? Promise.resolve({ done: true }) : new Promise((r) => this.waiters.push(r)) }; }
}

async function nativeFixture(t, api, { baseline = false, isolated = false } = {}) {
  const input = new Input(), messages = [], results = [], waiters = [];
  let childEnv, q;
  const harness = new Harness({ hub: new DeviceHub(), bus: { emit() {} }, log() {} });
  const compaction = harness.compactionControl(() => q);
  const opts = harness.options({ isolated, onWrite() {}, compaction });
  opts.systemPrompt = "You are a tiny local test fixture. Reply OK.";
  opts.settingSources = [];
  opts.agentProgressSummaries = false;
  opts.permissionMode = "bypassPermissions";
  opts.allowDangerouslySkipPermissions = true;
  opts.env = { ...opts.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-local-only-key", ANTHROPIC_AUTH_TOKEN: "",
    CLAUDE_CONFIG_DIR: path.join(config.sessions, "native-" + Math.random().toString(16).slice(2)),
    CLAUDE_CODE_TMPDIR: path.join(config.root, "native-tmp"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
  if (baseline) {
    delete opts.settings.modelOverrides;
    delete opts.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  }
  opts.spawnClaudeCodeProcess = (o) => {
    // This is the real SDK spawn boundary, not just an assertion on Harness.options().
    childEnv = { max: o.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, window: o.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, pct: o.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE };
    return spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ["pipe", "pipe", "pipe"] });
  };
  q = query({ prompt: input, options: opts });
  const finished = (async () => {
    try {
      for await (const m of q) {
        messages.push(m);
        if (process.env.SDK_CONTEXT_DEBUG && (["hook_response", "status", "compact_boundary", "task_notification"].includes(m.subtype) || m.parent_tool_use_id)) console.log("LOCAL SDK", JSON.stringify(m).slice(0, 1300));
        if (m.type === "result") { results.push(m); waiters.splice(0).forEach((r) => r()); }
      }
    } finally { waiters.splice(0).forEach((r) => r()); }
  })();
  // Attach a rejection handler immediately; turns still rethrow it for a useful test failure.
  finished.catch(() => {});
  t.after(async () => {
    if (process.env.SDK_CONTEXT_DEBUG) console.log("LOCAL REQUESTS", JSON.stringify(api.requests.map((r) => ({ max: r.max_tokens, effort: r.output_config, compact: compactRequest(r), messages: r.messages.map((m) => ({ role: m.role, text: JSON.stringify(m.content).slice(0, 300), end: JSON.stringify(m.content).slice(-400) })) }))));
    input.close(); q.close(); await finished; await api.close();
  });
  return {
    messages, results, childEnv: () => childEnv,
    async turn(text) {
      const n = results.length;
      input.push(text);
      while (results.length === n) {
        if (messages.some((m) => m.type === "system" && m.subtype === "startup_failure")) throw new Error("local SDK startup failed");
        await Promise.race([new Promise((resolve) => waiters.push(resolve)), finished.then(() => { throw new Error("SDK ended before a result"); })]);
      }
      return results.at(-1);
    },
  };
}

test("bundled CLI reproduces the dotted gateway model's 32K fallback", { timeout: 45_000 }, async (t) => {
  const api = await fakeAnthropic();
  const f = await nativeFixture(t, api, { baseline: true });
  assert.equal((await f.turn("Reply OK.")).subtype, "success");
  assert.equal(api.requests[0].max_tokens, 32000);
});

test("actual SDK child inherits 128K; cached total below 95K stays; above 95K compacts at low effort", { timeout: 60_000 }, async (t) => {
  let normal = 0;
  const api = await fakeAnthropic((body) => {
    if (compactRequest(body)) return {};
    normal++;
    return { usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: normal === 1 ? 90000 : 92001 } };
  });
  const f = await nativeFixture(t, api);
  assert.equal((await f.turn("First tiny request.")).subtype, "success");
  assert.equal((await f.turn("Second tiny request.")).subtype, "success");
  assert.equal(api.requests.filter(compactRequest).length, 0);
  assert.equal((await f.turn("Third tiny request.")).subtype, "success");
  assert.deepEqual(f.childEnv(), { max: "128000", window: "128000", pct: "100" });
  assert.ok(api.requests.every((r) => r.max_tokens === 128000));
  const compact = api.requests.find(compactRequest);
  assert.ok(compact, "a 95001 cache-inclusive API input causes compaction before the next request");
  assert.equal(compact.output_config?.effort, "low");
  assert.match(JSON.stringify(compact.messages), /1500 tokens/);
  assert.ok(f.messages.some((m) => m.type === "system" && m.subtype === "compact_boundary"));
  assert.equal(api.requests.at(-1).output_config?.effort, config.effort);
});

test("isolated SDK query uses the same real wire cap and compaction controls", { timeout: 45_000 }, async (t) => {
  const api = await fakeAnthropic();
  const f = await nativeFixture(t, api, { isolated: true });
  assert.equal((await f.turn("Tiny isolated task.")).subtype, "success");
  assert.equal((await f.turn("/compact Preserve data/todos.md, keep it brief.")).subtype, "success");
  assert.equal(api.requests[0].max_tokens, 128000);
  assert.equal(api.requests.find(compactRequest)?.output_config?.effort, "low");
});

test("native subagent inherits 128K and compacts after cached input crosses 95K", { timeout: 45_000 }, async (t) => {
  const file = path.join(config.data, "native-child-fixture.txt");
  fs.mkdirSync(config.data, { recursive: true });
  fs.writeFileSync(file, "fictional child tool output\n");
  const api = await fakeAnthropic((body) => {
    if (compactRequest(body)) return {};
    const all = JSON.stringify(body.messages);
    if (!all.includes("toolu_fake_agent") && all.includes("Delegate this tiny")) return { content: [{ type: "tool_use", id: "toolu_fake_agent", name: "Agent",
      input: { subagent_type: "general-purpose", description: "local fixture", run_in_background: false, prompt: "NATIVE_CHILD_ONLY: read the tiny fixture and reply OK." } }], stop_reason: "tool_use" };
    const reads = (all.match(/toolu_fake_read_\d/g) || []).length / 2;
    if (!all.includes("Delegate this tiny") && all.includes("NATIVE_CHILD_ONLY") && reads < 3) {
      return { content: [{ type: "tool_use", id: "toolu_fake_read_" + reads, name: "Read", input: { file_path: file } }], stop_reason: "tool_use",
        usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: reads === 2 ? 92001 : 1000 } };
    }
    return {};
  });
  const f = await nativeFixture(t, api);
  assert.equal((await f.turn("Delegate this tiny local fixture to a subagent.")).subtype, "success");
  // This CLI can launch SDK subagents asynchronously even when the tool asks for foreground execution.
  const deadline = Date.now() + 5000;
  while (!api.requests.some(compactRequest) && Date.now() < deadline) await delay(25);
  assert.ok(f.messages.some((m) => m.parent_tool_use_id), "a real SDK Agent tool ran its child");
  assert.ok(api.requests.every((r) => r.max_tokens === 128000));
  assert.ok(api.requests.find(compactRequest), "the child's cached total triggers compaction in its own loop");
  assert.equal(api.requests.find(compactRequest).output_config?.effort, "low");
  assert.match(JSON.stringify(api.requests.find(compactRequest).messages), /1500 tokens/);
  assert.equal(api.requests.at(-1).output_config?.effort, config.effort, "child compaction restores the parent's effort before hand-back");
});

test("CLI prompt-too-long compaction retry trims old history and can self-rescue", { timeout: 45_000 }, async (t) => {
  let compactAttempts = 0;
  const api = await fakeAnthropic((body) => {
    if (compactRequest(body) && ++compactAttempts === 1) return { error: "prompt is too long: 200001 tokens > 200000 maximum" };
    return {};
  });
  const f = await nativeFixture(t, api);
  for (let n = 0; n < 4; n++) assert.equal((await f.turn(`Historical local message ${n}: ` + "fixture ".repeat(150))).subtype, "success");
  assert.equal((await f.turn("/compact Keep only essential context.")).subtype, "success");
  const attempts = api.requests.filter(compactRequest);
  assert.ok(attempts.length >= 2);
  assert.ok(JSON.stringify(attempts.at(-1).messages).length < JSON.stringify(attempts[0].messages).length);
  assert.ok(f.messages.some((m) => m.subtype === "compact_boundary"));
});

test("actual resumed SDK session escapes failed compaction, keeps data, hides English, and isolated jobs complete", { timeout: 45_000 }, async (t) => {
  let failCompact = false;
  const api = await fakeAnthropic((body) => compactRequest(body) && failCompact ? { stop_reason: "max_tokens" } :
    { usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 92001 } });
  const calls = [], events = [], harnesses = [];
  const dir = path.join(config.sessions, "real-recovery-fixture");
  writeJson(config.stateFile, { unrelated: "keep" });
  const todo = path.join(config.data, "recovery-todos.md");
  fs.mkdirSync(config.data, { recursive: true });
  fs.writeFileSync(todo, "待办：继续处理报价\n");
  const start = () => {
    const h = new Harness({ hub: new DeviceHub(), bus: { emit: (e) => events.push(e) }, log() {},
      queryFactory: ({ prompt, options }) => {
        calls.push({ resume: options.resume });
        return query({ prompt, options: { ...options, systemPrompt: "Local fixture, reply OK.", settingSources: [], agentProgressSummaries: false,
          permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
          env: { ...options.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-local-only", ANTHROPIC_AUTH_TOKEN: "",
            CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_TMPDIR: path.join(config.root, "native-tmp"),
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" } } });
      } });
    harnesses.push(h); h.startMain(); return h;
  };
  const close = async (h) => {
    clearTimeout(h.restartTimer);
    h.main.intentionalClose = true;
    h.main.inbox.close(); h.main.q.close(); await h.main.finished;
  };
  t.after(async () => { for (const h of harnesses) await close(h); await api.close(); });
  const until = async (predicate) => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error("local SDK fixture did not settle"); await delay(20); }
  };
  const warm = start();
  await warm.send("Remember my pending task in data/recovery-todos.md.");
  await until(() => events.some((e) => e.t === "turn_end"));
  const session = readJson(config.stateFile, {}).mainSessionId;
  await close(warm);
  failCompact = true;
  const resumed = start();
  await resumed.send("Continue my pending task.");
  await until(() => calls.length >= 3 && events.filter((e) => e.t === "turn_end").length >= 3);
  assert.equal(calls[1].resume, session, "the broken session was truly resumed by the native CLI");
  assert.equal(calls[2].resume, undefined, "failure uses a fresh native session instead of resuming the same broken history");
  assert.ok(events.some((e) => e.t === "turn_end" && e.text.includes("已重新开始对话")));
  assert.equal(JSON.stringify(events).includes("API Error"), false);
  assert.equal(JSON.stringify(events).includes("output token maximum"), false);
  assert.equal(fs.readFileSync(todo, "utf8"), "待办：继续处理报价\n");
  assert.equal(readJson(config.stateFile, {}).unrelated, "keep");
  assert.equal(fs.statSync(config.stateFile).mode & 0o777, 0o600);
  assert.equal(readJson(config.stateFile, {}).mainRecovery, undefined);
  failCompact = false;
  const job = await resumed.runIsolated("本地隔离任务", "Reply OK.");
  assert.equal(job.ok, true);
});
