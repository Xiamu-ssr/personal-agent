import fs from "node:fs";
import path from "node:path";
import { MODELS, DEFAULT_SETTINGS, PERMISSION_MODES, readAppSettings } from "./app-settings.mjs";
import { writePrivateJson } from "./private-json.mjs";
import { readProviders } from "./providers.mjs";

export function migrateV081({ root, now = new Date() }) {
  const marker = path.join(root, "system/migrations/v081-providers.json"), file = path.join(root, "system/app-settings.json");
  if (fs.existsSync(marker)) return { migrated: false };
  for (const p of [path.join(root, "system"), file]) {
    try { if (fs.lstatSync(p).isSymbolicLink()) throw new Error("模型设置迁移路径不能是符号链接"); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  let value;
  try { value = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : structuredClone(DEFAULT_SETTINGS); }
  catch { throw new Error("模型设置损坏，未执行 0.8.1 迁移"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !["model", "permissionMode"].includes(k)) || !PERMISSION_MODES.some((m) => m.id === value.permissionMode)) throw new Error("模型设置损坏，未执行 0.8.1 迁移");
  let backup;
  if (typeof value.model === "string") {
    backup = `backup/migrate-v081-${now.toISOString().replace(/[:.]/g, "-")}/app-settings.json`;
    writePrivateJson(path.join(root, backup), value);
    value.model = { provider: "zenmux", id: MODELS.some((m) => m.id === value.model) ? value.model : DEFAULT_SETTINGS.model.id };
    writePrivateJson(file, value);
  } else if (!fs.existsSync(file)) writePrivateJson(file, value);
  readProviders(root); readAppSettings(root);
  const result = { migrated: true, version: "0.8.1", at: now.toISOString(), ...(backup && { backup }) };
  writePrivateJson(marker, result); return result;
}
