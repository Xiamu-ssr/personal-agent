import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const flag = process.argv.indexOf("--output"), output = path.resolve(flag < 0 ? "/tmp/v081-cloud-demo/prompt" : process.argv[flag + 1]);
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, "root-"));
Object.assign(process.env, { AGENT_ROOT: root, AGENT_TOKEN: "fake-prompt-demo-token", AGENT_BROWSER_SERVICE: "", AGENT_ACTIVITY_SUMMARIES: "0" });
const [{ query }, { Harness }, { DeviceHub }, { config }, { putAppSettings }, { activitySummary }, { fakeAnthropic, compactRequest }, fixture] = await Promise.all([
  import("@anthropic-ai/claude-agent-sdk"), import("../src/agent.mjs"), import("../src/devices.mjs"), import("../src/config.mjs"), import("../src/app-settings.mjs"),
  import("../src/activity-summary.mjs"), import("../test/fake-anthropic.mjs"), import("../test/native-fixture.mjs"),
]);
const { hasInput, toolReply, textReply, resultFor, isFork } = fixture;
const oldModel = "z-ai/glm-5.3-flash", newModel = "anthropic/claude-opus-5.5";
putAppSettings(root, { model: { provider: "zenmux", id: oldModel }, permissionMode: "bypassPermissions" });
const skill = path.join(root, ".claude/skills/v081-prompt-probe"), file = path.join(root, "workspace/probe.txt");
fs.mkdirSync(skill, { recursive: true }); fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: v081-prompt-probe\ndescription: Local skill for verifying custom system prompt support.\n---\nV081_SKILL_BODY: Read the local fixture before replying.\n");
fs.writeFileSync(file, "Local prompt and model fixture.");
const events = [], wire = [], stops = [], optionsUsed = [];
let h, failure, readStarted = false, releaseRead;
const readGate = new Promise((resolve) => { releaseRead = resolve; });
const api = await fakeAnthropic((body) => {
  try {
    if (body.max_tokens === 1024) return textReply(JSON.stringify({ title: "检查提示词拼接", summary: "核实提示词与模型切换" }));
    if (compactRequest(body)) return textReply("<summary>V081_PROMPT_SUMMARY: Continue the local prompt fixture.</summary>");
    if (isFork(body)) return textReply("V081_FORK_RESULT");
    if (hasInput(body, "[动态] V081_PROMPT_FEED")) return textReply("后台过程正文。");
    if (hasInput(body, "V081_LIVE_MODEL")) {
      if (!resultFor(body, "live_read")) return toolReply("live_read", "Read", { file_path: file });
      return resultFor(body, "live_say") ? textReply("切换后继续完成了。") : toolReply("live_say", "mcp__doudou__say", { text: "切换后继续完成了。" });
    }
    if (!resultFor(body, "prompt_skill")) return toolReply("prompt_skill", "Skill", { skill: "v081-prompt-probe" });
    if (!resultFor(body, "prompt_agent")) return toolReply("prompt_agent", "Agent", { subagent_type: "fork", description: "检查提示词", run_in_background: true, prompt: "V081_PROMPT_CHILD: Finish the tiny local fixture." });
    if (!resultFor(body, "prompt_say")) return toolReply("prompt_say", "mcp__doudou__say", { text: "提示词已检查。" });
    if (JSON.stringify(body.messages).includes("你最后写的这段正文用户看不到")) return resultFor(body, "prompt_repair") ? textReply("补充检查也完成了。") : toolReply("prompt_repair", "mcp__doudou__say", { text: "补充检查也完成了。" });
    return textReply("这段正文需要 Stop 提醒再用说话发出。");
  } catch (e) { failure = e; return { error: "local prompt fixture failed" }; }
});
try {
  h = new Harness({ hub: new DeviceHub(), bus: { emit: (e) => events.push(e) }, log() {},
    queryFactory: ({ prompt, options }) => {
      optionsUsed.push(options);
      return query({ prompt, options: { ...options, agentProgressSummaries: false,
        hooks: { ...options.hooks,
          PreToolUse: [...options.hooks.PreToolUse, { matcher: "Read", hooks: [async (input) => { if (input.tool_use_id === "live_read") { readStarted = true; await readGate; } return {}; }] }],
          ...(options.hooks.Stop && { Stop: [{ hooks: [async (input) => { const result = await options.hooks.Stop[0].hooks[0](input); stops.push({ active: input.stop_hook_active, decision: result.decision || "allow" }); return result; }] }] }),
        }, env: { ...options.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-prompt-api-key", ANTHROPIC_AUTH_TOKEN: "",
          CLAUDE_CONFIG_DIR: config.sessions, CLAUDE_CODE_TMPDIR: path.join(root, "native-tmp"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
      } });
    } });
  const receive = h.onMainMessage.bind(h); h.onMainMessage = (m, main) => { wire.push(m); receive(m, main); };
  h.startMain();
  const until = async (predicate) => { const deadline = Date.now() + 25_000; while (!predicate()) { if (failure) throw failure; if (Date.now() > deadline) throw new Error("prompt fixture timed out: " + JSON.stringify(wire.slice(-6).map((m) => ({ type: m.type, subtype: m.subtype, state: m.state, errors: m.errors })))); await delay(10); } };
  const turn = async (text) => { const count = wire.filter((m) => m.type === "result").length; await h.send(text); await until(() => wire.filter((m) => m.type === "result").length > count && !h.busy); };
  await turn("V081_PROMPT_FEATURES: Invoke the local skill, fork, and say.");
  await until(() => wire.some((m) => m.subtype === "task_notification" && m.status === "completed") && !h.busy);
  const first = api.requests.find((b) => b.max_tokens === 128000), custom = optionsUsed[0].systemPrompt;
  assert.equal(typeof custom, "string"); assert.ok(first.system.some((b) => b.text === custom));
  assert.ok(JSON.stringify(first).includes("v081-prompt-probe"), "project skill is listed with the custom system prompt");
  assert.notEqual(resultFor(api.requests.find((b) => resultFor(b, "prompt_skill")), "prompt_skill").is_error, true);
  const fork = api.requests.find((b) => b.max_tokens === 128000 && isFork(b)); assert.ok(fork.system.some((b) => b.text === custom));
  assert.ok(first.tools.some((tool) => tool.name === "Agent"));
  assert.ok(stops.some((s) => s.decision === "block")); assert.ok(stops.some((s) => s.active));
  assert.ok(JSON.stringify(first.messages).includes("当前时间："));
  await turn("/compact Keep essential local fixture context.");
  const compact = api.requests.find(compactRequest); assert.ok(compact); assert.equal(compact.model, oldModel);
  assert.equal(compact.output_config.effort, "low"); assert.ok(wire.some((m) => m.subtype === "compact_boundary"));
  await h.send("V081_LIVE_MODEL: read then reply."); await until(() => readStarted);
  const before = api.requests.length;
  putAppSettings(root, { model: { provider: "zenmux", id: newModel } }); await h.settingsChanged();
  releaseRead(); await until(() => !h.busy);
  const next = api.requests.slice(before); assert.ok(next.length); assert.ok(next.every((b) => b.model === newModel));
  assert.equal(h.main.sessionId, wire.find((m) => m.subtype === "init").session_id);
  await h.runIsolated("动态", "[动态] V081_PROMPT_FEED");
  const feed = api.requests.find((b) => b.max_tokens === 128000 && hasInput(b, "[动态] V081_PROMPT_FEED")); assert.equal(feed.model, newModel);
  fs.writeFileSync(path.join(output, "feed-system.json"), JSON.stringify(feed.system, null, 2) + "\n");
  assert.ok(feed.system.some((b) => b.text === custom));
  await activitySummary({ title: "处理中", steps: [{ kind: "prompt", text: "检查提示词" }] }, { env: { ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-prompt-summary" } });
  assert.equal(api.requests.at(-1).model, newModel);
  const system = first.system.map((b) => b.text).join("\n\n");
  const result = { ok: true, sdk: "0.3.295", customLength: custom.length, systemLength: system.length, systemUtf8Bytes: Buffer.byteLength(system), first300: [...system].slice(0, 300).join(""),
    systemBlocks: first.system.map((b) => ({ length: b.text.length, custom: b.text === custom, ...(!b.text.includes(custom) && { text: b.text }) })),
    features: { skills: true, agentFork: true, compaction: true, hooks: true, mcp: true }, stops, liveModels: { before: oldModel, after: next.map((b) => b.model), feed: feed.model, summary: api.requests.at(-1).model },
    queries: optionsUsed.length, cacheStable: optionsUsed.every((o) => o.systemPrompt === custom) };
  fs.writeFileSync(path.join(output, "system.json"), JSON.stringify(first.system, null, 2) + "\n");
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(result, null, 2) + "\n");
  fs.writeFileSync(path.join(output, "requests.json"), JSON.stringify(api.requests.map((r) => ({ model: r.model, compact: compactRequest(r), fork: isFork(r), max_tokens: r.max_tokens })), null, 2) + "\n");
  console.log(JSON.stringify(result));
} finally { releaseRead(); await h?.close(); await api.close(); }
