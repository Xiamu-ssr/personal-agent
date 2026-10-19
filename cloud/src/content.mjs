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
  if (!meta.title || !["未开始", "进行中", "等待条件", "待用户反馈", "已完成", "暂停", "取消"].includes(meta.status) || !Number.isFinite(progress) || progress < 0 || progress > 100 || meta.due && !/^\d{4}-\d{2}-\d{2}$/.test(meta.due)) throw problem("目标 frontmatter 不完整或字段不正确");
  if (meta.cadence) cronFields(meta.cadence);
  return { name, path: rel, ...meta, progress, body, nextCheckin: !done && ["进行中", "等待条件"].includes(meta.status) && meta.cadence ? nextCron(meta.cadence, timezone, now) : null };
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
  read(rel) { this.allowed(rel); return fs.readFileSync(localFile(this.root, rel, ""), "utf8"); }
  allowed(rel) { if(typeof rel!=="string" || !/^(?:data\/|memory\/|SOUL\.md$|USER\.md$|MEMORY\.md$)/.test(rel) || /[\\\x00-\x1f]/.test(rel) || rel.split("/").includes("..")) throw problem("文件路径不正确"); }
  write(rel, text) {
    this.allowed(rel);
    const file = path.resolve(this.root, rel);
    if (!inside(resolvedPath(file), fs.realpathSync(this.root))) throw problem("文件路径不正确");
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
      if (meta.image && !/^[a-z][a-z0-9+.-]*:|^\/|[\\\x00-\x1f]/i.test(meta.image)) {
        const directory = path.posix.dirname(rel), candidate = directory + "/" + meta.image;
        try {
          // Validate before normalizing: nested image directories are valid; traversal and escaping symlinks are not.
          const file = localFile(this.root, candidate, directory);
          if (fileType(file).kind === "image" && fs.statSync(file).size > 0) image = path.posix.normalize(candidate);
        } catch {}
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
  feedback({ path: rel, action }) {
    const types = { like: "赞", dislike: "踩" };
    if (!types[action]) throw problem("反馈必须是 like 或 dislike");
    const post = this.post(rel);
    appendJsonl(path.join(this.root, "data/feed/反馈.jsonl"), { path: rel, title: post.title, action: types[action], ts: this.clock().getTime() });
    return { ok: true };
  }
  async sendMessage({ text = "", attachments = [], quote: reference }, send) {
    if (!reference) return { ok: true, id: await send(text, "http", attachments) };
    if (typeof text !== "string" || text.length > 8000) throw problem("引用附言限 8000 字");
    let quote, promptText, feedbackFile, record;
    if (reference.kind === "feed") {
      const rel = reference.path;
      const post = this.post(rel);
      quote = { kind: "feed", path: rel, title: post.title, emoji: post.icon, source: post.source };
      promptText = `[讨论动态]\n${post.title}\n来源：${post.source}\n${post.url}\n帖子路径：${rel}\n${post.body}\n\n${text.trim() || "聊聊这条动态。"}`;
      feedbackFile = "data/feed/反馈.jsonl";
      record = { path: rel, title: post.title, action: "讨论" };
    } else if (reference.kind === "idea") {
      const current = this.ideas();
      if (reference.revision !== current.revision) throw problem("点子已经换了一批，请重新选择；附言已保留", 409);
      const group = current.groups.find(g => g.items.some(i => i.id === reference.id));
      const item = group?.items.find(i => i.id === reference.id);
      if (!item) throw problem("没有这个点子，请重新选择", 404);
      quote = { kind: "idea", id: item.id, revision: current.revision, title: item.title, emoji: item.icon, source: group.name, description: item.description, reply: item.reply };
      promptText = `[用户引用点子]\n${item.title}\n${item.description}\n用户采纳的建议：${item.reply}\n\n用户附言：${text.trim() || "按这个点子开始。"}`;
      feedbackFile = "data/ideas/反馈.jsonl";
      record = { id: item.id, revision: current.revision, title: item.title, reply: item.reply, action: "采纳" };
    } else throw problem("引用类型必须是 feed 或 idea");
    const id = await send(text.trim(), quote.kind, attachments, { quote, promptText });
    appendJsonl(path.join(this.root, feedbackFile), { ...record, text: text.trim(), ts: this.clock().getTime() });
    return { ok: true, id };
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
  putGoal({name,title,status="未开始",progress=0,body="",domain="",cadence="",due=""}) {
    if(typeof name!=="string" || !name || /[\\/\x00-\x1f]/.test(name)||name===".."||name===".")throw problem("目标名不正确");
    if(typeof body!=="string"||body.length>40000)throw problem("目标正文过长");
    const meta={title,status,progress,domain,cadence,due};
    const raw="---\n"+Object.entries(meta).filter(([,v])=>v!=="").map(([k,v])=>`${k}: ${JSON.stringify(v)}`).join("\n")+"\n---\n"+body+"\n";
    // Validate before replacing an existing goal.
    if(!title || !["未开始","进行中","等待条件","待用户反馈","已完成","暂停","取消"].includes(status) || !Number.isFinite(progress)||progress<0||progress>100)throw problem("目标状态或进展不正确");
    if(cadence)cronFields(cadence);
    this.write(`data/goals/${name}.md`,raw);this.bus.emit({t:"goals_updated"});return this.goal(name);
  }
  memory() {
    const items=[];
    const walk=(rel)=>{for(const e of dirs(this.root,rel)){if(e.isDirectory())walk(`${rel}/${e.name}`);else if(e.isFile()&&e.name.endsWith(".md"))items.push({name:e.name.slice(0,-3),path:`${rel}/${e.name}`});}};
    walk("memory");items.sort((a,b)=>b.path.localeCompare(a.path));
    for(const file of ["USER.md","MEMORY.md"])if(fs.existsSync(path.join(this.root,file)))items.unshift({name:file==="USER.md"?"关于你":"长期记忆",path:file});
    let soul="";try{soul=fs.readFileSync(path.join(this.root,"SOUL.md"),"utf8");}catch{}
    return {kernel:"openclaw",soul:{name:soul.match(/^[-*]?\s*(?:名字|Name)[：:]\s*(.+)/mi)?.[1]||"豆豆",path:"SOUL.md"},items,health:"data/health/days.json"};
  }
}
