// Audited against Agent SDK 0.3.295 / bundled Claude Code 2.1.295.
// The CLI's window is NOT its input trigger: p5() reserves output, $Y() reserves a summary.
export const CLI_OUTPUT_RESERVE = 20_000;
export const CLI_SUMMARY_RESERVE = 13_000;
// Non-Opus built-ins share the CLI's Haiku profile; provider IDs remain unchanged on the wire.
export const CLI_MODEL_PROFILE = "claude-haiku-5-5";
export const CLI_MODEL_OVERRIDES = { "claude-opus-5-5": "anthropic/claude-opus-5.5" };
const PRODUCT_MODELS = new Set(["anthropic/claude-haiku-5.5", "anthropic/claude-opus-5.5", "z-ai/glm-5.3-flash", "z-ai/glm-5.3-flashx", "xiaomi/mimo-v2.6-pro"]);

export function contextPolicy(model, { custom = false } = {}) {
  if (!custom && !PRODUCT_MODELS.has(model)) throw new Error("不支持的模型");
  const maxOutputTokens = custom ? 8192 : 128_000;
  // Built-in providers advertise >= 1M context. Custom services do not declare a window.
  const triggerTokens = custom ? 100_000 : 272_000;
  // The CLI subtracts these reserves before testing the estimated next input.
  // A 305K policy window therefore triggers at 272K, not at 239K.
  const windowTokens = triggerTokens + Math.min(maxOutputTokens, CLI_OUTPUT_RESERVE) + CLI_SUMMARY_RESERVE;
  return {
    canonical: custom ? undefined : model === CLI_MODEL_OVERRIDES["claude-opus-5-5"] ? "claude-opus-5-5" : CLI_MODEL_PROFILE, maxOutputTokens,
    inputLimit: triggerTokens + 5000, toolHeadroom: 5000, outputReserve: CLI_OUTPUT_RESERVE,
    summaryReserve: CLI_SUMMARY_RESERVE, windowTokens, triggerTokens,
    env: {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(windowTokens),
      CLAUDE_CODE_DISABLE_1M_CONTEXT: custom ? "1" : "0",
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
