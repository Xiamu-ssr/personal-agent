import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { activitySummary, parseActivitySummary } from "../src/activity-summary.mjs";
import { putAppSettings } from "../src/app-settings.mjs";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { config } from "../src/config.mjs";
import { fakeAnthropic } from "./fake-anthropic.mjs";
import { textReply } from "./native-fixture.mjs";
import { queryFixture } from "./query-fixture.mjs";

test("activity summaries use the current selected model on every call and include prompts, tools and say only", async (t) => {
  let selected = "z-ai/glm-5.3-flash";
  putAppSettings(config.root, { model: { provider: "zenmux", id: "z-ai/glm-5.3-flash" } });
  const api = await fakeAnthropic((body) => {
    assert.equal(body.model, selected); assert.equal(body.stream, undefined); assert.equal(body.tools, undefined);
    assert.equal(body.thinking.type, "adaptive"); assert.equal(body.output_config.effort, "low");
    const context = JSON.stringify(body.messages);
    for (const phrase of ["帮我查注册条件", "Read 注册说明", "虚拟号有限制"]) assert.ok(context.includes(phrase));
    assert.equal(context.includes("内部念叨"), false);
    return textReply(JSON.stringify({ title: "注册手机号问题", summary: "查询注册条件并解释了虚拟号码限制" }));
  }); t.after(() => api.close());
  const record = { title: "处理中", steps: [
    { kind: "prompt", text: "帮我查注册条件" }, { kind: "tool", text: "Read 注册说明" },
    { kind: "text", text: "内部念叨" }, { kind: "text", speech: true, text: "虚拟号有限制" },
  ] };
  const opts = { env: { ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-summary-key" } };
  const value = await activitySummary(record, opts);
  assert.equal(value.title, "注册手机号问题");
  selected = "anthropic/claude-opus-5.5"; putAppSettings(config.root, { model: { provider: "zenmux", id: selected } });
  assert.equal((await activitySummary(record, opts)).title, value.title);
  for (const raw of ['{}', '{"title":"English","summary":"中文摘要"}', JSON.stringify({ title: "长".repeat(15), summary: "中文摘要" }), JSON.stringify({ title: "中文", summary: "长".repeat(41) })]) assert.throws(() => parseActivitySummary(raw));
});

test("failed asynchronous summaries retain the temporary title and finished process across restart", async (t) => {
  fs.rmSync(path.join(config.system, "activity-index.json"), { force: true });
  const calls = [], events = [];
  const h = new Harness({ hub: new DeviceHub(), bus: { emit: (e) => events.push(e) }, log() {}, queryFactory: queryFixture(calls), summarize: async () => { throw new Error("local summary failure"); } });
  h.startMain(); t.after(() => h.close()); await h.send("查询资料"); const id = h.main.activityId;
  calls[0].emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } });
  calls[0].emit({ type: "result", subtype: "success" }); await tick(); await Promise.all([...h.summaryJobs]);
  assert.equal(h.recentJobs()[0].title, "处理中"); assert.equal(h.recentJobs()[0].summary, "");
  assert.equal(events.some((e) => e.phase === "updated"), false);
  const second = new Harness({ hub: new DeviceHub(), bus: { emit() {} }, log() {}, queryFactory: queryFixture([]) }); t.after(() => second.close());
  assert.equal(second.recentJobs()[0].id, id); assert.ok(second.taskHistory(id).items.length);
});

test("automatic side titles use the model selected at completion and explicit titles stay unchanged", async (t) => {
  fs.rmSync(path.join(config.system, "activity-index.json"), { force: true });
  const calls = [], events = [];
  const api = await fakeAnthropic((body) => {
    assert.equal(body.model, "anthropic/claude-opus-5.5");
    return textReply(JSON.stringify({ title: "安排读书时间", summary: "讨论了本周的读书安排" }));
  });
  const h = new Harness({ hub: new DeviceHub(), bus: { emit: (e) => events.push(e) }, log() {}, queryFactory: queryFixture(calls),
    summarize: (record, opts) => activitySummary(record, { ...opts, env: { ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "fake-side-summary-key" } }) });
  t.after(async () => { await h.close(); await api.close(); });
  putAppSettings(config.root, { model: { provider: "zenmux", id: "z-ai/glm-5.3-flash" } });
  const id = await h.createSideChat("本周怎么安排读书？"); await tick();
  putAppSettings(config.root, { model: { provider: "zenmux", id: "anthropic/claude-opus-5.5" } });
  calls[0].emit({ type: "result", subtype: "success" }); await h.jobChain; await Promise.all([...h.summaryJobs]);
  assert.equal(h.history.get(id).title, "安排读书时间");
  assert.ok(events.some((e) => e.t === "activity" && e.phase === "updated" && e.id === id && e.summary === "讨论了本周的读书安排"));
  const custom = await h.createSideChat("还有别的安排", [], "我的旁聊"); await tick();
  calls[1].emit({ type: "result", subtype: "success" }); await h.jobChain; await Promise.all([...h.summaryJobs]);
  assert.equal(h.history.get(custom).title, "我的旁聊"); assert.equal(api.requests.length, 1);
});
