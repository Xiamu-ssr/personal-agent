import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { migrateV08, V08_DIRS } from "../src/migrate-v08.mjs";
import { CODE } from "../src/config.mjs";
const put = (root, rel, text) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof text === "string" ? text : JSON.stringify(text)); return file; };
const options = (root) => ({ root, seedDir: path.join(CODE, "seed"), now: new Date("2026-10-15T01:00:00Z") });

test("v08 migrates a legacy data root once with a complete backup, exact new paths, no aliases and retained night id", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "v08-migrate-"));
  const legacy = { "data/briefs/2026-10-14/old.html": "旧内容", "data/sites/页面/index.html": "<title>页面</title>", "data/files/2026-10-14/音频.mp3": "audio", "data/diary/2026-10-14.md": "日记", "data/memory/role/角色.md": "- 名字：旧名字\n", "data/memory/profile/总档.md": "旧总档", "data/health/days.json": "{\"days\":[]}", "data/uploads/2026-10-14/a.txt": "original upload" };
  for (const [rel, text] of Object.entries(legacy)) put(root, rel, text);
  put(root, "system/task-index.json", { activity: { title: "旧活动", status: "done" } });
  put(root, "system/chat.jsonl", [{ role: "assistant", text: "[图片](data/files/2026-10-14/音频.mp3)", ts: 1 }, { role: "card", path: "data/briefs/2026-10-14/old.html", ts: 2 }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  put(root, "system/schedule.json", [{ id: "morning", prompt: "旧晨间安排" }, { id: "evening" }, { id: "health-weekly" }, { id: "night", cron: "0 22 * * *", prompt: "自定夜间整理", extra: 1 }, { id: "custom", cron: "0 6 * * *", prompt: "保留" }]);
  const result = migrateV08(options(root)); assert.equal(result.migrated, true);
  for (const rel of ["data/briefs", "data/sites", "data/files", "data/diary", "data/memory/role/角色.md", "system/task-index.json"]) assert.equal(fs.existsSync(path.join(root, rel)), false);
  const moved = { "data/library/artifacts/页面/index.html": "<title>页面</title>", "data/library/media/2026-10-14/音频.mp3": "audio", "data/soul/diary/2026-10-14.md": "日记", "data/soul/角色.md": "- 名字：旧名字\n" };
  for (const [rel, text] of Object.entries(moved)) { assert.equal(fs.readFileSync(path.join(root, rel), "utf8"), text); assert.equal(fs.lstatSync(path.join(root, rel)).isSymbolicLink(), false); }
  for (const [rel, text] of Object.entries(legacy).filter(([rel]) => !rel.includes("profile") && !rel.includes("health") && !rel.includes("uploads"))) assert.equal(fs.readFileSync(path.join(root, result.backup, rel), "utf8"), text);
  assert.equal(fs.readFileSync(path.join(root, "data/memory/profile/总档.md"), "utf8"), "旧总档");
  const jobs = JSON.parse(fs.readFileSync(path.join(root, "system/schedule.json")));
  assert.equal(jobs.some((j) => ["morning", "evening", "health-weekly"].includes(j.id)), false); assert.equal(jobs.find((j) => j.id === "night").cron, "30 22 * * *"); assert.equal(jobs.find((j) => j.id === "night").prompt, "自定夜间整理"); assert.equal(jobs.find((j) => j.id === "custom").prompt, "保留");
  assert.ok(jobs.some((j) => j.kind === "feed")); assert.ok(jobs.some((j) => j.kind === "health-sync"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "system/activity-index.json"))).activity.title, "旧活动");
  const chat = fs.readFileSync(path.join(root, "system/chat.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(chat.length, 1); assert.ok(chat[0].id); assert.match(chat[0].text, /data\/library\/media\//);
  assert.equal(fs.readFileSync(path.join(root, result.backup, "system/chat.jsonl"), "utf8").trim().split("\n").length, 2);
  assert.deepEqual(migrateV08(options(root)), { migrated: false }); assert.equal(fs.readdirSync(path.join(root, "backup")).length, 1);
});

test("v08 fresh startup creates the new layout without legacy directories and preserves populated new content", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "v08-fresh-")); put(root, "data/soul/角色.md", "用户原文");
  migrateV08(options(root)); for (const dir of V08_DIRS) assert.equal(fs.statSync(path.join(root, dir)).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(root, "data/soul/角色.md"), "utf8"), "用户原文"); assert.equal(fs.existsSync(path.join(root, "data/briefs")), false);
  assert.ok(fs.readFileSync(path.join(root, "data/feed/动态说明.md"), "utf8"));
});

test("migration rejects damaged schedules, collisions and symlink sources without overwriting or removing originals", () => {
  for (const mode of ["schedule", "collision", "symlink"]) {
    const root = fs.mkdtempSync(path.join(testRoot, `v08-${mode}-`)); put(root, "data/sites/页面/index.html", "old page");
    if (mode === "schedule") put(root, "system/schedule.json", "broken JSON");
    if (mode === "collision") put(root, "data/library/artifacts/页面/index.html", "new page");
    if (mode === "symlink") { put(root, "outside/file.txt", "outside"); fs.mkdirSync(path.join(root, "data/files"), { recursive: true }); fs.symlinkSync(path.join(root, "outside/file.txt"), path.join(root, "data/files/link.txt")); }
    assert.throws(() => migrateV08(options(root))); assert.equal(fs.readFileSync(path.join(root, "data/sites/页面/index.html"), "utf8"), "old page");
    assert.equal(fs.existsSync(path.join(root, "system/migrations/v08.json")), false);
  }
});
