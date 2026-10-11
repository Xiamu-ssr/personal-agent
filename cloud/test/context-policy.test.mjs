import test from "node:test";
import assert from "node:assert/strict";
import { contextPolicy, inputUsage } from "../src/context-policy.mjs";

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

test("only the three settings models use a fixed 200K policy; obsolete env overrides have no effect", () => {
  for (const model of ["anthropic/claude-haiku-5.5", "xiaomi/mimo-v2.6-pro", "z-ai/glm-5.3-flashx"]) {
    const p = contextPolicy(model, { AGENT_CONTEXT_INPUT_LIMIT: "1", AGENT_MAX_OUTPUT_TOKENS: "1" });
    assert.equal(p.windowTokens, 200000);
    assert.equal(p.triggerTokens, 167000);
    assert.equal(p.maxOutputTokens, 128000);
    assert.equal(p.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, "1");
    assert.equal("CLAUDE_CODE_CURRIED_TRINKET" in p.env, false);
  }
  assert.throws(() => contextPolicy("unknown"), /不支持/);
});

test("input usage counts cached reads/writes exactly once and takes the last server-side iteration", () => {
  assert.equal(inputUsage({ input_tokens: 1000, cache_read_input_tokens: 162000, cache_creation_input_tokens: 4000, output_tokens: 8000 }), 167000);
  assert.equal(inputUsage({ input_tokens: 999999, output_tokens: 999999, iterations: [
    { type: "message", input_tokens: 12000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 },
    { type: "message", input_tokens: 1000, cache_read_input_tokens: 163000, cache_creation_input_tokens: 3000 },
    { type: "compaction", input_tokens: 300000, output_tokens: 10 },
  ] }), 167000);
});
