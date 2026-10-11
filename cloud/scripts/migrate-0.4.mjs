#!/usr/bin/env node
// Offline migration: preview by default. Originals are archived, never deleted.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { convert } from "html-to-text";
import { BRIEF_TITLE_LIMIT, BRIEF_SUMMARY_LIMIT, validateBrief } from "../src/briefs.mjs";
import { dateIn } from "../src/store.mjs";

export const HEALTH_LATEST_INSTRUCTION = '顺手写 data/memory/health/latest.json，格式 {updated,metrics:[{key,label,value,unit}]}，updated 用 ISO 时间；只写实际读到的睡眠、静息心率、步数、心率变异性，没有数据就用空 metrics。';
export function migrateSchedule(schedule) {
  if (!Array.isArray(schedule)) throw new Error("schedule.json 必须是数组");
  return schedule.map((job) => {
    if (!["晨报", "晚报", "健康周报"].includes(job.name) && !["morning", "evening", "health-weekly"].includes(job.id)) return job;
    if (typeof job.prompt !== "string") throw new Error("简报任务缺少 prompt");
    let prompt = job.prompt.replace(/写完最后一句只输出卡片标题(?:[，,]\s*比如[「“][^」”]*[」”])?[。.!]?/g, "")
      .replace(/(data\/briefs\/[^\s`「」]+)\.html/g, "$1.json").trim();
    if (!prompt.includes("按简报格式写 JSON")) prompt += "按简报格式写 JSON 到 data/briefs/<YYYY-MM-DD>/<任务名>.json。";
    if ((job.name === "健康周报" || job.id === "health-weekly") && !prompt.includes("data/memory/health/latest.json")) prompt += HEALTH_LATEST_INSTRUCTION;
    return prompt === job.prompt ? job : { ...job, prompt };
  });
}

function plainHtml(html) {
  return convert(html, { wordwrap: false, selectors: [{ selector: "a", options: { ignoreHref: true } }, { selector: "img", format: "skip" }] })
    .replace(/\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[0-9#*]\uFE0F?\u20E3/gu, "")
    .replace(/https?:\/\/\S+|www\.\S+/g, "").replace(/[`*_#]/g, "").replace(/\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\s+/g, " ").trim();
}
const clip = (text, n) => Array.from(text).slice(0, n).join("");
export function htmlToBrief(html, rel, stat, timezone = "Asia/Shanghai") {
  const day = rel.split("/")[2], name = plainHtml(path.basename(rel, ".html")) || "简报";
  const body = html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || name;
  const paragraph = body.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || body.replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi, "");
  const summary = clip(plainHtml(paragraph), BRIEF_SUMMARY_LIMIT);
  const brief = { v: 1, name, time: stat.mtime.toISOString(), cards: [{
    chip: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : dateIn(timezone, stat.mtime),
    title: clip(plainHtml(title) || name, BRIEF_TITLE_LIMIT), ...(summary && { summary }),
  }] };
  if (validateBrief(brief).error) throw new Error("HTML 转换结果无法通过简报校验，请先整理源文件");
  return brief;
}

const MAIL_TARGETS = { qq: "qq-mail", "163": "netease-163", "126": "netease-126", gmail: "gmail", exmail: "exmail", aliyun: "aliyun-mail", custom: "imap" };
export function migrate({ root = "/srv/agent", apply = false, timestamp = new Date().toISOString().replace(/[:.]/g, "-"), log = console.log } = {}) {
  root = fs.realpathSync(root);
  const operations = [], backup = path.join(root, "backup/migrate-0.4", timestamp);
  function safe(rel) {
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) throw new Error("迁移路径越出根目录");
    let current = root;
    for (const part of path.relative(root, file).split(path.sep)) {
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("迁移拒绝符号链接：" + rel);
    }
    return file;
  }
  function exists(rel) {
    const file = safe(rel);
    try { fs.lstatSync(file); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; }
  }
  function read(rel) {
    try { return JSON.parse(fs.readFileSync(safe(rel), "utf8")); }
    catch { throw new Error("JSON 文件无法解析：" + rel); }
  }
  function owner(file, stat) {
    const current = fs.statSync(file);
    if (current.uid !== stat.uid || current.gid !== stat.gid) fs.chownSync(file, stat.uid, stat.gid);
  }
  function write(rel, value, stat) {
    const file = safe(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + ".migrate-0.4-" + crypto.randomUUID();
    // A failed run can leave a private temp file for inspection; never remove an original.
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    owner(tmp, stat); fs.chmodSync(tmp, 0o600);
    const fd = fs.openSync(tmp, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  }
  function archive(rel, copy = false) {
    const source = safe(rel), destination = safe(path.relative(root, path.join(backup, rel)));
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (fs.existsSync(destination)) throw new Error("备份目标已经存在：" + rel);
    if (copy) {
      const stat = fs.statSync(source);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      owner(destination, stat); fs.chmodSync(destination, stat.mode & 0o777);
      fs.utimesSync(destination, stat.atime, stat.mtime);
    } else fs.renameSync(source, destination); // Same filesystem: preserves modes, owner and all descendants.
  }
  function plan(description, execute) { operations.push({ description, execute }); }
  function briefs(folder) {
    if (!exists(folder)) return;
    for (const entry of fs.readdirSync(safe(folder), { withFileTypes: true })) {
      const rel = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error("简报目录含符号链接，请先处理：" + rel);
      if (entry.isDirectory()) briefs(rel);
      else if (entry.isFile() && entry.name.endsWith(".html")) {
        const stat = fs.statSync(safe(rel));
        const brief = htmlToBrief(fs.readFileSync(safe(rel), "utf8"), rel, stat);
        const target = rel.slice(0, -5) + ".json";
        const present = exists(target);
        if (present && !isDeepStrictEqual(read(target), brief)) throw new Error("简报 JSON 已存在且内容不同，未覆盖：" + target);
        plan(`转换 ${rel} → ${target}；原 HTML 移入备份`, () => { if (!present) write(target, brief, stat); archive(rel); });
      }
    }
  }
  briefs("data/briefs");
  const schedule = "system/schedule.json";
  if (exists(schedule)) {
    const original = read(schedule), updated = migrateSchedule(original);
    if (!isDeepStrictEqual(original, updated)) {
      const stat = fs.statSync(safe(schedule));
      plan("复制 system/schedule.json 到备份，再更新三个简报 prompt", () => { archive(schedule, true); write(schedule, updated, stat); });
    }
  }
  const email = "system/connectors/email";
  if (exists(email)) {
    const accountFile = email + "/accounts.json", stateFile = email + "/state.json";
    if (!exists(accountFile)) {
      if (fs.readdirSync(safe(email)).length) throw new Error("旧邮箱目录非空但没有 accounts.json，未迁移");
    } else {
      const old = read(accountFile), state = exists(stateFile) ? read(stateFile) : {};
      if (!Array.isArray(old.accounts) || old.accounts.some((a) => !a.id || !a.values) || new Set(old.accounts.map((a) => a.id)).size !== old.accounts.length) throw new Error("旧邮箱账号格式不正确");
      if (state.accounts && (typeof state.accounts !== "object" || Array.isArray(state.accounts))) throw new Error("旧邮箱游标格式不正确");
      const accountStat = fs.statSync(safe(accountFile)), stateStat = exists(stateFile) ? fs.statSync(safe(stateFile)) : accountStat;
      const groups = new Map();
      for (const record of old.accounts) {
        const name = MAIL_TARGETS[record.values.preset];
        if (!name) throw new Error("旧邮箱账号含不支持的 preset，未迁移");
        const { preset: _preset, ...values } = record.values;
        if (name !== "imap") { delete values.host; delete values.port; }
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push({ ...record, values });
      }
      // Do all conflict checks before executing any mutation.
      for (const [name, incoming] of groups) {
        const accountsRel = `system/connectors/${name}/accounts.json`, stateRel = `system/connectors/${name}/state.json`;
        const saved = exists(accountsRel) ? read(accountsRel) : { ...old, accounts: [] };
        const savedState = exists(stateRel) ? read(stateRel) : { ...state, accounts: {} };
        if (!Array.isArray(saved.accounts) || (savedState.accounts && (typeof savedState.accounts !== "object" || Array.isArray(savedState.accounts)))) throw new Error("新邮箱配置格式不正确：" + name);
        const accounts = [...saved.accounts], cursors = { ...(savedState.accounts || {}) };
        for (const record of incoming) {
          const existing = accounts.find((a) => a.id === record.id);
          if (existing && !isDeepStrictEqual(existing, record)) throw new Error("新旧邮箱账号 id 冲突，未覆盖：" + name);
          if (!existing) accounts.push(record);
          const cursor = state.accounts?.[record.id];
          if (cursor !== undefined) {
            if (cursors[record.id] !== undefined && !isDeepStrictEqual(cursors[record.id], cursor)) throw new Error("新旧邮箱游标冲突，未覆盖：" + name);
            cursors[record.id] = cursor;
          }
        }
        const updated = { ...saved, accounts }, updatedState = { ...savedState, accounts: cursors };
        plan(`迁移邮箱账号及游标 → ${name}（${incoming.length} 个账号）`, () => {
          if (!exists(accountsRel) || !isDeepStrictEqual(saved, updated)) write(accountsRel, updated, exists(accountsRel) ? fs.statSync(safe(accountsRel)) : accountStat);
          if (!exists(stateRel) || !isDeepStrictEqual(savedState, updatedState)) write(stateRel, updatedState, exists(stateRel) ? fs.statSync(safe(stateRel)) : stateStat);
        });
      }
    }
    plan("旧 system/connectors/email/ 移入备份", () => archive(email));
  }
  const custom = "system/custom-connectors";
  if (exists(custom)) {
    if (fs.readdirSync(safe(custom)).length === 0) plan("空 system/custom-connectors/ 移入备份", () => archive(custom));
    else log("system/custom-connectors/ 非空，保留原目录，请人工检查");
  }
  log(`${apply ? "执行" : "预览"}：${operations.length} 项${operations.length ? "；备份位置 " + path.relative(root, backup) : "，没有变化"}`);
  for (const operation of operations) { log(operation.description); if (apply) operation.execute(); }
  return { changes: operations.length, backup: operations.length && apply ? backup : null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--apply") options.apply = true;
      else if (args[i] === "--root" && args[i + 1]) options.root = args[++i];
      else throw new Error("用法：node cloud/scripts/migrate-0.4.mjs [--root /srv/agent] [--apply]");
    }
    migrate(options);
  } catch (e) {
    // Only controlled messages contain paths; native/JSON errors can contain file contents.
    console.error(e.code ? `迁移未完成（${e.code}），请检查权限和文件；原文件及备份保留` : e.message);
    process.exitCode = 1;
  }
}
