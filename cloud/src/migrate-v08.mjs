import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writePrivateJson } from "./private-json.mjs";
import { readAppSettings } from "./app-settings.mjs";

export const V08_DIRS = ["data/feed", "data/ideas", "data/goals/done", "data/library/artifacts", "data/library/media", "data/memory/profile", "data/soul/diary", "data/health", "data/uploads", "workspace", "system/browser", "system/connectors", "system/sync", "system/sessions", ".claude/skills"];
const exists = (file) => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
function safeTree(file) {
  if (!exists(file)) return;
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error("迁移路径含符号链接，请先人工核对");
  if (fs.statSync(file).isDirectory()) for (const entry of fs.readdirSync(file)) safeTree(path.join(file, entry));
}
function checkMove(source, target) {
  if (!exists(source) || !exists(target)) return;
  if (!fs.statSync(source).isDirectory() || !fs.statSync(target).isDirectory()) throw new Error("0.8 迁移目标存在同名文件，未覆盖原内容");
  for (const entry of fs.readdirSync(source)) checkMove(path.join(source, entry), path.join(target, entry));
}
function move(source, target) {
  if (!exists(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!exists(target)) return fs.renameSync(source, target);
  for (const entry of fs.readdirSync(source)) move(path.join(source, entry), path.join(target, entry));
  fs.rmdirSync(source);
}

export function migrateV08({ root, seedDir, now = new Date() }) {
  const marker = path.join(root, "system/migrations/v08.json");
  if (exists(marker)) return { migrated: false };
  const scheduleFile = path.join(root, "system/schedule.json");
  const chatFile = path.join(root, "system/chat.jsonl");
  let chat;
  if (exists(chatFile)) {
    safeTree(chatFile);
    try {
      chat = fs.readFileSync(chatFile, "utf8").split(/\r?\n/).filter((s) => s.trim()).map((s) => JSON.parse(s));
      if (chat.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new Error();
    }
    catch { throw new Error("聊天记录损坏，未执行 0.8 迁移，请先核对备份"); }
  }
  let jobs;
  try {
    jobs = exists(scheduleFile) ? JSON.parse(fs.readFileSync(scheduleFile, "utf8")) : JSON.parse(fs.readFileSync(path.join(seedDir, "system/schedule.json"), "utf8"));
    if (!Array.isArray(jobs) || jobs.some((j) => !j || typeof j.id !== "string")) throw new Error();
  } catch { throw new Error("定时配置损坏，未执行 0.8 迁移，也未覆盖原配置"); }
  let activityIndex;
  for (const rel of ["system/task-index.json", "system/activity-index.json"]) if (exists(path.join(root, rel))) {
    safeTree(path.join(root, rel));
    try {
      activityIndex = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
      if (!activityIndex || typeof activityIndex !== "object" || Array.isArray(activityIndex)) throw new Error();
    } catch { throw new Error("活动索引损坏，未执行 0.8 迁移，也未覆盖原配置"); }
  }
  const moves = [["data/sites", "data/library/artifacts"], ["data/files", "data/library/media"], ["data/diary", "data/soul/diary"], ["data/memory/role/角色.md", "data/soul/角色.md"], ["system/task-index.json", "system/activity-index.json"]];
  const retired = ["data/briefs", "system/app-profile.json", "system/jobs.jsonl", "data/memory/health/latest.json"];
  for (const [source, target] of moves) {
    safeTree(path.join(root, source)); safeTree(path.join(root, target));
    checkMove(path.join(root, source), path.join(root, target));
  }
  for (const dir of ["data", "system", "backup", "data/library", "data/soul", "data/memory/role", "system/migrations"]) {
    const file = path.join(root, dir);
    if (exists(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("迁移路径含符号链接，请先人工核对");
  }
  const backup = `backup/migrate-v08-${now.toISOString().replace(/[:.]/g, "-")}`;
  const saved = new Set([...moves.map(([source]) => source), ...retired, "system/schedule.json", "system/chat.jsonl", "system/activity-index.json", "system/app-settings.json"]);
  for (const rel of saved) if (exists(path.join(root, rel))) {
    safeTree(path.join(root, rel));
    fs.mkdirSync(path.dirname(path.join(root, backup, rel)), { recursive: true });
    fs.cpSync(path.join(root, rel), path.join(root, backup, rel), { recursive: true, errorOnExist: true, force: false });
  }
  writePrivateJson(path.join(root, backup, "manifest.json"), { version: "0.8.0", at: now.toISOString(), paths: [...saved].filter((p) => exists(path.join(root, p))) });
  for (const [source, target] of moves) move(path.join(root, source), path.join(root, target));
  for (const rel of retired) fs.rmSync(path.join(root, rel), { recursive: true, force: true });
  const oldRole = path.join(root, "data/memory/role");
  if (exists(oldRole) && fs.readdirSync(oldRole).length === 0) fs.rmdirSync(oldRole);
  const remap = (value) => {
    if (typeof value === "string") return value.replaceAll("data/sites/", "data/library/artifacts/").replaceAll("data/files/", "data/library/media/").replaceAll("data/diary/", "data/soul/diary/").replaceAll("data/memory/role/角色.md", "data/soul/角色.md");
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v)]));
    return value;
  };
  if (chat) {
    const rows = chat.filter((row) => ["user", "assistant"].includes(row.role)).map((row) => ({ ...remap(row), id: row.id || crypto.randomUUID() }));
    const tmp = `${chatFile}.v08.tmp`; fs.writeFileSync(tmp, rows.map((row) => JSON.stringify(row) + "\n").join(""), { mode: 0o600 }); fs.renameSync(tmp, chatFile);
  }
  const index = path.join(root, "system/activity-index.json");
  if (activityIndex) writePrivateJson(index, remap(activityIndex));
  jobs = jobs.filter((j) => !["morning", "evening", "health-weekly"].includes(j.id) && j.kind !== "brief" && !/data\/briefs\//.test(j.prompt || ""));
  jobs = remap(jobs);
  const defaults = JSON.parse(fs.readFileSync(path.join(seedDir, "system/schedule.json"), "utf8"));
  for (const job of defaults) if (!jobs.some((j) => j.id === job.id)) jobs.push(job);
  const night = jobs.find((j) => j.id === "night");
  if (night) night.cron = "30 22 * * *";
  writePrivateJson(scheduleFile, jobs);
  for (const dir of V08_DIRS) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const rel of ["data/soul/角色.md", "data/memory/profile/总档.md", "data/feed/动态说明.md"]) if (!exists(path.join(root, rel))) fs.copyFileSync(path.join(seedDir, rel), path.join(root, rel));
  if (!exists(path.join(root, "data/follow-ups.md"))) fs.writeFileSync(path.join(root, "data/follow-ups.md"), "# 跟进清单\n");
  readAppSettings(root);
  const result = { migrated: true, version: "0.8.0", backup, at: now.toISOString() };
  writePrivateJson(marker, result);
  return result;
}
