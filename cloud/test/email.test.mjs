import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ConnectorManager } from "../src/connectors.mjs";
import { startFakeImap, message, FAKE_PASSWORD } from "./fake-imap.mjs";
import { callTool, toolResult } from "./tool-call.mjs";

async function setup(t, count = 1) {
  const root = fs.mkdtempSync(path.join(testRoot, "email-"));
  const imap = await startFakeImap(root);
  t.after(() => imap.close());
  const manager = new ConnectorManager({ root, definitions: [imap.connector] }), accounts = [];
  for (let i = 0; i < count; i++) accounts.push(await manager.addAccount("email", imap.values("fixture" + i + "@example.test")));
  const records = manager.accounts.get("email");
  return { root, imap, manager, accounts, tools: imap.connector.tools(structuredClone(records), manager.context("email", structuredClone(records))) };
}

test("wire IMAP search pagination is by date with stable ties, filters, snapshots and all-account results", async (t) => {
  const { imap, accounts, tools } = await setup(t, 2), account = accounts[0].id;
  const page = await callTool(tools, "search", { account, limit: 2 });
  assert.deepEqual(page.items.map((m) => m.uid), [2, 3]);
  assert.match(page.items[0].snippet, /Hello 邮件/i);
  imap.mailboxes.get("INBOX").push(message(5, { date: "2026-10-08T08:00:00Z", subject: "Inserted backdated Project" }));
  const next = await callTool(tools, "search", { account, limit: 2, before: page.next_before });
  assert.deepEqual(next.items.map((m) => m.uid), [1, 4]);
  assert.equal(next.next_before, null);
  const filtered = await callTool(tools, "search", { account, query: "Project", from: "sender@", since: "2026-10-09", until: "2026-10-11", unread: true });
  assert.deepEqual(filtered.items.map((m) => m.uid), [2, 1]);
  await assert.rejects(callTool(tools, "search", { account, before: page.next_before, unread: true }), /分页条件/);
  await assert.rejects(callTool(tools, "search", { account, before: "invalid" }), /分页游标/);
  await assert.rejects(callTool(tools, "search", { account, limit: 51 }));
  await assert.rejects(callTool(tools, "search", { account, since: "2026-02-30" }));
  let before, all = [];
  do {
    const batch = await callTool(tools, "search", { limit: 3, ...(before ? { before } : {}) });
    all.push(...batch.items);
    before = batch.next_before;
  } while (before);
  assert.equal(all.length, 10);
  assert.equal(new Set(all.map((m) => m.account + ":" + m.uid)).size, 10);
  for (let i = 1; i < all.length; i++) assert.equal(Date.parse(all[i - 1].date) >= Date.parse(all[i].date), true);
  imap.validity++;
  await assert.rejects(callTool(tools, "search", { account, before: page.next_before }), /重建/);
});

test("read decodes MIME/HTML, lists and saves attachments, caps body at 20k and leaves every flag unchanged", async (t) => {
  const { root, imap, accounts, tools } = await setup(t), account = accounts[0].id;
  const folders = await callTool(tools, "list_folders");
  assert.deepEqual(folders.items.map((f) => f.name), ["INBOX", "Archive"]);
  assert.equal(folders.items.every((f) => f.account === account), true);
  const mail = await callTool(tools, "read", { account, uid: 2 });
  assert.match(mail.text, /Hello 邮件/i);
  assert.equal(mail.text.includes("hidden"), false);
  assert.equal(mail.text.includes("<"), false);
  assert.equal(mail.unread, true);
  assert.equal(mail.attachments[0].name, "report.txt");
  const saved = await callTool(tools, "save_attachment", { account, uid: 2, name: "report.txt" });
  assert.match(saved.path, /^workspace\/mail\/\d{4}-\d{2}-\d{2}\//);
  assert.equal(fs.readFileSync(path.join(root, saved.path), "utf8"), "fixture attachment");
  assert.equal(fs.statSync(path.join(root, saved.path)).mode & 0o777, 0o600);
  await assert.rejects(callTool(tools, "save_attachment", { account, uid: 2, name: "../bad" }), /没有这个附件/);
  imap.mailboxes.get("INBOX").push(message(5, { text: "文".repeat(25_000) }));
  const long = await callTool(tools, "read", { account, uid: 5 });
  assert.equal(Array.from(long.text).length, 20_000);
  assert.deepEqual(imap.mailboxes.get("INBOX").map((m) => m.seen), [false, false, true, false, false]);
  const cmds = imap.commands.map((c) => c.command);
  assert.equal(cmds.includes("EXAMINE"), true);
  assert.equal(cmds.some((c) => ["SELECT", "STORE", "APPEND", "DELETE", "EXPUNGE", "CLOSE"].includes(c)), false);
  const fetches = imap.commands.filter((c) => c.command === "UID" && /^FETCH/.test(c.detail));
  assert.equal(fetches.some((c) => c.detail.includes("BODY.PEEK")), true);
  assert.equal(fetches.some((c) => /\bSTORE\b|\bBODY\[|\bBINARY\[/.test(c.detail)), false);
  // A new connection can close one tick after LOGOUT; all established sessions have sent LOGOUT.
  assert.equal(imap.commands.filter((c) => c.command === "LOGIN").length, imap.commands.filter((c) => c.command === "LOGOUT").length);
  fs.rmSync(path.join(root, "workspace/mail"), { recursive: true });
  const outside = path.join(root, "outside-mail");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, "workspace/mail"));
  await assert.rejects(callTool(tools, "save_attachment", { account, uid: 2, name: "report.txt" }), /越出了 workspace/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("read_since is a UID prefix, uncommitted batches repeat, commit survives query/process recreation and never regresses", async (t) => {
  const { imap, manager, accounts, tools, root } = await setup(t, 2), account = accounts[0].id;
  const batch = await callTool(tools, "read_since", { account, limit: 2 });
  assert.deepEqual(batch.items.map((m) => m.uid), [1, 2]);
  assert.equal(batch.more, true);
  assert.equal(manager.readState("email").accounts, undefined);
  const repeat = await callTool(tools, "read_since", { account, limit: 1 });
  assert.deepEqual(repeat.items.map((m) => m.uid), [1]);
  // Reconstructed MCP definitions use the same pending table, so next-turn query reload retains this cursor.
  const records = structuredClone(manager.accounts.get("email"));
  const rebuilt = imap.connector.tools(records, manager.context("email", records));
  await callTool(rebuilt, "sync_commit", { cursor: batch.cursor });
  assert.equal(manager.readState("email").accounts[account].uid, 2);
  await callTool(rebuilt, "sync_commit", { cursor: repeat.cursor });
  assert.equal(manager.readState("email").accounts[account].uid, 2);
  await assert.rejects(callTool(rebuilt, "sync_commit", { cursor: batch.cursor }), /没有这个/);
  const rest = await callTool(rebuilt, "read_since", { account, limit: 2 });
  assert.deepEqual(rest.items.map((m) => m.uid), [3, 4]);
  assert.equal(rest.more, false);
  await callTool(rebuilt, "sync_commit", { cursor: rest.cursor });
  assert.equal(fs.statSync(path.join(root, "system/connectors/email/state.json")).mode & 0o777, 0o600);
  const restarted = new ConnectorManager({ root, definitions: [imap.connector] });
  const newRecords = structuredClone(restarted.accounts.get("email"));
  const newTools = imap.connector.tools(newRecords, restarted.context("email", newRecords));
  const empty = await callTool(newTools, "read_since", { account });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.cursor, null);
  assert.equal(empty.more, false);
  const other = await callTool(newTools, "read_since", { limit: 100 });
  assert.equal(other.items.length, 4);
  assert.equal(other.items.every((m) => m.account === accounts[1].id), true);
  await callTool(newTools, "sync_commit", { cursor: other.cursor });
  imap.mailboxes.get("INBOX").push(message(5));
  const oldEpoch = await callTool(newTools, "read_since", { account });
  imap.validity++;
  imap.mailboxes.set("INBOX", [message(1, { subject: "New UID epoch" })]);
  const reset = await callTool(newTools, "read_since", { account });
  assert.equal(reset.items[0].uid, 1);
  await callTool(newTools, "sync_commit", { cursor: reset.cursor });
  assert.equal(restarted.readState("email").accounts[account].validity, String(imap.validity));
  assert.equal(restarted.readState("email").accounts[account].uid, 1);
  await assert.rejects(callTool(newTools, "sync_commit", { cursor: oldEpoch.cursor }), /没有这个/);
  assert.equal(restarted.readState("email").accounts[account].uid, 1);
});

test("account changes invalidate outstanding cursors and authentication/network errors are Chinese", async (t) => {
  const { manager, imap, accounts, tools } = await setup(t), account = accounts[0].id;
  const batch = await callTool(tools, "read_since", { account, limit: 1 });
  await manager.updateAccount("email", account, { label: "Changed" });
  await assert.rejects(callTool(tools, "sync_commit", { cursor: batch.cursor }), /没有这个/);
  imap.failLogin = true;
  await assert.rejects(imap.connector.test(imap.values()), /授权码不对或没开 IMAP/);
  const result = await manager.testAccount("email", account);
  assert.equal(result.status, "error");
  assert.equal(result.error.includes(FAKE_PASSWORD), false);
  const failedRead = await toolResult(tools, "read", { account, uid: 1 });
  assert.equal(failedRead.isError, true);
  assert.match(failedRead.data.error, /授权码/);
  await imap.close();
  await assert.rejects(imap.connector.test(imap.values()), /连不上服务器/);
});

test("163 and 126 send a second ID after login, even when the first ID returned full server information", async (t) => {
  const root = fs.mkdtempSync(path.join(testRoot, "netease-")), imap = await startFakeImap(root);
  t.after(() => imap.close());
  for (const preset of ["163", "126"]) {
    const start = imap.commands.length;
    await imap.connector.test({ preset, address: "fixture@" + preset + ".test", password: FAKE_PASSWORD });
    const commands = imap.commands.slice(start);
    assert.equal(commands.some((c) => c.command === "ID" && !c.authenticated), true);
    assert.equal(commands.some((c) => c.command === "ID" && c.authenticated), true);
  }
});
