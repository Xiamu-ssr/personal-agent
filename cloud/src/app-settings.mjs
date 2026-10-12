import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const MODELS = [
  { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", note: "消耗约 1×；输入超过 100K 后约 5×" },
  { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", note: "输入约 1.5×，输出约 1×；缓存读约 3×" },
  { id: "z-ai/glm-5.3-flashx", label: "GLM 5.3 FlashX", note: "输入约 3.75×，输出约 2.5×；缓存读约 7.5×" },
];
export const PERMISSION_MODES = [
  { id: "auto", label: "自动", note: "不问用户，自动拦下危险操作" },
  { id: "bypassPermissions", label: "完全放行", note: "什么都不拦" },
];
export const DEFAULT_SETTINGS = { model: MODELS[0].id, permissionMode: "auto" };

function validate(value, partial = false) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !["model", "permissionMode"].includes(k))) {
    throw new Error("设置只接受 model 和 permissionMode");
  }
  for (const [key, list] of [["model", MODELS], ["permissionMode", PERMISSION_MODES]]) {
    if (partial && !Object.hasOwn(value, key)) continue;
    if (!list.some((item) => item.id === value[key])) throw new Error(key === "model" ? "请选择支持的模型" : "请选择自动或完全放行权限");
  }
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
  if (value && typeof value === "object" && !Array.isArray(value) && !MODELS.some((m)=>m.id===value.model)) {
    value.model=DEFAULT_SETTINGS.model;
    validate(value);
    save(file,value);
  }
  return { ...validate(value) };
}

export function getAppSettings(root) {
  return { ...readAppSettings(root), models: MODELS.map((m) => ({ ...m })), permissionModes: PERMISSION_MODES.map((m) => ({ ...m })) };
}

export function putAppSettings(root, patch) {
  validate(patch, true);
  const value = { ...readAppSettings(root), ...patch };
  save(path.join(root, "system/app-settings.json"), value);
  return getAppSettings(root);
}

// These CLI settings are refreshed together at an idle boundary, including its two permission classifiers.
export function modelEnvironment(model) {
  return {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", CLAUDE_CODE_AUTO_MODE_MODEL: model,
    CLAUDE_CODE_BG_CLASSIFIER_MODEL: model,
  };
}
