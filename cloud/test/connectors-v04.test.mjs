import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import registry from "../connectors/index.mjs";
import { createImapConnector } from "../connectors/_shared/imap.mjs";
import { createTavilyConnector } from "../connectors/tavily/index.mjs";
import { createWereadConnector, WEREAD_GATEWAY, WEREAD_SKILL_VERSION } from "../connectors/weread/index.mjs";
import { ConnectorManager, SECRET_MASK } from "../src/connectors.mjs";
import { startFakeImap } from "./fake-imap.mjs";
import { fakeConnectorApi } from "./fake-connector-api.mjs";
import { callTool, toolResult } from "./tool-call.mjs";

test("released catalog has seven independent mail providers plus Tavily/WeRead, real icon files and no legacy/custom/builtin fields", () => {
  assert.deepEqual(registry.map((d) => d.name), ["qq-mail", "netease-163", "netease-126", "gmail", "exmail", "aliyun-mail", "imap", "tavily", "weread"]);
  const manager = new ConnectorManager({ root: fs.mkdtempSync(path.join(testRoot, "catalog-")) });
  assert.deepEqual(Object.keys(manager.list()).sort(), ["catalog", "installed"]);
  for (const d of registry) {
    const icon = new URL(`../connectors/${d.name}/${d.icon}`, import.meta.url);
    assert.ok(fs.statSync(icon).size > 100);
    assert.equal(d.fields.some((f) => f.key === "preset"), false);
    assert.ok(d.fields.every((f) => ["text", "secret", "number", "select"].includes(f.type)));
    assert.ok(manager.list().catalog.find((c) => c.name === d.name).icon.endsWith(`/${d.name}/icon`));
  }
  assert.equal(registry.filter((d) => d.name !== "imap").slice(0, 6).every((d) => !d.fields.some((f) => ["host", "port"].includes(f.key))), true);
  assert.equal(registry.find((d) => d.name === "imap").fields.some((f) => f.key === "host"), true);
});

test("every independent mail provider uses the shared read-only IMAP wire code and keeps account/cursor namespaces separate", async (t) => {
  const root = fs.mkdtempSync(path.join(testRoot, "providers-")), fake = await startFakeImap(root), captured = [];
  t.after(() => fake.close());
  const hosts = { "qq-mail": "imap.qq.com", "netease-163": "imap.163.com", "netease-126": "imap.126.com", gmail: "imap.gmail.com", exmail: "imap.exmail.qq.com", "aliyun-mail": "imap.qiye.aliyun.com" };
  const definitions = registry.slice(0, 7).map((d) => createImapConnector({ name: d.name, title: d.title, host: hosts[d.name],
    needsID: ["netease-163", "netease-126"].includes(d.name), clientFactory: (opts) => { captured.push({ name: d.name, host: opts.host, port: opts.port, secure: opts.secure }); return fake.clientFactory(opts); } }));
  const manager = new ConnectorManager({ root, definitions });
  for (const definition of definitions) {
    const { host: _host, port: _port, ...fixed } = fake.values();
    const account = await manager.addAccount(definition.name, definition.name === "imap" ? fake.values() : fixed);
    const records = structuredClone(manager.accounts.get(definition.name));
    const tools = definition.tools(records, manager.context(definition.name, records));
    const batch = await callTool(tools, "read_since", { limit: 1 });
    assert.equal(batch.items[0].account, account.id);
    await callTool(tools, "sync_commit", { cursor: batch.cursor });
    assert.equal(manager.readState(definition.name).accounts[account.id].uid, 1);
    const wire = captured.find((o) => o.name === definition.name);
    assert.equal(wire.host, hosts[definition.name] || "127.0.0.1");
    assert.equal(wire.port, definition.name === "imap" ? fake.port : 993);
    assert.equal(wire.secure, true);
    await assert.rejects(manager.addAccount(definition.name, { ...fake.values(), preset: "qq" }), /不支持的配置字段/);
  }
  assert.equal(manager.list().installed.length, 7);
  assert.equal(fake.commands.some((c) => ["STORE", "SELECT", "APPEND", "DELETE", "EXPUNGE"].includes(c.command)), false);
});

test("Tavily fake HTTP uses Bearer, free usage test, search depth mapping and full extract; masks secrets and handles failures", async (t) => {
  const key = "tvly-FAKE-TEST-ONLY", root = fs.mkdtempSync(path.join(testRoot, "tavily-"));
  let fault = null;
  const api = await fakeConnectorApi((req) => {
    assert.equal(req.authorization, `Bearer ${key}`);
    if (fault === "invalid") return { rawBody: "not json" };
    if (fault) return { status: fault, data: { error: key } };
    if (req.path === "/usage") return { data: { key: { usage: 1, limit: 1000 } } };
    return { data: req.path === "/extract" ? { results: [{ url: req.body.urls[0], raw_content: "完整正文\n第二段", echo: key }] } : { results: [{ title: "调研结果", url: "https://example.test/", content: key }] } };
  });
  t.after(() => api.close());
  const definition = createTavilyConnector({ baseUrl: api.url });
  const manager = new ConnectorManager({ root, definitions: [definition] });
  await manager.addAccount("tavily", { apiKey: key });
  assert.equal(api.requests[0].method, "GET"); assert.equal(api.requests[0].path, "/usage"); assert.equal(api.requests[0].body, undefined);
  const records = structuredClone(manager.accounts.get("tavily")), tools = definition.tools(records, manager.context("tavily", records));
  const search = await callTool(tools, "search", { query: "深入调研", depth: "advanced", max_results: 7, time_range: "week" });
  assert.deepEqual(api.requests.at(-1).body, { query: "深入调研", search_depth: "advanced", max_results: 7, time_range: "week" });
  assert.equal(search.results[0].content, SECRET_MASK);
  const extract = await callTool(tools, "extract", { urls: ["https://example.test/article"] });
  assert.deepEqual(api.requests.at(-1).body, { urls: ["https://example.test/article"] });
  assert.equal(extract.results[0].raw_content, "完整正文\n第二段");
  await assert.rejects(callTool(tools, "search", { query: "x", max_results: 21 }));
  await assert.rejects(callTool(tools, "extract", { urls: ["file:///etc/passwd"] }));
  await assert.rejects(manager.addAccount("tavily", { apiKey: key }), /只支持一个账号/);
  for (const [status, expected] of [[401, /API Key 无效/], [429, /额度不足/], [503, /服务暂不可用/], ["invalid", /JSON 无法解析/]]) {
    fault = status;
    const failed = await toolResult(tools, "search", { query: "fake-error" });
    assert.equal(failed.isError, true); assert.match(failed.data.error, expected); assert.equal(JSON.stringify(failed).includes(key), false);
  }
  const disconnected = createTavilyConnector({ fetchImpl: async () => { throw new Error(key); } });
  await assert.rejects(disconnected.test({ apiKey: key }), /连接超时或网络不可用/);
  assert.equal(manager.list().installed[0].accounts[0].values.apiKey, SECRET_MASK);
});

test("official WeRead fake gateway verifies smallest notebook page and five tools with flat exact-case params/version, pagination, auth and upgrade errors", async (t) => {
  const key = "wrk-FAKE-TEST-ONLY", root = fs.mkdtempSync(path.join(testRoot, "weread-"));
  let fault = null;
  const api = await fakeConnectorApi((req) => {
    assert.equal(req.path, "/api/agent/gateway"); assert.equal(req.method, "POST"); assert.equal(req.authorization, `Bearer ${key}`);
    assert.equal(req.body.skill_version, WEREAD_SKILL_VERSION); assert.equal("params" in req.body, false);
    if (fault === "upgrade") return { data: { upgrade_info: { message: key } } };
    if (fault === "errcode") return { data: { errcode: -1, errmsg: key } };
    if (fault) return { status: fault };
    return { data: { errcode: 0, endpoint: req.body.api_name, echo: key, hasMore: 1, synckey: 123, totalReadTime: 3600, books: [], albums: [], mp: {} } };
  });
  t.after(() => api.close());
  assert.equal(WEREAD_GATEWAY, "https://i.weread.qq.com/api/agent/gateway");
  const definition = createWereadConnector({ gateway: api.url + "/api/agent/gateway" });
  const manager = new ConnectorManager({ root, definitions: [definition] });
  await assert.rejects(manager.addAccount("weread", { apiKey: "wrong-prefix" }), /wrk-/);
  assert.equal(api.requests.length, 0);
  await manager.addAccount("weread", { apiKey: key });
  assert.deepEqual(api.requests[0].body, { api_name: "/user/notebooks", count: 1, skill_version: WEREAD_SKILL_VERSION });
  const records = structuredClone(manager.accounts.get("weread")), tools = definition.tools(records, manager.context("weread", records));
  assert.deepEqual(tools.map((d) => d.name), ["shelf", "reading_stats", "highlights", "thoughts", "search_books"]);
  for (const [name, args, endpoint] of [
    ["shelf", {}, "/shelf/sync"], ["reading_stats", { mode: "weekly", baseTime: 1791648000 }, "/readdata/detail"],
    ["highlights", { bookId: "fake-book" }, "/book/bookmarklist"], ["thoughts", { bookid: "fake-book", count: 2, synckey: 123 }, "/review/list/mine"],
    ["search_books", { keyword: "三体", scope: 10, maxIdx: 15, count: 5 }, "/store/search"],
  ]) {
    const data = await callTool(tools, name, args);
    assert.deepEqual(api.requests.at(-1).body, { api_name: endpoint, ...args, skill_version: WEREAD_SKILL_VERSION });
    assert.equal(data.echo, SECRET_MASK);
  }
  await assert.rejects(callTool(tools, "search_books", { keyword: "x" }), /Invalid/);
  await assert.rejects(callTool(tools, "thoughts", { bookId: "wrong-case" }));
  for (const [kind, expected] of [["upgrade", /更新连接器版本/], ["errcode", /微信读书请求失败/], [401, /API Key 无效/]]) {
    fault = kind;
    const failed = await toolResult(tools, "shelf");
    assert.equal(failed.isError, true); assert.match(failed.data.error, expected); assert.equal(JSON.stringify(failed).includes(key), false);
  }
  const rejectedRoot = fs.mkdtempSync(path.join(testRoot, "weread-rejected-"));
  const rejected = new ConnectorManager({ root: rejectedRoot, definitions: [definition] });
  await assert.rejects(rejected.addAccount("weread", { apiKey: key }), /API Key 无效/);
  assert.equal(fs.existsSync(path.join(rejectedRoot, "system/connectors/weread/accounts.json")), false);
});
