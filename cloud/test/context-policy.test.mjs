import test from "node:test";
import assert from "node:assert/strict";
import { canonicalModel, contextPolicy, inputUsage } from "../src/context-policy.mjs";

test("100K input target has 5K headroom; CLI output and summary reserves yield a 95K trigger", () => {
  const p = contextPolicy("anthropic/claude-haiku-5.5", {});
  assert.equal(p.canonical, "claude-haiku-5-5");
  assert.equal(p.maxOutputTokens, 128000);
  assert.equal(p.windowTokens, 128000);
  const effective = p.windowTokens - Math.min(p.maxOutputTokens, 20000);
  assert.equal(Math.min(Math.floor(effective * Number(p.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) / 100), effective - 13000), 95000);
  assert.equal(p.inputLimit - p.triggerTokens, 5000);
  assert.equal(p.env.DISABLE_AUTO_COMPACT, "0");
});

test("model changes select normal Messages limits and preserve the input trigger", () => {
  for (const [model, limit] of [["claude-haiku-4-5", 64000], ["provider/claude-opus-4.1", 32000], ["claude-3-5-haiku-20241022", 8192]]) {
    const p = contextPolicy(model, {});
    assert.equal(p.maxOutputTokens, limit);
    assert.equal(p.windowTokens - Math.min(limit, 20000) - 13000, 95000);
  }
  assert.equal(canonicalModel("anthropic/claude-opus-5.5"), "claude-opus-5-5");
  assert.throws(() => contextPolicy("unknown", {}), /显式设置/);
  assert.throws(() => contextPolicy("claude-haiku-5-5", { AGENT_MAX_OUTPUT_TOKENS: "300000" }), /Messages 上限/);
  assert.equal(contextPolicy("claude-haiku-5-5", { AGENT_MAX_OUTPUT_TOKENS: "64000" }).maxOutputTokens, 64000);
});

test("input usage counts cached reads/writes exactly once and takes the last server-side iteration", () => {
  assert.equal(inputUsage({ input_tokens: 1000, cache_read_input_tokens: 90000, cache_creation_input_tokens: 4000, output_tokens: 8000 }), 95000);
  assert.equal(inputUsage({ input_tokens: 999999, output_tokens: 999999, iterations: [
    { type: "message", input_tokens: 12000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 },
    { type: "message", input_tokens: 1000, cache_read_input_tokens: 91000, cache_creation_input_tokens: 3000 },
    { type: "compaction", input_tokens: 300000, output_tokens: 10 },
  ] }), 95000);
});
