import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { appendJsonl, readJson } from "./store.mjs";
import { writePrivateJson } from "./private-json.mjs";
import { inside, localFile, resolvedPath } from "./local-paths.mjs";
import { fileType } from "./media.mjs";
import { cronFields, nextCron } from "./cron.mjs";

const digest = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 20);
const dirs = (root, rel) => {
  try {
    const dir = path.join(root, rel);
    if (!inside(fs.realpathSync(dir), path.join(fs.realpathSync(root), rel))) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.isSymbolicLink() && !e.name.startsWith("."));
  } catch { return []; }
};
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
export function frontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw problem("文件缺少 frontmatter");
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const field = line.match(/^([a-zA-Z]+):\s*(.*?)\s*$/);
    if (!field) throw problem("frontmatter 只支持单行字段");
    let value = field[2];
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { throw problem("frontmatter 引号不完整"); } }
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("''", "'");
    else value = value.replace(/\s+#.*$/, "");
    meta[field[1]] = value;
  }
  return { meta, body: raw.slice(match[0].length).trim() };
}
export function readGoal(root, name, { done = false, timezone = "Asia/Shanghai", now = new Date() } = {}) {
  if (typeof name !== "string" || !name || /[\\/\x00-\x1f]/.test(name) || name === "." || name === "..") throw problem("目标名不正确");
  const rel = `data/goals/${done ? "done/" : ""}${name}.md`;
  let raw;
  try { raw = fs.readFileSync(localFile(root, rel, "data/goals"), "utf8"); } catch { throw problem("没有这个目标", 404); }
  const { meta, body } = frontmatter(raw), progress = Number(meta.progress);
  if (!meta.title || !["健康", "人际", "金融", "事业", "兴趣", "效率", "其他"].includes(meta.domain) || !["追踪中", "暂停", "完成", "放弃"].includes(meta.status) || !Number.isFinite(progress) || progress < 0 || progress > 100 || meta.due && !/^\d{4}-\d{2}-\d{2}$/.test(meta.due)) throw problem("目标 frontmatter 不完整或字段不正确");
  cronFields(meta.cadence);
  return { name, path: rel, ...meta, progress, body, nextCheckin: !done && meta.status === "追踪中" ? nextCron(meta.cadence, timezone, now) : null };
}
export function parseIdeas(raw) {
  const revision = digest(raw), groups = [];
  let group, item;
  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/), bullet = line.match(/^-\s+(.*?)\*\*(.+?)\*\*\s*[：:]\s*(.*)$/), quote = line.match(/^\s+>\s?(.*)$/);
    if (heading) { group = { name: heading[1], items: [] }; groups.push(group); item = null; }
    else if (bullet && group) {
      item = { icon: bullet[1].trim(), title: bullet[2].trim(), description: bullet[3].trim(), reply: "" };
      group.items.push(item);
    } else if (quote && item) item.reply += (item.reply ? "\n" : "") + quote[1];
    else if (/^\s+\S/.test(line) && item) item.description += "\n" + line.trim();
  }
  for (const g of groups) g.items = g.items.filter((i) => i.reply.trim()).map((i, n) => ({ ...i, id: digest(`${revision}\n${g.name}\n${n}\n${i.reply}`) }));
  return { revision, groups: groups.filter((g) => g.items.length) };
}

export class Content {
  constructor({ root, bus = { emit() {} }, timezone = "Asia/Shanghai", clock = () => new Date() }) {
    Object.assign(this, { root, bus, timezone, clock });
    this.feedIndex = new Map(this.feed({ days: 31 }).items.map((i) => [i.path, i.title]));
  }
  read(rel) { return fs.readFileSync(localFile(this.root, rel, "data"), "utf8"); }
  write(rel, text) {
    const file = path.resolve(this.root, rel), base = path.join(fs.realpathSync(this.root), "data");
    if (!inside(file, path.join(this.root, "data")) || !inside(resolvedPath(file), base)) throw problem("文件路径不在 data/ 内");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  feed({ before, days = 7 } = {}) {
    if (!Number.isInteger(days) || days < 1 || days > 31 || before !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(before)) throw problem("days 要 1–31，before 要 YYYY-MM-DD");
    const all = dirs(this.root, "data/feed").filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name) && (!before || e.name < before)).map((e) => e.name).sort().reverse();
    const dates = all.slice(0, days), items = [];
    for (const date of dates) for (const entry of dirs(this.root, `data/feed/${date}`)) {
      if (!entry.isFile() || !/^\d{4}-.+\.md$/.test(entry.name)) continue;
      try { items.push(this.post(`data/feed/${date}/${entry.name}`)); } catch {}
    }
    return { days: dates, items: items.sort((a, b) => b.path.localeCompare(a.path)), next: all.length > dates.length ? dates.at(-1) : null };
  }
  post(rel) {
    if (typeof rel !== "string" || !/^data\/feed\/\d{4}-\d{2}-\d{2}\/\d{4}-[^/\\]+\.md$/.test(rel)) throw problem("没有这条动态", 404);
    try {
      const { meta, body } = frontmatter(this.read(rel));
      if (!meta.title) throw new Error();
      let image;
      if (meta.image && !/[\\/]/.test(meta.image)) {
        const imagePath = path.posix.join(path.posix.dirname(rel), meta.image);
        try { localFile(this.root, imagePath, "data/feed"); image = imagePath; } catch {}
      }
      return { path: rel, date: rel.split("/")[2], title: meta.title, source: meta.source || "", url: meta.url || "", published: meta.published || "", icon: meta.icon || "", ...(image && { image }), body };
    } catch { throw problem("没有这条动态", 404); }
  }
  discoverFeed() {
    const posts = this.feed({ days: 31 }).items, added = posts.filter((p) => !this.feedIndex.has(p.path));
    for (const p of posts) this.feedIndex.set(p.path, p.title);
    if (added.length) this.bus.emit({ t: "feed_new", items: added.map(({ path, title, date }) => ({ path, title, date })) });
    return added;
  }
  async feedback({ path: rel, action, text = "" }, send) {
    const types = { like: "赞", dislike: "踩", discuss: "讨论" };
    if (!types[action] || typeof text !== "string" || text.length > 8000) throw problem("反馈必须是 like、dislike 或 discuss");
    const post = this.post(rel), record = { path: rel, title: post.title, action: types[action], text: text.trim(), ts: this.clock().getTime() };
    const quote = { kind: "feed", path: rel, title: post.title, emoji: post.icon, source: post.source };
    const promptText = `[讨论动态]\n${post.title}\n来源：${post.source}\n${post.url}\n帖子路径：${rel}\n${post.body}\n\n${text.trim() || "聊聊这条动态。"}`;
    const id = action === "discuss" ? await send(text.trim(), "feed", [], { quote, promptText }) : undefined;
    appendJsonl(path.join(this.root, "data/feed/反馈.jsonl"), record);
    return { ok: true, ...(id && { id }) };
  }
  feedSettings() {
    const saved = readJson(path.join(this.root, "system/feed-settings.json"), {});
    let instructions = "";
    try { instructions = this.read("data/feed/动态说明.md"); } catch {}
    return { enabled: true, interval: 30, start: "07:00", end: "23:00", ...saved, instructions };
  }
  putFeedSettings(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !["enabled", "interval", "start", "end", "instructions"].includes(k))) throw problem("动态设置字段不正确");
    const merged = { ...this.feedSettings(), ...value };
    if (typeof merged.enabled !== "boolean" || ![15, 30, 60].includes(merged.interval) || ![merged.start, merged.end].every((v) => typeof v === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v)) || merged.start === merged.end || typeof merged.instructions !== "string" || merged.instructions.length > 40_000) throw problem("间隔要 15/30/60，时段要 HH:MM 且起止不同，说明限 40000 字");
    const { instructions, ...settings } = merged;
    this.write("data/feed/动态说明.md", instructions);
    writePrivateJson(path.join(this.root, "system/feed-settings.json"), settings);
    this.bus.emit({ t: "feed_settings", ...merged });
    return merged;
  }
  ideas() {
    try { return parseIdeas(this.read("data/ideas/点子.md")); } catch { return parseIdeas(""); }
  }
  async clickIdea({ id, revision }, send) {
    const current = this.ideas();
    if (revision !== undefined && revision !== current.revision) throw problem("点子已经换了一批，请刷新", 409);
    for (const group of current.groups) {
      const item = group.items.find((i) => i.id === id);
      if (!item) continue;
      appendJsonl(path.join(this.root, "data/ideas/点击.jsonl"), { id, revision: current.revision, group: group.name, title: item.title, reply: item.reply, ts: this.clock().getTime() });
      return { ok: true, id: await send(item.reply, "idea") };
    }
    throw problem("没有这个点子，请刷新", 404);
  }
  goal(name, done = false) {
    return readGoal(this.root, name, { done, timezone: this.timezone, now: this.clock() });
  }
  goals({ done = false } = {}) {
    const items = [], errors = [];
    for (const file of dirs(this.root, `data/goals${done ? "/done" : ""}`)) if (file.isFile() && file.name.endsWith(".md")) {
      try { items.push(this.goal(file.name.slice(0, -3), done)); } catch (e) { errors.push({ name: file.name.slice(0, -3), error: e.message }); }
    }
    return { items, errors };
  }
  library() {
    const artifacts = [], media = [];
    const files = (rel, out) => {
      for (const e of dirs(this.root, rel)) {
        const file = `${rel}/${e.name}`;
        if (e.isDirectory()) files(file, out);
        else if (e.isFile()) {
          const st = fs.statSync(localFile(this.root, file, "data/library"));
          out.push({ path: file, name: e.name, size: st.size, mtime: st.mtimeMs, ...fileType(file) });
        }
      }
    };
    for (const e of dirs(this.root, "data/library/artifacts")) if (e.isDirectory()) {
      const rel = `data/library/artifacts/${e.name}`, contents = [];
      files(rel, contents);
      const page = contents.find((f) => f.path === `${rel}/index.html`);
      const document = contents.find((f) => f.path === `${rel}/index.md`) || contents[0];
      artifacts.push({ name: e.name, directory: rel, path: page?.path || document?.path || rel, kind: page ? "page" : "document", mtime: Math.max(fs.statSync(path.join(this.root, rel)).mtimeMs, ...contents.map((f) => f.mtime)), files: contents,
        ...(page && { thumbnail: `/api/library/thumbnail?path=${encodeURIComponent(page.path)}` }) });
    }
    files("data/library/media", media);
    return { artifacts: artifacts.sort((a, b) => b.mtime - a.mtime), media: media.sort((a, b) => b.mtime - a.mtime) };
  }
  memory() {
    const list = (rel) => dirs(this.root, rel).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => ({ name: e.name.slice(0, -3), path: `${rel}/${e.name}` }));
    let role = "";
    try { role = this.read("data/soul/角色.md"); } catch {}
    return { soul: { path: "data/soul/角色.md", name: role.match(/^[-*]?\s*名字[：:]\s*(.+)/m)?.[1] || "豆豆", personality: role.match(/^[-*]?\s*性格[：:]\s*(.+)/m)?.[1] || "", voice: role.match(/^[-*]?\s*口吻[：:]\s*(.+)/m)?.[1] || "", diary: list("data/soul/diary") },
      profile: "data/memory/profile/总档.md", categories: dirs(this.root, "data/memory").filter((e) => e.isDirectory()).map((e) => ({ name: e.name, items: list(`data/memory/${e.name}`) })), health: "data/health/days.json" };
  }
}
