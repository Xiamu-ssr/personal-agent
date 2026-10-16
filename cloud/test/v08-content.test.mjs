import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { Content, frontmatter, parseIdeas } from "../src/content.mjs";
import { Speech } from "../src/say.mjs";
import { Avatar, workingText } from "../src/avatar.mjs";
import { checkDataAccess } from "../src/data-guard.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tailJsonl } from "../src/store.mjs";
import { setTimeout as delay } from "node:timers/promises";

const put = (root, rel, text) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
function setup() { const root = fs.mkdtempSync(path.join(testRoot, "v08-content-")), events = []; return { root, events, content: new Content({ root, bus: { emit: (e) => events.push(e) }, clock: () => new Date("2026-10-15T01:00:00Z") }) }; }
export const goalText = (cadence = "0 8 * * 1", status = "追踪中") => `---\ntitle: 每周运动\ndomain: 健康\ncadence: "${cadence}"\ndue: 2026-12-31\nstatus: ${status}\nprogress: 25\n---\n## 计划\n循序渐进。\n## 步骤\n- [x] 定计划\n- [ ] 去运动\n## 记录\n第一次跟进。\n`;
const postText = (title) => `---\ntitle: "${title}"\nsource: 测试来源\nurl: https://example.test/news\npublished: 2026-10-15 08:00\nicon: 📰\nimage: cover.png\n---\n两句事实。\n`;
const ideasText = "## 健康\n- 🏃 **查运动路线**：我来查路线。适合你的时间。\n  > 帮我查一下附近的运动路线\n## 连接应用\n- 🔗 **连接邮箱**：连上后我能读邮件。\n  > 帮我连接邮箱\n";

test("flat frontmatter supports quoted cron, colons in values and separate body; malformed fields fail", () => {
  const value = frontmatter(goalText()); assert.equal(value.meta.cadence, "0 8 * * 1"); assert.match(value.body, /## 步骤/);
  assert.equal(frontmatter("---\ntitle: '他说''可以'\n---\n正文").meta.title, "他说'可以");
  assert.throws(() => frontmatter("没有头部")); assert.throws(() => frontmatter("---\nbroken\n---\n正文"));
});

test("feed paginates whole days, newest first, tolerates bad posts and emits only new-post events", () => {
  const { root, content, events } = setup();
  for (const day of ["2026-10-13", "2026-10-14", "2026-10-15"]) put(root, `data/feed/${day}/0800-消息.md`, postText(day));
  put(root, "data/feed/2026-10-15/0900-更新.md", postText("更新")); put(root, "data/feed/2026-10-15/0700-坏文件.md", "broken");
  put(root, "data/feed/2026-10-15/cover.png", "image");
  const page = content.feed({ days: 1 }); assert.equal(page.items.length, 2); assert.equal(page.items[0].title, "更新"); assert.equal(page.next, "2026-10-15");
  assert.equal(page.items[0].image, "data/feed/2026-10-15/cover.png");
  assert.deepEqual(content.feed({ days: 2, before: page.next }).days, ["2026-10-14", "2026-10-13"]);
  assert.throws(() => content.feed({ days: 0 })); assert.throws(() => content.feed({ before: "bad" }));
  content.discoverFeed(); const count = events.length; content.discoverFeed(); assert.equal(events.length, count);
  put(root, "data/feed/2026-10-15/1000-新增.md", postText("新增")); assert.equal(content.discoverFeed().length, 1); assert.equal(events.at(-1).t, "feed_new");
});

test("feedback persists likes/dislikes/discussion and discussion starts main chat with post context", async () => {
  const { root, content } = setup(), rel = "data/feed/2026-10-15/0800-消息.md", sent = [];
  put(root, rel, postText("新消息"));
  const send = async (...args) => { sent.push(args); return "message-id"; };
  for (const action of ["like", "dislike", "discuss"]) await content.feedback({ path: rel, action, text: "这意味着什么" }, send);
  const rows = tailJsonl(path.join(root, "data/feed/反馈.jsonl"), 10); assert.deepEqual(rows.map((r) => r.action), ["赞", "踩", "讨论"]);
  assert.equal(rows[0].title, "新消息"); assert.equal(sent.length, 1); assert.equal(sent[0][0], "这意味着什么"); assert.match(sent[0][3].promptText, /\[讨论动态\].*\n新消息/); assert.match(sent[0][3].promptText, /两句事实/); assert.equal(sent[0][3].quote.path, rel); assert.equal(sent[0][1], "feed");
  await assert.rejects(content.feedback({ path: rel, action: "bad" }, send));
});

test("feed settings are shared, partial, validated, and allow an overnight time window", () => {
  const { root, content } = setup(); assert.equal(content.feedSettings().interval, 30);
  content.putFeedSettings({ interval: 15, start: "22:00", end: "06:00", instructions: "只看科技" });
  assert.equal(new Content({ root }).feedSettings().instructions, "只看科技");
  content.putFeedSettings({ enabled: false }); assert.equal(content.feedSettings().interval, 15);
  for (const value of [{ interval: 45 }, { enabled: "yes" }, { start: "25:00" }, { start: "06:00" }, { extra: true }]) assert.throws(() => content.putFeedSettings(value));
});

test("ideas parse groups, emoji, titles and quoted replies; clicks persist and send exactly the quoted sentence", async () => {
  const { root, content } = setup(), sent = [];
  put(root, "data/ideas/点子.md", ideasText); const result = content.ideas();
  assert.equal(result.groups.length, 2); assert.equal(result.groups[0].items[0].icon, "🏃"); assert.equal(result.groups[0].items[0].title, "查运动路线");
  const item = result.groups[0].items[0];
  await content.clickIdea({ id: item.id, revision: result.revision }, async (...args) => { sent.push(args); return "clicked"; });
  assert.deepEqual(sent, [["帮我查一下附近的运动路线", "idea"]]); assert.equal(tailJsonl(path.join(root, "data/ideas/点击.jsonl"), 1)[0].reply, item.reply);
  put(root, "data/ideas/点子.md", ideasText + "\n换批");
  await assert.rejects(content.clickIdea({ id: item.id, revision: result.revision }, () => {}), (e) => e.status === 409);
  assert.deepEqual(parseIdeas("## 健康\n- 🏃 **无回复**：缺引用" ).groups, []);
});

test("goals parse required metadata, expose next cadence, filter paused/completed and reject malformed files", () => {
  const { root, content } = setup(); put(root, "data/goals/运动.md", goalText()); put(root, "data/goals/暂停.md", goalText("0 8 * * 1", "暂停"));
  put(root, "data/goals/done/完成.md", goalText("0 8 * * 1", "完成")); put(root, "data/goals/坏目标.md", goalText("99 8 * * 1"));
  const { items, errors } = content.goals(); assert.equal(items.length, 2); assert.equal(errors.length, 1);
  const active = items.find((i) => i.name === "运动"); assert.equal(active.progress, 25); assert.equal(active.nextCheckin, "2026-10-19T00:00:00.000Z");
  assert.equal(items.find((i) => i.name === "暂停").nextCheckin, null); assert.equal(content.goals({ done: true }).items[0].status, "完成");
  assert.throws(() => content.goal("../private"));
});

test("library sorts artifacts and media newest first and pages carry an authenticated thumbnail URL", () => {
  const { root, content } = setup(); const old = put(root, "data/library/artifacts/报告/说明.md", "报告");
  fs.utimesSync(old, new Date(1), new Date(1)); fs.utimesSync(path.dirname(old), new Date(1), new Date(1));
  put(root, "data/library/artifacts/页面/index.html", "<title>页面</title>"); put(root, "data/library/media/2026-10-15/结果.png", "image");
  const result = content.library(); assert.equal(result.artifacts[0].kind, "page"); assert.match(result.artifacts[0].thumbnail, /^\/api\/library\/thumbnail/);
  assert.equal(result.artifacts[1].kind, "document"); assert.equal(result.media[0].kind, "image");
});

test("memory console reads soul, diary, profile, categories and the health pointer from the new paths", () => {
  const { root, content } = setup(); put(root, "data/soul/角色.md", "- 名字：小豆\n- 性格：靠谱\n- 口吻：简洁\n"); put(root, "data/soul/diary/2026-10-15.md", "日记"); put(root, "data/memory/work/项目.md", "记忆");
  const result = content.memory(); assert.equal(result.soul.name, "小豆"); assert.equal(result.soul.personality, "靠谱"); assert.equal(result.soul.diary.length, 1); assert.equal(result.categories[0].items[0].name, "项目");
});

test("health and uploads stay read-only; feed instructions are writable except in feed runs, including symlink aliases", () => {
  const { root } = setup();
  for (const rel of ["data/health/days.json", "data/uploads/2026-10-15/a.txt"]) {
    put(root, rel, "source");
    for (const tool_name of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) assert.equal(checkDataAccess({ tool_name, tool_input: { file_path: rel, notebook_path: rel } }, { root }).hookSpecificOutput.permissionDecision, "deny");
    for (const command of [`rm ${rel}`, `echo changed > ${rel}`]) assert.equal(checkDataAccess({ tool_name: "Bash", tool_input: { command } }, { root }).hookSpecificOutput.permissionDecision, "deny");
    assert.deepEqual(checkDataAccess({ tool_name: "Bash", tool_input: { command: `cat ${rel}` } }, { root }), {});
  }
  fs.symlinkSync(path.join(root, "data/uploads"), path.join(root, "alias"));
  assert.equal(checkDataAccess({ tool_name: "Write", tool_input: { file_path: "alias/new.txt" } }, { root }).hookSpecificOutput.permissionDecision, "deny");
  const rel = "data/feed/动态说明.md"; put(root, rel, "偏好");
  fs.symlinkSync(path.join(root, rel), path.join(root, "instructions"));
  for (const feed of [false, true]) for (const target of [rel, "instructions"]) {
    for (const tool_name of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]) {
      const result = checkDataAccess({ tool_name, tool_input: { file_path: target, notebook_path: target, command: `echo changed > ${target}` } }, { root, feed });
      assert.equal(result.hookSpecificOutput?.permissionDecision, feed ? "deny" : undefined);
    }
  }
});

test("say's real in-process MCP validates cards and default replies and emits one persisted bubble per call", async (t) => {
  const { root, events } = setup(); put(root, "data/library/media/2026-10-15/image.png", "image");
  put(root, "data/goals/运动.md", goalText());
  const speech = new Speech({ root, bus: { emit: (e) => events.push(e) } }), server = speech.mcpServer(() => ({ activityId: "local-activity" }));
  const client = new Client({ name: "say-test", version: "0.8.0" }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(b); await client.connect(a); t.after(() => client.close());
  const listing = (await client.listTools()).tools;
  assert.deepEqual(listing.map((t) => t.name), ["say"]);
  assert.match(listing[0].description, /goal：展示一个已经写好的目标（data\/goals\/<name>\.md），卡片本身不会创建目标/);
  assert.match(listing[0].description, /后台运行不能对用户说话/);
  const cards = [{ type: "connector", id: "qq-mail" }, { type: "goal", name: "运动" }, { type: "link", url: "https://example.test/news", title: "网页" }, { type: "image", path: "data/library/media/2026-10-15/image.png" }, { type: "browser" }, { type: "device", capability: "health" }];
  const result = await client.callTool({ name: "say", arguments: { text: "第一句", options: [{ label: "继续" }], cards } }); assert.notEqual(result.isError, true);
  await client.callTool({ name: "say", arguments: { text: "第二句" } });
  assert.equal(events.filter((e) => e.t === "say").length, 2); assert.equal(speech.history()[0].options[0].reply, "继续");
  for (const card of [{ type: "unknown" }, { type: "file", path: "system/private.txt" }, { type: "link", url: "javascript:alert(1)" }]) assert.equal((await client.callTool({ name: "say", arguments: { text: "无效", cards: [card] } })).isError, true);
  assert.equal((await client.callTool({ name: "say", arguments: { text: "" } })).isError, true);
});

test("avatar exposes idle/working/waiting/happy/error, maps tool labels and returns to idle after its short happy state", async () => {
  const events = []; let busy = false, waiting = false;
  const avatar = new Avatar({ bus: { emit: (e) => events.push(e) }, busy: () => busy, waiting: () => waiting, happyMs: 15 });
  assert.equal(avatar.value.state, "idle"); busy = true; avatar.working("mcp__gmail__read"); assert.equal(avatar.value.text, "在看你的邮件");
  assert.equal(workingText("Write", { file_path: "data/feed/2026-10-15/0800-消息.md" }), "在写动态"); assert.equal(workingText("mcp__browser__open"), "在浏览网页"); assert.equal(workingText("Bash"), "努力工作中");
  avatar.settle(); assert.equal(avatar.value.state, "working"); busy = false; waiting = true; avatar.settle(); assert.equal(avatar.value.state, "waiting");
  waiting = false; avatar.settle(); assert.equal(avatar.value.state, "happy"); await delay(25); assert.equal(avatar.value.state, "idle");
  avatar.settle(false); assert.equal(avatar.value.state, "error"); avatar.close();
});
