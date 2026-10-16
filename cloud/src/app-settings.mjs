import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MODELS, listProviders, providerRecord } from "./providers.mjs";
export { MODELS, HAIKU_MODEL } from "./providers.mjs";

export const PERMISSION_MODES = [
  { id: "auto", label: "自动", note: "不问用户，自动拦下危险操作" },
  { id: "bypassPermissions", label: "完全放行", note: "什么都不拦" },
];
export const DEFAULT_SETTINGS = { model: { provider: "zenmux", id: MODELS[0].id }, permissionMode: "auto" };

function validate(root, value, partial = false) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !["model", "permissionMode"].includes(k))) {
    throw new Error("设置只接受 model 和 permissionMode");
  }
  if (!partial || Object.hasOwn(value, "model")) {
    const model = value.model;
    if (!model || typeof model !== "object" || Array.isArray(model) || Object.keys(model).sort().join(",") !== "id,provider" || typeof model.provider !== "string" || typeof model.id !== "string" || !providerRecord(root, model.provider).models.some((row) => row.id === model.id)) throw new Error("请选择已有服务中的模型");
  }
  if ((!partial || Object.hasOwn(value, "permissionMode")) && !PERMISSION_MODES.some((item) => item.id === value.permissionMode)) throw new Error("请选择自动或完全放行权限");
  return value;
}

function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}

export function readAppSettings(root) {
  const file = path.join(root, "system/app-settings.json");
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error("模型设置不能是符号链接"); }
  catch (e) { if (e.code!=="ENOENT") throw e; }
  if (!fs.existsSync(file)) save(file, DEFAULT_SETTINGS);
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error("模型设置不能是符号链接");
  fs.chmodSync(file, 0o600);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("模型设置损坏，请检查 system/app-settings.json"); }
  return structuredClone(validate(root, value));
}

export function getAppSettings(root) {
  return { ...readAppSettings(root), providers: listProviders(root), permissionModes: PERMISSION_MODES.map((m) => ({ ...m })) };
}

export function putAppSettings(root, patch) {
  validate(root, patch, true);
  const value = { ...readAppSettings(root), ...patch };
  save(path.join(root, "system/app-settings.json"), value);
  return getAppSettings(root);
}

// Also applied to live streaming queries when the selected model changes.
export function modelEnvironment(model) {
  return {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", CLAUDE_CODE_AUTO_MODE_MODEL: model,
    CLAUDE_CODE_BG_CLASSIFIER_MODEL: model,
  };
}

export function selectedModel(root, env = process.env) {
  const { model } = readAppSettings(root), provider = providerRecord(root, model.provider), builtin = !!provider.builtin;
  const identity = { provider: model.provider, baseUrl: builtin ? env.ANTHROPIC_BASE_URL : provider.baseUrl, key: builtin ? env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY : provider.apiKey, models: provider.models.map((row) => row.id) };
  return { ...model, builtin, providerRecord: provider, connection: crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex") };
}

export function providerEnvironment(selected, env) {
  const result = { ...env };
  if (!selected.builtin) {
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) delete result[key];
    result.ANTHROPIC_BASE_URL = selected.providerRecord.baseUrl;
    result.ANTHROPIC_AUTH_TOKEN = selected.providerRecord.apiKey;
    result.CLAUDE_CODE_EFFORT_LEVEL = "unset";
    result.CLAUDE_CODE_DISABLE_THINKING = "1";
    result.DISABLE_INTERLEAVED_THINKING = "1";
    result.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
    result.ENABLE_TOOL_SEARCH = "false";
    result.CLAUDE_CODE_MODEL_CAPABILITIES = "-adaptive_thinking,-rejects_disabled_thinking,-effort,-max_effort,-xhigh_effort,-mid_conv_system,-mid_conv_tool_change,-per_turn_effort,-per_turn_timing,-context_management,-fast_mode,-thinking_display_updates";
    delete result.CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM;
  }
  return result;
}
