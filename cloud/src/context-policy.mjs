// Audited against Agent SDK 0.3.295 / bundled Claude Code 2.1.295.
// The CLI's window is NOT its input trigger: p5() reserves output, $Y() reserves a summary.
export const CLI_OUTPUT_RESERVE = 20_000;
export const CLI_SUMMARY_RESERVE = 13_000;
export const COMPACT_INSTRUCTIONS = "请用精炼的中文整理上下文，目标不超过 1500 tokens。保留用户目标、重要决定及原因、对话历史要点、未完成事项、必要的文件路径和记忆检索线索；尤其保留 data/ 中的记忆和待办指针。省略重复对话、长工具输出、代码全文和思考过程。不要执行任务或回答历史问题，只生成供后续对话继续使用的摘要。";

// Normal Messages limits from the installed CLI catalog, not Batch limits.
const OUTPUT_LIMITS = {
  "claude-haiku-5-5": 128_000, "claude-haiku-4-5": 64_000, "claude-3-5-haiku": 8192,
  "claude-sonnet-5-5": 128_000, "claude-sonnet-5": 128_000,
  "claude-sonnet-4-6": 128_000, "claude-sonnet-4-5": 64_000, "claude-sonnet-4-0": 64_000,
  "claude-3-7-sonnet": 64_000, "claude-3-5-sonnet": 8192,
  "claude-opus-5-5": 128_000, "claude-opus-5": 128_000,
  "claude-opus-4-8": 128_000, "claude-opus-4-7": 128_000, "claude-opus-4-6": 128_000,
  "claude-opus-4-5": 64_000, "claude-opus-4-1": 32_000, "claude-opus-4-0": 32_000,
  "claude-fable-5-1": 128_000, "claude-fable-5": 128_000,
  "claude-mythos-5-1": 128_000, "claude-mythos-5": 128_000,
  "claude-3-opus": 4096, "claude-3-haiku": 4096, "claude-3-sonnet": 8192,
};

export function canonicalModel(model) {
  const normalized = model.toLowerCase().replace(/(\d)\.(\d)/g, "$1-$2");
  return Object.keys(OUTPUT_LIMITS).sort((a, b) => b.length - a.length)
    .find((id) => normalized.includes(id) && !/\d/.test(normalized[normalized.indexOf(id) + id.length] || ""));
}

function integer(value, fallback, name) {
  const n = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} 必须是正整数`);
  return n;
}

export function contextPolicy(model, env = process.env) {
  const canonical = env.AGENT_MODEL_CANONICAL || canonicalModel(model);
  const supported = OUTPUT_LIMITS[canonical];
  const maxOutputTokens = integer(env.AGENT_MAX_OUTPUT_TOKENS, supported, "AGENT_MAX_OUTPUT_TOKENS（未知模型需要显式设置）");
  if (supported && maxOutputTokens > supported) throw new Error(`AGENT_MAX_OUTPUT_TOKENS 超过 ${canonical} 的 Messages 上限 ${supported}`);
  // Unknown CLI models are capped at 128K. Don't claim that a higher env value took effect.
  if (!supported && maxOutputTokens > 128_000) throw new Error("未知模型的 CLI 输出上限是 128000；请设置 AGENT_MODEL_CANONICAL 或升级模型能力配置");
  const inputLimit = integer(env.AGENT_CONTEXT_INPUT_LIMIT, 100_000, "AGENT_CONTEXT_INPUT_LIMIT");
  const toolHeadroom = integer(env.AGENT_CONTEXT_HEADROOM, 5000, "AGENT_CONTEXT_HEADROOM");
  const outputReserve = Math.min(maxOutputTokens, CLI_OUTPUT_RESERVE);
  const triggerTokens = inputLimit - toolHeadroom;
  const windowTokens = triggerTokens + outputReserve + CLI_SUMMARY_RESERVE;
  if (triggerTokens <= 0 || windowTokens < 100_000 || windowTokens > 200_000) {
    throw new Error("压缩策略需要正的触发点和 100000–200000 的 CLI 窗口（保证兼容已知模型）");
  }
  return {
    canonical, maxOutputTokens, inputLimit, toolHeadroom, outputReserve,
    summaryReserve: CLI_SUMMARY_RESERVE, windowTokens, triggerTokens,
    env: {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(windowTokens),
      // 100 means min(effectiveWindow, effectiveWindow - 13000), NOT "wait until full".
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "100",
      CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: "0",
      // Built-in concise summary shape, without the control template's separate <analysis> essay.
      CLAUDE_CODE_CURRIED_TRINKET: "short",
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
