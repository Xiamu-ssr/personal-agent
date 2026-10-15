import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { config } from "../src/config.mjs";
import { fakeAnthropic } from "./fake-anthropic.mjs";
import { hasInput, resultFor, textReply, toolReply } from "./native-fixture.mjs";

test("native side chats exclude main and sibling context, accept live input and resume their own session after restart", { timeout: 50_000 }, async (t) => {
  const events = [], requests = [], queries = [];
  let h, modelError, readStarted = false, releaseRead;
  const readGate = new Promise((r) => { releaseRead = r; });
  const file = path.join(config.root, "workspace/side/context.txt"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "local side fixture");
  const api = await fakeAnthropic((body) => {
    try {
      const wire = JSON.stringify(body.messages);
      const seen = { main: wire.includes("MAIN_ONLY_CONTEXT"), sideA: wire.includes("SIDE_A_ONLY_CONTEXT"), sideB: wire.includes("SIDE_B_ONLY_CONTEXT"), interjection: wire.includes("SIDE_LIVE_INPUT") };
      requests.push({ request: requests.length + 1, ...seen });
      if (seen.sideA) {
        assert.equal(seen.main, false); assert.equal(seen.sideB, false);
        if (hasInput(body, "SIDE_AFTER_RESTART")) return resultFor(body, "side_restart_say") ? textReply(" ") : toolReply("side_restart_say", "mcp__doudou__say", { text: "重启后沿着旁聊继续。" });
        if (hasInput(body, "SIDE_OPTION_REPLY")) return textReply("选项回复仍在旁聊。");
        if (!resultFor(body, "side_first_say")) return toolReply("side_first_say", "mcp__doudou__say", { text: "只在旁聊里说这句。", options: [{ label: "继续", reply: "SIDE_OPTION_REPLY" }], cards: [{ type: "link", url: "https://example.test/side", title: "旁聊资料" }] });
        if (!resultFor(body, "side_read")) return toolReply("side_read", "Read", { file_path: file });
        assert.equal(seen.interjection, true);
        return textReply("工具执行时的旁聊补充已收到。");
      }
      if (seen.sideB) { assert.equal(seen.main, false); return textReply("第二个旁聊也是独立的。"); }
      assert.equal(seen.main, true); assert.equal(seen.sideA, false); assert.equal(seen.sideB, false);
      return textReply("主聊天仍只有自己的上下文。");
    } catch (e) { modelError = e; return { error: "local side chat assertion failed" }; }
  });
  const makeHarness = () => {
    const hub = new DeviceHub();
    return new Harness({ hub, bus: { emit: (e) => events.push(e) }, log() {}, queryFactory: ({ prompt, options }) => {
      queries.push({ main: options.perTaskStopAffordance, resume: options.resume ?? null });
      return query({ prompt, options: { ...options, systemPrompt: "Local fixture. Use the say tool for speech.", settingSources: [], agentProgressSummaries: false,
        permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
        hooks: { ...options.hooks, PreToolUse: [...options.hooks.PreToolUse, { matcher: "Read", hooks: [async (input) => { if (input.tool_use_id === "side_read") { readStarted = true; await readGate; } return {}; }] }] },
        env: { ...options.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-side-chats-only", ANTHROPIC_AUTH_TOKEN: "",
          CLAUDE_CODE_TMPDIR: path.join(config.root, "side-tmp"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" } } });
    } });
  };
  const until = async (predicate) => { const end = Date.now() + 15_000; while (!predicate()) { if (modelError) throw modelError; if (Date.now() > end) throw new Error("native side chat timed out"); await delay(10); } };
  t.after(async () => { releaseRead(); await h?.close(); await api.close(); });
  h = makeHarness(); h.startMain();
  await h.send("MAIN_ONLY_CONTEXT"); await until(() => !h.busy);
  const mainSession = h.main.sessionId, mainHistory = h.speech.history();
  const id = await h.createSideChat("SIDE_A_ONLY_CONTEXT"); await until(() => readStarted);
  assert.equal(h.busy, false);
  await h.sendTask(id, "SIDE_LIVE_INPUT"); await delay(200); releaseRead();
  await h.jobChain; if (modelError) throw modelError;
  const sideSession = h.history.get(id).sessionId; assert.notEqual(sideSession, mainSession);
  const bubble = h.taskHistory(id).messages.find((m) => m.options?.length);
  assert.equal(bubble.cards[0].title, "旁聊资料");
  assert.equal(h.taskHistory(id).messages.some((m) => m.text === "工具执行时的旁聊补充已收到。"), false);
  assert.ok(h.taskHistory(id).items.some((i) => i.text === "工具执行时的旁聊补充已收到。"));
  await h.chooseOption(bubble.id, "0", id); await h.jobChain;
  assert.equal(queries.at(-1).resume, sideSession); assert.equal(h.taskHistory(id).messages.find((m) => m.id === bubble.id).optionsUsed, true);
  assert.equal(h.taskHistory(id).messages.at(-1).text, "选项回复仍在旁聊。"); assert.equal(h.taskHistory(id).messages.at(-1).fallback, true);
  const sibling = await h.createSideChat("SIDE_B_ONLY_CONTEXT"); await h.jobChain;
  assert.notEqual(h.history.get(sibling).sessionId, sideSession); assert.equal(queries.at(-1).resume, null);
  assert.deepEqual(h.speech.history(), mainHistory);
  await h.close();
  h = makeHarness(); h.startMain();
  assert.equal(h.taskHistory(id).messages.find((m) => m.id === bubble.id).optionsUsed, true);
  await assert.rejects(h.chooseOption(bubble.id, "0", id), (e) => e.status === 409);
  await h.sendTask(id, "SIDE_AFTER_RESTART"); await h.jobChain;
  assert.equal(queries.at(-1).resume, sideSession); assert.equal(h.history.get(id).sessionId, sideSession);
  assert.equal(h.taskHistory(id).messages.at(-1).text, "重启后沿着旁聊继续。");
  assert.deepEqual(h.speech.history(), mainHistory);
  await h.send("MAIN_CONTINUE"); await until(() => !h.busy);
  assert.ok(requests.at(-1).main); assert.equal(requests.at(-1).sideA, false); assert.equal(requests.at(-1).sideB, false);
  if (modelError) throw modelError;
  const evidence = { ok: true, independentSessions: 3, sideMessages: h.taskHistory(id).messages.length,
    sideOptionsUsed: true, liveInputReachedModel: requests.some((r) => r.sideA && r.interjection),
    resumedOwnSessionBeforeAndAfterRestart: true, mainAndSiblingContextExcluded: true,
    sideEmittedMainSay: events.some((e) => e.t === "say" && [id, sibling].includes(e.activityId)), requests };
  assert.equal(evidence.sideEmittedMainSay, false);
  if (process.env.AGENT_SIDE_CHAT_DEMO_DIR) {
    const dir = process.env.AGENT_SIDE_CHAT_DEMO_DIR; fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(evidence, null, 2) + "\n");
    fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  console.log("side-chat evidence:", JSON.stringify(evidence));
});
