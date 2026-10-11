import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { briefSchema, validateBrief, readBrief, listBriefs, isOutputPath } from "../src/briefs.mjs";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { config } from "../src/config.mjs";

export const minimalBrief = (title = "今天先把周报交了", time = "2026-10-11T07:30:00+08:00") => ({
  v: 1, name: "晨报", time, cards: [{ chip: "10月11日 周日", title, summary: "下午三点前提交。" }],
});
const allBlocks = [
  { type: "timeline", items: [{ when: "15:00", label: "交周报", text: "发给经理" }] },
  { type: "tiles", items: [{ title: "天气", text: "有雨", tag: "带伞", tone: "warn" }, { title: "通勤", text: "地铁正常", tone: "ok" }] },
  { type: "metrics", items: [{ label: "睡眠", value: "6.5", unit: "小时", delta: "-0.8" }] },
  { type: "list", items: [{ text: "取快递", meta: "楼下驿站" }] },
  { type: "note", text: "手机离线，日历暂不可读" },
];

test("brief schema accepts all five block types and enforces every card/field/item limit in Chinese", () => {
  const valid = minimalBrief();
  valid.cards.push({ chip: "工作", title: "把周报收尾", blocks: allBlocks.slice(0, 4), action: { label: "安排今天", prompt: "帮我排一下今天的事" } });
  valid.cards[0].blocks = [allBlocks[4]];
  assert.deepEqual(briefSchema.parse(valid), valid);
  for (const [mutate, error] of [
    [(b) => b.cards = [], /cards 至少 1/],
    [(b) => b.cards = Array(6).fill(b.cards[0]), /cards 最多 5/],
    [(b) => b.cards[0].title = "文".repeat(29), /cards\[0\].title 超过 28 字/],
    [(b) => b.cards[0].summary = "文".repeat(81), /summary 超过 80 字/],
    [(b) => b.cards[0].blocks = allBlocks, /blocks 最多 4/],
    [(b) => b.cards[0].blocks = [{ ...allBlocks[0], items: Array(5).fill(allBlocks[0].items[0]) }], /items 最多 4/],
    [(b) => b.cards[0].blocks = [{ ...allBlocks[1], items: [allBlocks[1].items[0]] }], /items 至少 2/],
    [(b) => b.cards[0].blocks = [{ ...allBlocks[1], items: Array(4).fill(allBlocks[1].items[0]) }], /items 最多 3/],
    [(b) => b.cards[0].blocks = [{ ...allBlocks[2], items: Array(5).fill(allBlocks[2].items[0]) }], /items 最多 4/],
    [(b) => b.cards[0].blocks = [{ ...allBlocks[3], items: Array(7).fill(allBlocks[3].items[0]) }], /items 最多 6/],
    [(b) => b.cards[0].blocks = [{ type: "note" }], /字段缺失/],
    [(b) => b.cards[0].blocks = [{ type: "html", text: "x" }], /type 不正确/],
    [(b) => b.cards[0].blocks = [{ type: "tiles", items: [{ title: "x", text: "x", tone: "red" }, { title: "y", text: "y" }] }], /只能是 ok/],
    [(b) => b.cards[0].title = "你好😀", /不能含 emoji/],
    [(b) => b.cards[0].title = "**结论**", /不能含链接或 Markdown/],
    [(b) => b.cards[0].summary = "https://example.test", /不能含链接或 Markdown/],
    [(b) => delete b.cards[0].chip, /chip 字段缺失/],
    [(b) => b.time = "2026-10-11", /ISO 日期时间/],
    [(b) => b.v = 2, /必须是 1/],
  ]) {
    const brief = minimalBrief(); mutate(brief); assert.match(validateBrief(brief).error, error);
  }
  assert.equal(validateBrief(minimalBrief("𠮷".repeat(28))).error, undefined, "count Unicode codepoints, not UTF-16 units");
});

test("brief listing is JSON-only, validates content, skips symlinks and uses local calendar days and timestamp order", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "brief-list-"));
  function put(rel, data) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data)); }
  put("data/briefs/2026-10-11/morning.json", minimalBrief());
  put("data/briefs/2026-10-11/nested/evening.json", minimalBrief("今天收尾", "2026-10-11T21:30:00+08:00"));
  put("data/briefs/2026-10-05/boundary.json", minimalBrief("边界", "2026-10-05T07:30:00+08:00"));
  put("data/briefs/2026-10-04/old.json", minimalBrief("旧简报", "2026-10-04T07:30:00+08:00"));
  put("data/briefs/2026-10-12/future.json", minimalBrief("未来", "2026-10-12T07:30:00+08:00"));
  put("data/briefs/2026-10-11/invalid.json", "invalid json");
  put("data/briefs/2026-10-11/bad-schema.json", { v: 1 });
  put("data/briefs/2026-10-11/old.html", "<title>ignore me</title>");
  fs.symlinkSync(path.join(root, "data/briefs/2026-10-11/morning.json"), path.join(root, "data/briefs/2026-10-11/link.json"));
  const items = listBriefs(root, { now: new Date("2026-10-10T23:40:00Z") });
  assert.equal(items.length, 3);
  assert.equal(items[0].path, "data/briefs/2026-10-11/nested/evening.json");
  assert.equal(items.at(-1).date, "2026-10-05");
  assert.deepEqual(items[1].brief, minimalBrief());
  assert.match(readBrief(root, "data/briefs/2026-10-11/invalid.json").error, /JSON 无法解析/);
  assert.match(readBrief(root, "data/briefs/../../outside.json").error, /越出|无法读取/);
  assert.equal(isOutputPath("data/briefs/2026-10-11/old.html"), false);
  assert.equal(isOutputPath("data/sites/test/index.html"), true);
});

test("main, fork and isolated PostToolUse validate Write/Edit; invalid briefs never enter cards, sites still do", async () => {
  const events = [], harness = new Harness({ hub: new DeviceHub(), bus: { emit: (e) => events.push(e) }, log() {} });
  const rel = "data/briefs/2026-10-11/hook.json", file = path.join(config.root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const isolated of [false, true]) {
    const writes = [], job = { outputs: new Set() };
    const opts = harness.options({ isolated, onWrite: (r, input, valid) => { writes.push({ r, input, valid }); harness.noteWrite(r, job, valid); } });
    try {
      const hook = opts.hooks.PostToolUse[0].hooks[0];
      for (const agent_id of [undefined, "local-fork"]) {
        fs.writeFileSync(file, JSON.stringify(minimalBrief("文".repeat(29))));
        const denied = await hook({ tool_name: "Write", tool_input: { file_path: file }, agent_id });
        assert.equal(denied.decision, "block");
        assert.match(denied.hookSpecificOutput.additionalContext, /cards\[0\].title 超过 28 字/);
        assert.equal(job.outputs.size, 0);
        fs.writeFileSync(file, JSON.stringify(minimalBrief()));
        assert.deepEqual(await hook({ tool_name: "Edit", tool_input: { file_path: rel }, agent_id }), {});
        assert.deepEqual([...job.outputs], [rel]);
      }
      fs.writeFileSync(file, "invalid");
      await hook({ tool_name: "Edit", tool_input: { file_path: rel } });
      assert.equal(job.outputs.size, 0);
      harness.taskCard({ id: "bad-fork", description: "坏简报", outputs: new Set([rel]), startedAt: Date.now() }, { status: "completed" });
      assert.equal(events.some((e) => e.taskId === "bad-fork"), false);
      assert.equal(writes.every((e) => e.r === rel), true);
      assert.deepEqual(harness.checkWrite({ tool_input: { file_path: "data/memory/health/latest.json" } }), {});
      assert.equal(harness.checkWrite({ tool_input: { file_path: "data/memory/work/latest.json" } }).hookSpecificOutput.permissionDecision, "deny");
    } finally { for (const server of Object.values(opts.mcpServers)) await server.instance.close(); }
  }
});
