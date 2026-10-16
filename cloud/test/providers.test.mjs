import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { Providers, readProviders, testProvider } from "../src/providers.mjs";
import { getAppSettings, putAppSettings, readAppSettings, DEFAULT_SETTINGS, selectedModel, providerEnvironment } from "../src/app-settings.mjs";
import { migrateV081 } from "../src/migrate-v081.mjs";
import { ConnectorManager } from "../src/connectors.mjs";
import { checkConnectorAccess } from "../src/connector-guard.mjs";
import { fakeAnthropic } from "./fake-anthropic.mjs";
import { messagesRequest } from "../src/messages-api.mjs";

const input = (extra = {}) => ({ name: "本地测试服务", baseUrl: "https://models.example.test/anthropic/", apiKey: "fake-provider-secret-1234", models: [{ id: "fixture-basic-v1", name: "基础模型" }], ...extra });
function fixture(probe) {
  const root = fs.mkdtempSync(path.join(testRoot, "provider-")), calls = [], connectors = new ConnectorManager({ root });
  const providers = new Providers({ root, connectors, selected: () => readAppSettings(root).model,
    probe: probe || (async (value) => { calls.push(value); return { ok: true, ms: 1 }; }) });
  return { root, providers, calls, connectors };
}

test("startup migrates a model string once with a private backup, then runtime accepts only provider/id", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "provider-migration-")), file = path.join(root, "system/app-settings.json");
  fs.mkdirSync(path.dirname(file)); const old = { model: "z-ai/glm-5.3-flash", permissionMode: "bypassPermissions" };
  fs.writeFileSync(file, JSON.stringify(old), { mode: 0o644 });
  assert.throws(() => readAppSettings(root), /已有服务/);
  const result = migrateV081({ root });
  assert.equal(result.migrated, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, result.backup), "utf8")), old);
  assert.deepEqual(readAppSettings(root), { model: { provider: "zenmux", id: old.model }, permissionMode: old.permissionMode });
  for (const rel of ["system/app-settings.json", "system/providers.json", "system/migrations/v081-providers.json", result.backup]) assert.equal(fs.statSync(path.join(root, rel)).mode & 0o777, 0o600);
  assert.deepEqual(migrateV081({ root }), { migrated: false });
  fs.writeFileSync(file, JSON.stringify(old)); assert.throws(() => readAppSettings(root), /已有服务/);
});

test("migration initializes fresh settings, retires obsolete builtins, and refuses damaged or symlinked input", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "provider-fresh-")); migrateV081({ root });
  assert.deepEqual(readAppSettings(root), DEFAULT_SETTINGS);
  for (const body of ["bad JSON", JSON.stringify({ model: "old-model", permissionMode: "default" })]) {
    const dir = fs.mkdtempSync(path.join(testRoot, "provider-bad-")), file = path.join(dir, "system/app-settings.json");
    fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, body);
    assert.throws(() => migrateV081({ root: dir }), /损坏/); assert.equal(fs.readFileSync(file, "utf8"), body);
  }
  const dir = fs.mkdtempSync(path.join(testRoot, "provider-obsolete-")); fs.mkdirSync(path.join(dir, "system"));
  const file = path.join(dir, "system/app-settings.json"); fs.writeFileSync(file, JSON.stringify({ model: "old-model", permissionMode: "auto" }));
  migrateV081({ root: dir }); assert.deepEqual(readAppSettings(dir), DEFAULT_SETTINGS);
  const linked = fs.mkdtempSync(path.join(testRoot, "provider-linked-")); fs.mkdirSync(path.join(linked, "system"));
  fs.symlinkSync(file, path.join(linked, "system/app-settings.json")); assert.throws(() => migrateV081({ root: linked }), /符号链接/);
});

test("provider CRUD tests before save, keeps empty or omitted keys, and exposes only a key hint", async () => {
  const { root, providers, calls, connectors } = fixture();
  const saved = await providers.create(input());
  assert.equal(saved.keyHint, "1234"); assert.equal(saved.protocol, "anthropic"); assert.equal(saved.builtin, false);
  assert.equal(saved.baseUrl, "https://models.example.test/anthropic"); assert.equal(calls.length, 1);
  const settings = getAppSettings(root); assert.deepEqual(settings.model, DEFAULT_SETTINGS.model);
  assert.equal(settings.providers[0].builtin, true); assert.equal("baseUrl" in settings.providers[0], false); assert.equal("keyHint" in settings.providers[0], false);
  const renamed = await providers.patch(saved.id, { name: "新名称", apiKey: "" }); assert.equal(renamed.keyHint, "1234"); assert.equal(calls.length, 1);
  await providers.patch(saved.id, { apiKey: "fake-provider-replacement-5678", models: [{ id: "fixture-two", name: "第二个模型" }] });
  assert.equal(calls.length, 2); assert.equal(calls.at(-1).apiKey, "fake-provider-replacement-5678");
  const kept = await providers.patch(saved.id, { baseUrl: "http://localhost:12345" }); assert.equal(kept.keyHint, "5678");
  for (const response of [saved, renamed, kept, getAppSettings(root)]) assert.doesNotMatch(JSON.stringify(response), /fake-provider-secret|fake-provider-replacement|apiKey/);
  assert.equal(connectors.redact("fake-provider-secret-1234 fake-provider-replacement-5678"), "•••• ••••");
  assert.equal(fs.statSync(path.join(root, "system/providers.json")).mode & 0o777, 0o600);
  assert.deepEqual(await providers.remove(saved.id), { ok: true }); assert.equal(getAppSettings(root).providers.length, 1);
});

test("selected providers and selected models cannot be deleted, and builtin records cannot be edited", async () => {
  const { root, providers } = fixture(), p = await providers.create(input());
  putAppSettings(root, { model: { provider: p.id, id: p.models[0].id } });
  await assert.rejects(providers.remove(p.id), (e) => e.status === 409 && e.message === "先换到别的模型");
  await assert.rejects(providers.patch(p.id, { models: [{ id: "other", name: "另一个" }] }), (e) => e.status === 409);
  assert.throws(() => putAppSettings(root, { model: { provider: p.id, id: "unknown" } }), /已有服务/);
  assert.throws(() => putAppSettings(root, { model: p.models[0].id }), /已有服务/);
  for (const action of [() => providers.patch("zenmux", { name: "覆盖" }), () => providers.remove("zenmux")]) await assert.rejects(action(), /内置/);
  putAppSettings(root, { model: DEFAULT_SETTINGS.model }); await providers.remove(p.id);
});

test("provider validation rejects malformed URLs, bounds, duplicates and protocol changes before a request", async () => {
  const { root, providers, calls } = fixture();
  for (const patch of [
    { name: "" }, { name: "名".repeat(41) }, { baseUrl: "ftp://example.test" }, { baseUrl: "https://example.test?a=1" },
    { baseUrl: "https://example.test#x" }, { baseUrl: "https://example.test?" }, { baseUrl: "https://example.test#" }, { baseUrl: "https://name:password@example.test" }, { apiKey: "" }, { apiKey: "bad\nkey" },
    { models: [] }, { models: Array(21).fill({ id: "x", name: "模型" }) }, { models: [{ id: "x".repeat(201), name: "模型" }] },
    { models: [{ id: "x", name: "名".repeat(41) }] }, { models: [{ id: "x", name: "一" }, { id: "x", name: "二" }] }, { protocol: "openai" },
  ]) await assert.rejects(providers.create(input(patch)));
  assert.equal(calls.length, 0); assert.deepEqual(readProviders(root), []);
});

test("failed tests never save providers or replacement keys, including an edit raced by selection", async () => {
  const { root, providers } = fixture(async () => { throw new Error("fixture failed"); });
  await assert.rejects(providers.create(input()), /fixture failed/); assert.equal(readProviders(root).length, 0);
  const f = fixture(), p = await f.providers.create(input());
  f.providers.probe = async () => { throw new Error("fixture failed"); };
  await assert.rejects(f.providers.patch(p.id, { apiKey: "fake-new-secret-9999" }), /fixture failed/);
  assert.equal(readProviders(f.root)[0].apiKey, input().apiKey);
  f.providers.probe = async () => { putAppSettings(f.root, { model: { provider: p.id, id: p.models[0].id } }); return { ok: true, ms: 1 }; };
  await assert.rejects(f.providers.patch(p.id, { models: [{ id: "new", name: "新模型" }] }), (e) => e.status === 409);
  assert.equal(readProviders(f.root)[0].models[0].id, p.models[0].id);
});

test("connection probe uses basic Messages, both auth headers and version, with bounded redacted errors", async (t) => {
  const key = "fake-probe-secret-7777";
  let count = 0;
  const api = await fakeAnthropic((body, _index, { headers }) => {
    assert.equal(body.model, "basic-model"); assert.equal(body.max_tokens, 8);
    assert.equal(body.thinking, undefined); assert.equal(body.output_config, undefined);
    assert.equal(headers["x-api-key"], key); assert.equal(headers.authorization, "Bearer " + key); assert.equal(headers["anthropic-version"], "2023-06-01");
    return count++ ? { status: 401, error: "bad key " + key + " ".repeat(8) + "extra".repeat(80) } : {};
  }); t.after(() => api.close());
  const params = { baseUrl: api.url, apiKey: key, model: "basic-model" };
  assert.equal((await testProvider(params)).ok, true);
  await assert.rejects(testProvider(params), (e) => e.message.startsWith("HTTP 401：bad key ••••") && !e.message.includes(key) && e.message.length < 220);
  await assert.rejects(testProvider(params, { timeout: 15, request: (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }) }), /连接失败或超时/);
});

test("small Messages calls honor HTTP_PROXY without leaking keys into proxy URLs", async (t) => {
  let received;
  const proxy = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received = { url: req.url, host: req.headers.host, auth: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"content":[]}');
  }); proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  await testProvider({ baseUrl: "http://not-resolved.example.test/anthropic", apiKey: "fake-proxy-test-key", model: "basic" }, { env: { HTTP_PROXY: "http://127.0.0.1:" + proxy.address().port }, request: messagesRequest });
  assert.equal(received.url, "http://not-resolved.example.test/anthropic/v1/messages"); assert.equal(received.auth, "Bearer fake-proxy-test-key");
  assert.equal(received.body.model, "basic"); assert.equal(received.url.includes("fake-proxy"), false);
});

test("custom selection replaces auth, preserves proxy variables and blocks private provider file tools", async () => {
  const { root, providers } = fixture(), p = await providers.create(input()); putAppSettings(root, { model: { provider: p.id, id: p.models[0].id } });
  const env = providerEnvironment(selectedModel(root), { ANTHROPIC_API_KEY: "fake-old-key", ANTHROPIC_AUTH_TOKEN: "fake-old-token", HTTPS_PROXY: "http://127.0.0.1:12345", PATH: "/test/bin" });
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, input().apiKey); assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.ANTHROPIC_BASE_URL, p.baseUrl);
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:12345"); assert.equal(env.PATH, "/test/bin");
  const file = path.join(root, "system/providers.json");
  for (const tool_name of ["Read", "Write", "Edit", "Glob", "Grep", "Bash"]) {
    const result = checkConnectorAccess({ tool_name, tool_input: { file_path: file, path: root, pattern: "system/providers.json", command: "cat system/providers.json" } }, { root });
    assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  }
  const alias = path.join(root, "provider-alias.json"); fs.symlinkSync(file, alias);
  assert.equal(checkConnectorAccess({ tool_name: "Read", tool_input: { file_path: alias } }, { root }).hookSpecificOutput.permissionDecision, "deny");
  fs.rmSync(file); fs.symlinkSync(alias, file); assert.throws(() => readProviders(root), /符号链接/);
});
