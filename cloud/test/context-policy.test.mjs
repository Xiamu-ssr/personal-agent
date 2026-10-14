import test from "node:test";
import assert from "node:assert/strict";
import { contextPolicy, inputUsage } from "../src/context-policy.mjs";
import { MODELS, modelEnvironment } from "../src/app-settings.mjs";

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

test("all four settings models use a fixed 200K policy; obsolete env overrides have no effect", () => {
  for (const { id: model } of MODELS) {
    const p = contextPolicy(model, { AGENT_CONTEXT_INPUT_LIMIT: "1", AGENT_MAX_OUTPUT_TOKENS: "1" });
    assert.equal(p.canonical, model === "anthropic/claude-opus-5.5" ? "claude-opus-5-5" : "claude-haiku-5-5");
    assert.equal(p.windowTokens, 200000);
    assert.equal(p.triggerTokens, 167000);
    assert.equal(p.maxOutputTokens, 128000);
    assert.equal(p.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, "1");
    assert.equal("CLAUDE_CODE_CURRIED_TRINKET" in p.env, false);
  }
  assert.throws(() => contextPolicy("unknown"), /不支持/);
});

test("Opus model environment uses the provider id for all families, subagents and permission classifiers", () => {
  const model = "anthropic/claude-opus-5.5";
  assert.deepEqual(modelEnvironment(model), {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", CLAUDE_CODE_AUTO_MODE_MODEL: model,
    CLAUDE_CODE_BG_CLASSIFIER_MODEL: model,
  });
});

test("input usage counts cached reads/writes exactly once and takes the last server-side iteration", () => {
  assert.equal(inputUsage({ input_tokens: 1000, cache_read_input_tokens: 162000, cache_creation_input_tokens: 4000, output_tokens: 8000 }), 167000);
  assert.equal(inputUsage({ input_tokens: 999999, output_tokens: 999999, iterations: [
    { type: "message", input_tokens: 12000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 },
    { type: "message", input_tokens: 1000, cache_read_input_tokens: 163000, cache_creation_input_tokens: 3000 },
    { type: "compaction", input_tokens: 300000, output_tokens: 10 },
  ] }), 167000);
});
