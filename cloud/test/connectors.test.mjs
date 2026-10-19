import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ConnectorManager, SECRET_MASK } from "../src/connectors.mjs";
import email from "../connectors/qq-mail/index.mjs";
import { callTool, toolResult } from "./tool-call.mjs";

const credentials = { address: "fixture@qq.test", password: "fictional-storage-password" };
const rootFor = () => fs.mkdtempSync(path.join(testRoot, "storage-"));
const fakeDefinition = (testLogin = async () => {}) => ({ ...email, test: testLogin });
const file = (root, name) => path.join(root, "system/connectors/qq-mail", name);
const mode = (filename) => fs.statSync(filename).mode & 0o777;

test("validate before test/save, atomic private persistence, multiple accounts and no credential outputs", async () => {
  const root = rootFor();
  let checked = 0;
  const manager = new ConnectorManager({ root, definitions: [fakeDefinition(async () => checked++)] });
  await assert.rejects(manager.addAccount("qq-mail", { ...credentials, address: "" }), /请填写/);
  assert.equal(checked, 0);
  assert.equal(fs.existsSync(file(root, "accounts.json")), false);
  assert.equal(fs.existsSync(file(root, "state.json")), false);
  await assert.rejects(manager.addAccount("qq-mail", { ...credentials, password: SECRET_MASK }), /授权码/);
  const account = await manager.addAccount("qq-mail", credentials);
  const second = await manager.addAccount("qq-mail", { ...credentials, address: "second@qq.test" });
  assert.notEqual(account.id, second.id);
  assert.equal(account.status, "ok");
  assert.equal("values" in account, false);
  assert.equal(mode(file(root, "accounts.json")), 0o600);
  assert.equal(mode(file(root, "state.json")), 0o600);
  assert.equal(fs.statSync(file(root, "accounts.json")).uid, process.getuid());
  assert.equal(fs.readdirSync(path.dirname(file(root, "accounts.json"))).some((f) => f.endsWith(".tmp")), false);
  const saved = JSON.parse(fs.readFileSync(file(root, "accounts.json")));
  assert.equal(saved.accounts[0].values.password, credentials.password);
  assert.equal(manager.list().catalog.length, 0);
  assert.equal(manager.list().installed[0].accounts.length, 2);
  assert.equal(JSON.stringify(manager.list()).includes(credentials.password), false);
  assert.equal(manager.maskedValues("qq-mail", credentials).password, SECRET_MASK);
  assert.ok(manager.toolGroups()["qq-mail"].some(t=>t.name==="list_folders"));
});

test("masked or omitted secret survives update; failed test never saves; concurrent edits retain both changes", async () => {
  const root = rootFor(), passwords = [];
  const manager = new ConnectorManager({ root, definitions: [fakeDefinition(async (values) => {
    passwords.push(values.password);
    if (values.password === "reject-this-fake-code") throw new Error("wrong password reject-this-fake-code");
  })] });
  const account = await manager.addAccount("qq-mail", credentials);
  await manager.updateAccount("qq-mail", account.id, { label: "Work", password: SECRET_MASK });
  await manager.updateAccount("qq-mail", account.id, { label: "Personal" });
  assert.deepEqual(passwords, [credentials.password, credentials.password, credentials.password]);
  const before = fs.readFileSync(file(root, "accounts.json"), "utf8");
  await assert.rejects(manager.updateAccount("qq-mail", account.id, { password: "reject-this-fake-code" }), (e) => !e.message.includes("reject-this-fake-code") && e.message.includes(SECRET_MASK));
  assert.equal(fs.readFileSync(file(root, "accounts.json"), "utf8"), before);
  await Promise.all([
    manager.updateAccount("qq-mail", account.id, { label: "Concurrent label" }),
    manager.updateAccount("qq-mail", account.id, { address: "changed@qq.test" }),
  ]);
  const saved = JSON.parse(fs.readFileSync(file(root, "accounts.json"))).accounts[0];
  assert.equal(saved.label, "Concurrent label");
  assert.equal(saved.values.address, "changed@qq.test");
  assert.equal(saved.values.password, credentials.password);
});

test("test updates safe status, restart hardens permissions, removing last account unmounts MCP and clears state", async () => {
  const root = rootFor();
  let reject = false;
  const definition = fakeDefinition(async () => { if (reject) throw new Error("authorization " + credentials.password); });
  const manager = new ConnectorManager({ root, definitions: [definition] });
  const account = await manager.addAccount("qq-mail", credentials);
  reject = true;
  const result = await manager.testAccount("qq-mail", account.id);
  assert.equal(result.status, "error");
  assert.equal(result.error.includes(credentials.password), false);
  assert.equal(typeof result.checkedAt, "number");
  fs.chmodSync(file(root, "accounts.json"), 0o644);
  fs.chmodSync(file(root, "state.json"), 0o644);
  const restarted = new ConnectorManager({ root, definitions: [definition] });
  assert.equal(mode(file(root, "accounts.json")), 0o600);
  assert.equal(mode(file(root, "state.json")), 0o600);
  assert.equal(restarted.list().installed[0].accounts[0].status, "error");
  restarted.writeState("qq-mail", { accounts: { [account.id]: { uid: 123, validity: "100" } } });
  await restarted.removeAccount("qq-mail", account.id);
  assert.equal("qq-mail" in restarted.toolGroups(), false);
  assert.equal(restarted.list().catalog[0].fields.length > 0, true);
  assert.deepEqual(restarted.readState("qq-mail").accounts, {});
  await assert.rejects(restarted.removeAccount("qq-mail", account.id), (e) => e.status === 404);
});

test("legacy directories are not opened, removed custom connectors and unconfigured directories are never read", () => {
  const root = rootFor(), legacy = path.join(root, "system/connectors/邮箱");
  const unconfiguredEmail = path.join(root, "system/connectors/qq-mail");
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(unconfiguredEmail, { recursive: true });
  fs.writeFileSync(path.join(legacy, ".env"), "FICTIONAL_LEGACY_SECRET=must-not-read");
  fs.writeFileSync(path.join(unconfiguredEmail, "state.json"), "legacy-not-our-json");
  const dir = path.join(root, "system/custom-connectors"), custom = path.join(dir, "fixture");
  fs.mkdirSync(path.join(custom, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(custom, ".claude-plugin/plugin.json"), JSON.stringify({ name: "fixture", displayName: "Custom fixture", description: "Testing" }));
  fs.writeFileSync(path.join(custom, ".env"), 'FICTIONAL_CUSTOM_VALUE="local-only"\n');
  const originalRead = fs.readFileSync;
  fs.readFileSync = function (filename, ...args) {
    assert.equal(String(filename).startsWith(legacy), false, "legacy configuration must not be read");
    assert.equal(String(filename).startsWith(unconfiguredEmail) || String(filename).startsWith(custom), false, "a directory without accounts.json must not be read");
    return originalRead.call(fs, filename, ...args);
  };
  try {
    const manager = new ConnectorManager({ root });
    assert.deepEqual(manager.list().installed, []);
    assert.equal("custom" in manager.list(), false);
    assert.equal("customConnectors" in manager, false);
  } finally { fs.readFileSync = originalRead; }
});

test("all four management tools return no values; tested failures mask staged credentials", async () => {
  const root = rootFor();
  const manager = new ConnectorManager({ root, definitions: [fakeDefinition(async (values) => {
    if (values.password === "fake-rejected-secret") throw new Error("rejected fake-rejected-secret");
  })] });
  const tools = manager.managementTools();
  assert.deepEqual(tools.map((t) => t.name), ["list", "add_account", "update_account", "remove_account"]);
  const account = await callTool(tools, "add_account", { name: "qq-mail", values: credentials });
  assert.match(account.notice, /聊天记录里会留下授权码/);
  await callTool(tools, "update_account", { name: "qq-mail", id: account.id, values: { password: SECRET_MASK, label: credentials.password } });
  const listing = await callTool(tools, "list");
  assert.equal(listing.installed[0].accounts[0].label, SECRET_MASK);
  assert.equal(JSON.stringify(listing).includes(credentials.password), false);
  const error = await toolResult(tools, "add_account", { name: "qq-mail", values: { ...credentials, password: "fake-rejected-secret" } });
  assert.equal(error.isError, true);
  assert.equal(JSON.stringify(error).includes("fake-rejected-secret"), false);
  await callTool(tools, "remove_account", { name: "qq-mail", id: account.id });
  assert.equal(manager.redact("retired credential: " + credentials.password), "retired credential: " + SECRET_MASK);
});

test("known broken config and symlink paths fail closed without being overwritten", () => {
  const root = rootFor(), filename = file(root, "accounts.json");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, "invalid-json");
  assert.throws(() => new ConnectorManager({ root }), (e) => e.status === 500);
  assert.equal(fs.readFileSync(filename, "utf8"), "invalid-json");
  fs.rmSync(filename);
  fs.symlinkSync(path.join(root, "elsewhere"), filename);
  assert.throws(() => new ConnectorManager({ root }), (e) => e.status === 500);
});
