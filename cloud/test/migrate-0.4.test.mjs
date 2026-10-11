import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { migrate, migrateSchedule, htmlToBrief } from "../scripts/migrate-0.4.mjs";
import { validateBrief } from "../src/briefs.mjs";
import { ConnectorManager } from "../src/connectors.mjs";

const rootFor = () => fs.mkdtempSync(path.join(testRoot, "migration-"));
function write(root, rel, value) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
  return file;
}
const read = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
function snapshot(root) {
  const result = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), st = fs.lstatSync(file);
      result[path.relative(root, file)] = { mode: st.mode & 0o777, uid: st.uid, gid: st.gid, mtime: st.mtimeMs,
        ...(entry.isFile() && { hash: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") }) };
      if (entry.isDirectory()) walk(file);
    }
  }
  walk(root); return result;
}

test("migration previews without writes; apply archives HTML/email/custom, preserves secrets/owners and is a strict second-run no-op", () => {
  const root = rootFor(), logs = [];
  const htmlPath = "data/briefs/2026-10-10/nested/morning.html";
  const html = '<html><head><title>' + "标题".repeat(20) + '</title></head><body><h1>不用此标题</h1><p>' + "正文".repeat(60) + '</p><p>后面的正文</p></body></html>';
  write(root, htmlPath, html);
  write(root, "data/briefs/2026-10-09/晚报.html", "<h1>没有 title 时用 h1 &amp; 标题</h1><p>今晚休息。</p>");
  const schedule = [
    { id: "morning", name: "晨报", cron: "30 7 * * *", enabled: false, extra: { keep: true }, prompt: "先读总档。写完最后一句只输出卡片标题，比如「旧标题」。" },
    { id: "evening", name: "晚报", cron: "30 21 * * *", prompt: "保持内容。写完最后一句只输出卡片标题。" },
    { id: "health-weekly", name: "健康周报", cron: "0 20 * * 0", prompt: "数据读不到就写读不到，不要编。写完最后一句只输出卡片标题。" },
    { id: "other", name: "其他任务", prompt: "原封不动", value: 42 },
  ];
  write(root, "system/schedule.json", schedule);
  const accounts = [
    { id: "qq-id", label: "QQ 测试", values: { preset: "qq", address: "fixture@qq.test", password: "FAKE-QQ-MIGRATION-SECRET", label: "个人" }, status: "ok", error: null, checkedAt: 123 },
    { id: "163-id", label: "163 测试", values: { preset: "163", address: "fixture@163.test", password: "FAKE-163-MIGRATION-SECRET" }, status: "error", error: "测试错误", checkedAt: 456 },
  ];
  const state = { accounts: { "qq-id": { uid: 123, validity: "11", committedAt: "original-time" }, "163-id": { uid: 234, validity: "22" } } };
  write(root, "system/connectors/email/accounts.json", { accounts });
  write(root, "system/connectors/email/state.json", state);
  fs.mkdirSync(path.join(root, "system/custom-connectors"), { mode: 0o700 });
  const before = snapshot(root);
  const preview = migrate({ root, timestamp: "preview-only", log: (s) => logs.push(s) });
  assert.equal(preview.changes, 7);
  assert.deepEqual(snapshot(root), before);
  assert.equal(fs.existsSync(path.join(root, "backup")), false);
  const output = execFileSync(process.execPath, ["scripts/migrate-0.4.mjs", "--root", root], { encoding: "utf8" });
  assert.match(output, /预览/);
  assert.deepEqual(snapshot(root), before, "CLI default is also strictly read-only");
  const result = migrate({ root, apply: true, timestamp: "local-apply", log: (s) => logs.push(s) });
  assert.equal(result.changes, preview.changes);
  const backup = result.backup;
  assert.equal(fs.readFileSync(path.join(backup, htmlPath), "utf8"), html);
  assert.equal(fs.existsSync(path.join(root, htmlPath)), false);
  assert.deepEqual(read(backup, "system/schedule.json"), schedule);
  assert.deepEqual(read(backup, "system/connectors/email/accounts.json"), { accounts });
  assert.deepEqual(read(backup, "system/connectors/email/state.json"), state);
  assert.equal(fs.statSync(path.join(backup, "system/custom-connectors")).mode & 0o777, 0o700);
  for (const rel of [htmlPath, "system/schedule.json", "system/connectors/email/accounts.json", "system/connectors/email/state.json"]) {
    const st = fs.statSync(path.join(backup, rel));
    assert.equal(st.mode & 0o777, before[rel].mode); assert.equal(st.uid, before[rel].uid); assert.equal(st.gid, before[rel].gid);
  }
  const brief = read(root, htmlPath.replace(/\.html$/, ".json"));
  assert.equal(Array.from(brief.cards[0].title).length, 28);
  assert.equal(Array.from(brief.cards[0].summary).length, 80);
  assert.equal(brief.cards.length, 1);
  assert.equal(validateBrief(brief).error, undefined);
  assert.equal(read(root, "data/briefs/2026-10-09/晚报.json").cards[0].title, "没有 title 时用 h1 & 标题");
  const updated = read(root, "system/schedule.json");
  for (let i = 0; i < 3; i++) {
    const { prompt: _old, ...fields } = schedule[i], { prompt, ...newFields } = updated[i];
    assert.deepEqual(newFields, fields);
    assert.match(prompt, /按简报格式写 JSON/); assert.doesNotMatch(prompt, /写完最后一句只输出卡片标题|旧标题/);
  }
  assert.match(updated[2].prompt, /data\/memory\/health\/latest.json/);
  assert.deepEqual(updated[3], schedule[3]);
  for (const [name, old, id] of [["qq-mail", accounts[0], "qq-id"], ["netease-163", accounts[1], "163-id"]]) {
    const migrated = read(root, `system/connectors/${name}/accounts.json`).accounts[0];
    const { preset: _preset, ...values } = old.values;
    assert.deepEqual(migrated, { ...old, values });
    assert.deepEqual(read(root, `system/connectors/${name}/state.json`), { accounts: { [id]: state.accounts[id] } });
  }
  const manager = new ConnectorManager({ root });
  assert.deepEqual(manager.list().installed.map((c) => c.name), ["qq-mail", "netease-163"]);
  assert.deepEqual(manager.readState("qq-mail").accounts["qq-id"], state.accounts["qq-id"]);
  const after = snapshot(root);
  const second = migrate({ root, apply: true, timestamp: "second-run", log: (s) => logs.push(s) });
  assert.equal(second.changes, 0); assert.equal(second.backup, null);
  assert.deepEqual(snapshot(root), after);
  assert.equal(fs.existsSync(path.join(root, "backup/migrate-0.4/second-run")), false);
  for (const secret of accounts.map((a) => a.values.password)) assert.equal((logs.join("\n") + output).includes(secret), false);
  for (const [rel, st] of Object.entries(after)) if (st.hash && !rel.startsWith("backup/")) {
    assert.equal(st.mode, 0o600); assert.equal(st.uid, process.getuid()); assert.equal(st.gid, before["system/schedule.json"].gid);
  }
});

test("migration preflights conflicts, resumes an interrupted conversion, keeps nonempty custom directories and refuses unsafe sources", () => {
  const root = rootFor();
  write(root, "data/briefs/2026-10-11/x.html", "<h1>一件事</h1><p>正文</p>");
  write(root, "data/briefs/2026-10-11/x.json", { manually: "edited" });
  const before = snapshot(root);
  assert.throws(() => migrate({ root, apply: true, log() {} }), /已存在且内容不同/);
  assert.deepEqual(snapshot(root), before, "conflict does not modify any source or create a backup");
  const file = path.join(root, "data/briefs/2026-10-11/x.html");
  write(root, "data/briefs/2026-10-11/x.json", htmlToBrief(fs.readFileSync(file, "utf8"), "data/briefs/2026-10-11/x.html", fs.statSync(file)));
  write(root, "system/custom-connectors/fixture/.env", "FAKE_ONLY_SECRET=keep-this-directory");
  const logs = [];
  assert.equal(migrate({ root, apply: true, log: (s) => logs.push(s) }).changes, 1);
  assert.equal(fs.existsSync(path.join(root, "system/custom-connectors/fixture/.env")), true);
  assert.equal(logs.join("\n").includes("keep-this-directory"), false);
  const other = rootFor();
  write(other, "system/connectors/email/accounts.json", { accounts: [{ id: "unsupported", values: { preset: "outlook", password: "FAKE-DO-NOT-PRINT" } }] });
  assert.throws(() => migrate({ root: other, apply: true, log() {} }), /不支持的 preset/);
  assert.equal(fs.existsSync(path.join(other, "backup")), false);
  fs.symlinkSync(path.join(other, "system"), path.join(other, "data"));
  assert.throws(() => migrate({ root: other, apply: true, log() {} }), /符号链接/);
});

test("schedule conversion is idempotent, leaves unrelated fields and jobs intact, and seed prompts already use v0.4", () => {
  const seed = JSON.parse(fs.readFileSync(new URL("../seed/system/schedule.json", import.meta.url)));
  assert.deepEqual(migrateSchedule(seed), seed);
  for (const job of seed.filter((j) => ["morning", "evening", "health-weekly"].includes(j.id))) {
    assert.match(job.prompt, /按简报格式写 JSON/); assert.doesNotMatch(job.prompt, /只输出卡片标题/);
  }
  assert.match(seed.find((j) => j.id === "health-weekly").prompt, /latest.json/);
});

test("migration CLI --apply is explicit and repeatable, and parse failures never print source contents", () => {
  const root = rootFor();
  write(root, "data/briefs/2026-10-11/cli.html", "<title>命令行测试</title><p>一段正文</p>");
  const before = snapshot(root);
  const args = ["scripts/migrate-0.4.mjs", "--root", root];
  assert.match(execFileSync(process.execPath, args, { encoding: "utf8" }), /预览/);
  assert.deepEqual(snapshot(root), before);
  assert.match(execFileSync(process.execPath, [...args, "--apply"], { encoding: "utf8" }), /执行/);
  const after = snapshot(root);
  assert.match(execFileSync(process.execPath, [...args, "--apply"], { encoding: "utf8" }), /没有变化/);
  assert.deepEqual(snapshot(root), after);
  write(root, "system/schedule.json", '{"FAKE_SECRET_IN_BROKEN_JSON":DO-NOT-PRINT');
  assert.throws(() => execFileSync(process.execPath, [...args, "--apply"], { encoding: "utf8", stdio: "pipe" }), (e) => {
    assert.equal(String(e.stderr).includes("DO-NOT-PRINT"), false); assert.match(String(e.stderr), /JSON 文件无法解析/); return true;
  });
});
