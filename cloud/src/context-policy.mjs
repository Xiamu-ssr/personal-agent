// Audited against Agent SDK 0.3.295 / bundled Claude Code 2.1.295.
// The CLI's window is NOT its input trigger: p5() reserves output, $Y() reserves a summary.
export const CLI_OUTPUT_RESERVE = 20_000;
export const CLI_SUMMARY_RESERVE = 13_000;
// Haiku and GLM share a CLI profile. The dotted Opus id otherwise resolves to Opus 5 in this CLI.
export const CLI_MODEL_PROFILE = "claude-haiku-5-5";
export const CLI_MODEL_OVERRIDES = { "claude-opus-5-5": "anthropic/claude-opus-5.5" };
const PRODUCT_MODELS = new Set(["anthropic/claude-haiku-5.5", "anthropic/claude-opus-5.5", "z-ai/glm-5.3-flash", "z-ai/glm-5.3-flashx"]);

export function contextPolicy(model) {
  if (!PRODUCT_MODELS.has(model)) throw new Error("不支持的模型");
  return {
    canonical: model === CLI_MODEL_OVERRIDES["claude-opus-5-5"] ? "claude-opus-5-5" : CLI_MODEL_PROFILE, maxOutputTokens: 128_000,
    inputLimit: 172_000, toolHeadroom: 5000, outputReserve: CLI_OUTPUT_RESERVE,
    summaryReserve: CLI_SUMMARY_RESERVE, windowTokens: 200_000, triggerTokens: 167_000,
    env: {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "128000",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
      CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "100",
      CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: "0",
      DISABLE_COMPACT: "0", DISABLE_AUTO_COMPACT: "0",
    },
  };
}

// API input already includes system prompt and tool schemas. Do not add them or cache tokens twice.
// Server-side tool loops report summed usage + iterations; only the last model iteration is the window.
export function inputUsage(usage = {}) {
  const iterations = usage.iterations;
  const last = Array.isArray(iterations) && iterations.findLast((it) => ["message", "fallback_message"].includes(it.type));
  const u = last || usage;
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}
