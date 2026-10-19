// One catalog feeds both apps and the native OpenClaw model definitions.
// Credentials belong to configured accounts, never to these templates.
const model = (id, name, { vision = false, reasoning = false, contextWindow = 131072, maxTokens = 8192, ...rest } = {}) =>
  ({ id, name, note: vision ? '图片 · 对话 · 工具' : '对话 · 工具', input: vision ? ['text', 'image'] : ['text'], reasoning, contextWindow, maxTokens, ...rest });
const vision = { vision: true, reasoning: true };
export const COMPACT_AT_TOKENS = 272_000;
// OpenClaw 2026.10.4 reserves 20K inside its active context budget for compaction.
// Keep that operating budget separate from the provider's native model window.
const COMPACTION_RESERVE_TOKENS = 20_000;

export const PROVIDER_PRESETS = [
  {
    id: 'siliconflow', name: '硅基流动', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1',
    hint: '已预填常用模型，可以增删。', docsUrl: 'https://docs.siliconflow.cn/docs/api/chat-completions-post',
    models: [
      model('deepseek-ai/DeepSeek-V4.1-Flash', 'DeepSeek V4.1 Flash', { ...vision, contextWindow: 1048576 }),
      model('zai-org/GLM-5.3-Flash', 'GLM 5.3 Flash', { ...vision, contextWindow: 1048576 }),
      model('Qwen/Qwen3.6-35B-A3B', 'Qwen 3.6 35B A3B', vision),
      model('Qwen/Qwen3.6-27B', 'Qwen 3.6 27B', vision),
      model('Qwen/Qwen3.5-35B-A3B', 'Qwen 3.5 35B A3B', vision),
      model('Qwen/Qwen3.5-9B', 'Qwen 3.5 9B', vision),
      model('Qwen/Qwen3.5-4B', 'Qwen 3.5 4B', vision),
      model('Qwen/Qwen3-VL-8B-Instruct', 'Qwen 3 VL 8B', { vision: true }),
      model('moonshotai/Kimi-K2.7-Code', 'Kimi K2.7 Code', vision),
      model('zai-org/GLM-5.3', 'GLM 5.3', { reasoning: true, contextWindow: 1048576 }),
    ],
  },
  {
    id: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1',
    hint: 'DeepSeek 官方 API。', docsUrl: 'https://api-docs.deepseek.com/news/news260910/',
    models: [model('deepseek-flash', 'DeepSeek V4.1 Flash', { ...vision, contextWindow: 1000000 })],
  },
  {
    id: 'zhipu', name: '智谱', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    hint: '标准 API；Coding Plan 请改用套餐专属地址。', docsUrl: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3',
    models: [model('glm-5.3-flash', 'GLM 5.3 Flash', vision), model('glm-5.3-flashx', 'GLM 5.3 FlashX', vision), model('glm-5.3', 'GLM 5.3', { reasoning: true })],
  },
  {
    id: 'qwen', name: '阿里云百炼', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    hint: '北京地域 API；其他地域或 Token Plan 请修改地址。', docsUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    models: [model('qwen3.6-flash', 'Qwen 3.6 Flash', vision), model('qwen3.8-flash', 'Qwen 3.8 Flash', vision), model('qwen3.7-plus', 'Qwen 3.7 Plus', vision), model('qwen3.8-max', 'Qwen 3.8 Max', vision)],
  },
  {
    id: 'kimi', name: 'Kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1',
    hint: 'Kimi 国内开放平台 API。', docsUrl: 'https://platform.kimi.com/docs/get-api-key',
    models: [model('kimi-k3', 'Kimi K3', vision), model('kimi-k2.7-code-highspeed', 'Kimi K2.7 Code 高速版', vision), model('kimi-k2.6', 'Kimi K2.6', vision)],
  },
  {
    id: 'minimax', name: 'MiniMax', protocol: 'openai', baseUrl: 'https://api.minimax.cn/v1',
    hint: 'MiniMax 国内 API。', docsUrl: 'https://platform.minimax.cn/docs/api-reference/text-openai-api',
    models: [model('MiniMax-M3.1-Flash', 'MiniMax M3.1 Flash', vision), model('MiniMax-M3', 'MiniMax M3', vision), model('MiniMax-M2.7', 'MiniMax M2.7', { reasoning: true })],
  },
  {
    id: 'doubao', name: '火山方舟 · 豆包', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    hint: '标准 API；先在方舟开通对应模型。', docsUrl: 'https://console.volcengine.com/ark/region%3Acn-beijing/docs/model-list',
    models: [model('doubao-seed-2-1-lite-260915', 'Doubao Seed 2.1 Lite', vision), model('doubao-seed-2-1-pro-260915', 'Doubao Seed 2.1 Pro', vision)],
  },
  {
    id: 'zenmux', name: 'ZenMux', protocol: 'openai', baseUrl: 'https://zenmux.ai/api/v1',
    hint: '支持订阅 Key 和按量 Key，各按对应账号额度计费。', docsUrl: 'https://zenmux.ai/docs/guide/subscription.html',
    models: [model('anthropic/claude-haiku-5.5', 'Claude Haiku 5.5', { vision: true }), model('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5', { vision: true }), model('anthropic/claude-opus-5.5', 'Claude Opus 5.5', { vision: true }), model('z-ai/glm-5.3-flash', 'GLM 5.3 Flash', vision), model('z-ai/glm-5.3-flashx', 'GLM 5.3 FlashX', vision), model('xiaomi/mimo-v2.6-pro', 'MiMo V2.6 Pro', vision)],
  },
  {
    id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1',
    hint: 'OpenAI API Key。', docsUrl: 'https://developers.openai.com/api/docs/models',
    models: [model('gpt-5.4-mini', 'GPT 5.4 mini', vision), model('gpt-5.4-nano', 'GPT 5.4 nano', vision), model('gpt-4.1-mini', 'GPT 4.1 mini', { vision: true })],
  },
  {
    id: 'anthropic', name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com',
    hint: 'Claude 官方 API Key。', docsUrl: 'https://platform.claude.com/docs/en/models/overview',
    models: [model('claude-haiku-5-5', 'Claude Haiku 5.5', { vision: true }), model('claude-sonnet-5-5', 'Claude Sonnet 5.5', { vision: true }), model('claude-opus-5-5', 'Claude Opus 5.5', { vision: true })],
  },
  {
    id: 'gemini', name: 'Google Gemini', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    hint: 'Google AI Studio API Key。', docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    models: [model('gemini-3.8-flash', 'Gemini 3.8 Flash', vision)],
  },
  {
    id: 'openrouter', name: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
    hint: '模型 ID 使用 OpenRouter 目录中的完整名称。', docsUrl: 'https://openrouter.ai/docs/quickstart',
    models: [model('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', vision), model('anthropic/claude-haiku-5.5', 'Claude Haiku 5.5', { vision: true })],
  },
];

export function listProviderPresets() {
  return PROVIDER_PRESETS.map(({ id, name, protocol, baseUrl, hint, docsUrl, models }) =>
    ({ id, name, protocol, baseUrl, hint, docsUrl, models: models.map(({ id, name, note }) => ({ id, name, note })) }));
}

export function presetModel(provider, id) {
  const preset = PROVIDER_PRESETS.find(p => provider.builtin ? p.id === 'zenmux' : p.protocol === provider.protocol && p.baseUrl === provider.baseUrl);
  return preset?.models.find(m => m.id === id);
}

export function nativeModelDefinition(provider, row) {
  const known = presetModel(provider, row.id);
  const { reasoning = false, input = ['text', 'image'], contextWindow = 131072, maxTokens = 8192 } = known ?? {};
  const contextTokens = Math.min(contextWindow, COMPACT_AT_TOKENS + COMPACTION_RESERVE_TOKENS);
  const result = { id: row.id, name: row.name, reasoning, input, contextWindow, contextTokens, maxTokens };
  if (provider.protocol === 'openai' && !['api.openai.com', 'openrouter.ai', 'zenmux.ai'].includes(new URL(provider.baseUrl).hostname)) {
    const family = PROVIDER_PRESETS.find(p => p.protocol === provider.protocol && p.baseUrl === provider.baseUrl)?.id;
    result.compat = { maxTokensField: 'max_tokens', supportsStore: false, supportsDeveloperRole: false,
      supportsReasoningEffort: false, supportsStrictMode: false,
      requiresReasoningContentOnAssistantMessages: reasoning && ['siliconflow', 'deepseek', 'zhipu', 'qwen', 'kimi', 'minimax'].includes(family) };
  }
  return result;
}
