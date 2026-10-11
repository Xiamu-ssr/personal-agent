import test from "node:test";
import assert from "node:assert/strict";
import { canonicalModel, contextPolicy, inputUsage } from "../src/context-policy.mjs";

test("200K CLI window reserves 20K output and 13K summary for a 167K trigger", () => {
  const p = contextPolicy("anthropic/claude-haiku-5.5", {});
  assert.equal(p.canonical, "claude-haiku-5-5");
  assert.equal(p.maxOutputTokens, 128000);
  assert.equal(p.windowTokens, 200000);
  const effective = p.windowTokens - Math.min(p.maxOutputTokens, 20000);
  assert.equal(Math.min(Math.floor(effective * Number(p.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) / 100), effective - 13000), 167000);
  assert.equal(p.inputLimit - p.triggerTokens, 5000);
  assert.equal(p.env.DISABLE_AUTO_COMPACT, "0");
});

test("model changes select normal Messages limits and preserve the input trigger", () => {
  for (const [model, limit] of [["claude-haiku-4-5", 64000], ["provider/claude-opus-4.1", 32000], ["claude-3-5-haiku-20241022", 8192]]) {
    const p = contextPolicy(model, {});
    assert.equal(p.maxOutputTokens, limit);
    assert.equal(p.windowTokens - Math.min(limit, 20000) - 13000, 167000);
  }
  assert.equal(canonicalModel("anthropic/claude-opus-5.5"), "claude-opus-5-5");
  assert.throws(() => contextPolicy("unknown", {}), /显式设置/);
  assert.throws(() => contextPolicy("claude-haiku-5-5", { AGENT_MAX_OUTPUT_TOKENS: "300000" }), /Messages 上限/);
  assert.equal(contextPolicy("claude-haiku-5-5", { AGENT_MAX_OUTPUT_TOKENS: "64000" }).maxOutputTokens, 64000);
});

test("v0.4 defaults cannot be silently clamped above 200K and invalid explicit budgets fail at startup", () => {
  const p = contextPolicy("anthropic/claude-haiku-5.5", {});
  assert.equal(p.inputLimit, 172000);
  assert.equal(p.toolHeadroom, 5000);
  assert.equal(p.outputReserve, 20000);
  assert.equal(p.summaryReserve, 13000);
  assert.equal(p.triggerTokens, 167000);
  assert.equal(p.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
  assert.throws(() => contextPolicy("claude-haiku-5-5", { AGENT_CONTEXT_INPUT_LIMIT: "172001" }), /CLI 窗口/);
  assert.throws(() => contextPolicy("claude-haiku-5-5", { AGENT_CONTEXT_HEADROOM: "172000" }), /正的触发点/);
});

test("input usage counts cached reads/writes exactly once and takes the last server-side iteration", () => {
  assert.equal(inputUsage({ input_tokens: 1000, cache_read_input_tokens: 162000, cache_creation_input_tokens: 4000, output_tokens: 8000 }), 167000);
  assert.equal(inputUsage({ input_tokens: 999999, output_tokens: 999999, iterations: [
    { type: "message", input_tokens: 12000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 },
    { type: "message", input_tokens: 1000, cache_read_input_tokens: 163000, cache_creation_input_tokens: 3000 },
    { type: "compaction", input_tokens: 300000, output_tokens: 10 },
  ] }), 167000);
});
