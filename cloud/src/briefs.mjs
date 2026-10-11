// Structured brief validation is shared by hooks, the API, cards and the one-time migration.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dateIn } from "./store.mjs";

export const BRIEF_TITLE_LIMIT = 28;
export const BRIEF_SUMMARY_LIMIT = 80;
const plain = z.string().trim().min(1, "不能为空").superRefine((s, ctx) => {
  if (/\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[0-9#*]\uFE0F?\u20E3/u.test(s)) ctx.addIssue({ code: "custom", message: "不能含 emoji" });
  if (/https?:\/\/|www\.|\[[^\]]*\]\(|<\/?[a-z][^>]*>|\*\*|__|`|^\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s)/im.test(s)) {
    ctx.addIssue({ code: "custom", message: "不能含链接或 Markdown" });
  }
});
const limited = (max) => plain.refine((s) => Array.from(s).length <= max, `超过 ${max} 字`);
const row = (fields) => z.object(fields).strict();
const items = (fields, max, min = 1) => z.array(row(fields)).min(min, `至少 ${min} 项`).max(max, `最多 ${max} 项`);
const block = z.discriminatedUnion("type", [
  row({ type: z.literal("timeline"), items: items({ when: plain, label: plain, text: plain.optional() }, 4) }),
  row({ type: z.literal("tiles"), items: items({ title: plain, text: plain, tag: plain.optional(), tone: z.enum(["ok", "warn", "info"], { error: "只能是 ok、warn 或 info" }).optional() }, 3, 2) }),
  row({ type: z.literal("metrics"), items: items({ label: plain, value: plain, unit: plain.optional(), delta: plain.optional() }, 4) }),
  row({ type: z.literal("list"), items: items({ text: plain, meta: plain.optional() }, 6) }),
  row({ type: z.literal("note"), text: plain }),
]);

export const briefSchema = row({
  v: z.literal(1, { error: "必须是 1" }), name: plain,
  time: z.iso.datetime({ offset: true, error: "必须是带时区的 ISO 日期时间" }),
  cards: z.array(row({
    chip: plain, title: limited(BRIEF_TITLE_LIMIT), summary: limited(BRIEF_SUMMARY_LIMIT).optional(),
    blocks: z.array(block).max(4, "最多 4 个区块").optional(),
    action: row({ label: plain, prompt: plain }).optional(),
  })).min(1, "至少 1 张卡片").max(5, "最多 5 张卡片"),
});

function fieldPath(parts) {
  return parts.reduce((s, p) => typeof p === "number" ? `${s}[${p}]` : s ? `${s}.${p}` : p, "") || "简报";
}

export function validateBrief(value) {
  const result = briefSchema.safeParse(value);
  if (result.success) return { brief: result.data };
  const errors = result.error.issues.map((e) => {
    let message = e.message;
    if (/^Invalid /.test(message)) message = "字段缺失、格式或区块 type 不正确";
    if (e.code === "unrecognized_keys") message = "包含未定义字段";
    return `${fieldPath(e.path)} ${message}`;
  });
  return { error: errors.slice(0, 8).join("；") };
}

export const isBriefPath = (rel) => /^data\/briefs\/.+\.json$/.test(rel);
export const isOutputPath = (rel) => isBriefPath(rel) || /^data\/sites\/.+\.html$/.test(rel);

export function readBrief(root, rel) {
  try {
    if (!isBriefPath(rel)) return { error: "简报路径必须在 data/briefs/ 下且以 .json 结尾" };
    const file = path.resolve(root, rel), dir = path.resolve(root, "data/briefs");
    if (!file.startsWith(dir + path.sep) || !fs.realpathSync(file).startsWith(fs.realpathSync(dir) + path.sep)) {
      return { error: "简报路径越出了 data/briefs/" };
    }
    return validateBrief(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (e) {
    return { error: e instanceof SyntaxError ? "简报 JSON 无法解析，请检查逗号、引号和括号" : "简报文件无法读取" };
  }
}

export function listBriefs(root, { days = 7, timezone = "Asia/Shanghai", now = new Date() } = {}) {
  const today = dateIn(timezone, now);
  const cutoff = new Date(Date.parse(today + "T00:00:00Z") - (days - 1) * 86400_000).toISOString().slice(0, 10);
  const items = [], dir = path.join(root, "data/briefs");
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        const rel = path.relative(root, file), date = rel.split("/")[2];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < cutoff || date > today) continue;
        const { brief } = readBrief(root, rel);
        if (brief) items.push({ date, name: brief.name, time: brief.time, path: rel, brief });
      }
    }
  }
  if (fs.existsSync(dir) && !fs.lstatSync(dir).isSymbolicLink()) walk(dir);
  return items.sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || a.path.localeCompare(b.path));
}
