import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createDeepSeekSearchConnector } from "../connectors/deepseek-search/index.mjs";
import { ConnectorManager, SECRET_MASK } from "../src/connectors.mjs";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { initialize } from "../src/initialize.mjs";
import { startServer } from "../src/server.mjs";
import { config } from "../src/config.mjs";
import { fakeConnectorApi } from "./fake-connector-api.mjs";
import { callTool, toolResult } from "./tool-call.mjs";

const KEY = "sk-synthetic-deepseek-test-only";
const BALANCE = { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "10.00", granted_balance: "0.00", topped_up_balance: "10.00" }] };
const SEARCH = { results: [{ title: "Example", url: "https://example.test/article", snippet: "Short summary", summary: "A useful summary", content: "", rerank_score: 2.4, site_name: null, site_icon: null, date: null, authority: -1 }] };

async function fixture(t, handler, options = {}) {
  const root = fs.mkdtempSync(path.join(testRoot, "deepseek-"));
  const api = await fakeConnectorApi(req => req.path === "/user/balance" ? { data: BALANCE } : handler(req));
  t.after(() => api.close());
  const definition = createDeepSeekSearchConnector({ baseUrl: api.url, ...options });
  const manager = new ConnectorManager({ root, definitions: [definition] });
  await manager.addAccount("deepseek-search", { apiKey: KEY });
  return { root, api, definition, manager, tools: () => manager.toolGroups()["deepseek-search"] };
}

test("DeepSeek uses Bearer, verifies via balance only, preserves search syntax and returns full Markdown", async t => {
  const { root, api, manager, tools } = await fixture(t, req => {
    assert.equal(req.authorization, `Bearer ${KEY}`);
    assert.equal(req.method, "POST");
    if (req.path === "/v1/tools/fetch") return { data: { title: "Example", content: "# Full text\n\n" + "Details\n".repeat(5000) } };
    return { data: { results: [{ ...SEARCH.results[0], content: req.body.need_content ? "Full content " + KEY : "" }] } };
  });
  assert.deepEqual(api.requests[0], { method: "GET", path: "/user/balance", authorization: `Bearer ${KEY}`, headers: api.requests[0].headers, body: undefined });
  assert.equal(api.requests.length, 1, "connecting must not consume a search/fetch request");
  const query = 'DeepSeek site:example.test lang:zh after:2026-01-01 -"广告"';
  const search = await callTool(tools(), "search", { query, count: 50, ori_question: "查官方发布", need_content: true });
  assert.deepEqual(api.requests.at(-1).body, { query, count: 50, ori_question: "查官方发布", need_content: true });
  assert.equal(search.results[0].content, "Full content " + SECRET_MASK);
  assert.equal(search.results[0].authority, -1); assert.equal(search.results[0].date, null);
  assert.equal(typeof search.connector_account, "string");
  const fetched = await callTool(tools(), "fetch", { url: "https://example.test/article" });
  assert.equal(api.requests.at(-1).path, "/v1/tools/fetch");
  assert.deepEqual(api.requests.at(-1).body, { url: "https://example.test/article" });
  assert.equal(fetched.content, "# Full text\n\n" + "Details\n".repeat(5000), "do not silently truncate the actual article");
  const accountFile = path.join(root, "system/connectors/deepseek-search/accounts.json");
  assert.equal(fs.statSync(accountFile).mode & 0o777, 0o600);
  assert.equal(manager.list().installed[0].accounts[0].values.apiKey, SECRET_MASK);
  assert.ok(!JSON.stringify(manager.list()).includes(KEY));
  assert.ok(!JSON.stringify(tools().map(({ parameters }) => parameters)).includes(KEY));
  await assert.rejects(manager.addAccount("deepseek-search", { apiKey: KEY }), /已经添加过/);
});

test("DeepSeek validates Unicode query boundaries and URLs before making paid requests; empty results are valid", async t => {
  const { api, tools } = await fixture(t, () => ({ data: { results: [] } }));
  for (const args of [{}, { query: " " }, { query: "x".repeat(129) }, { query: "x", count: 0 }, { query: "x", count: 51 },
    { query: "x", count: 1.5 }, { query: "x", ori_question: "😀".repeat(129) }]) {
    await assert.rejects(callTool(tools(), "search", args));
  }
  for (const url of ["file:///etc/passwd", "ftp://example.test/a", "https://user:secret@example.test/", "https://example.test/" + "x".repeat(8192)]) {
    await assert.rejects(callTool(tools(), "fetch", { url }));
  }
  assert.equal(api.requests.length, 1);
  const result = await callTool(tools(), "search", { query: "😀".repeat(128) });
  assert.deepEqual(result.results, []);
  assert.deepEqual(api.requests.at(-1).body, { query: "😀".repeat(128), count: 5, need_content: false });
  assert.equal("localization" in api.requests.at(-1).body, false, "do not infer/upload a user's IP address");
});

test("DeepSeek switches accounts only on 402 and discovers top-ups after cooldown or explicit retest", async t => {
  let now = 1000, firstEmpty = true;
  const { api, manager, tools } = await fixture(t, req => firstEmpty && req.authorization === `Bearer ${KEY}`
    ? { status: 402, data: { error: { message: KEY } } } : { data: SEARCH }, { now: () => now });
  const first = manager.accounts.get("deepseek-search")[0];
  const backup = await manager.addAccount("deepseek-search", { apiKey: "sk-synthetic-backup-test-only", label: "备用" });
  assert.equal((await callTool(tools(), "search", { query: "test" })).connector_account, backup.id);
  const failedCount = () => api.requests.filter(req => req.path === "/v1/tools/search" && req.authorization === `Bearer ${KEY}`).length;
  assert.equal(failedCount(), 1);
  assert.equal(manager.readState("deepseek-search").queryAccounts.blocked[first.id].retryAt, 61000);
  const restarted = new ConnectorManager({ root: manager.root, definitions: [manager.definition("deepseek-search")] });
  await callTool(restarted.toolGroups()["deepseek-search"], "search", { query: "again" });
  assert.equal(failedCount(), 1, "a restart must retain the depleted-account cooldown");
  await manager.removeAccount("deepseek-search", backup.id);
  assert.equal((await toolResult(tools(), "search", { query: "test" })).isError, true);
  assert.equal(failedCount(), 1, "no repeated paid probe while all accounts are cooling down");
  firstEmpty = false; now = 61001;
  assert.equal((await callTool(tools(), "search", { query: "recharged" })).connector_account, first.id);
  firstEmpty = true;
  assert.equal((await toolResult(tools(), "fetch", { url: "https://example.test/" })).isError, true);
  firstEmpty = false;
  await manager.testAccount("deepseek-search", first.id);
  assert.equal(manager.readState("deepseek-search").queryAccounts.blocked[first.id], undefined);
});

test("DeepSeek authentication, policy, rate-limit, malformed and transport failures stay distinct and do not switch accounts", async t => {
  let response = { status: 401, data: { error: { message: KEY } } };
  const { api, manager, tools } = await fixture(t, () => response);
  await manager.addAccount("deepseek-search", { apiKey: "sk-synthetic-backup-test-only" });
  for (const [status, match] of [[401, /API Key 无效/], [403, /拒绝访问这个网页/], [404, /未能提取/], [408, /超时/], [429, /请求过于频繁/], [503, /服务暂不可用/], [504, /超时/]]) {
    response = { status, data: { error: { message: KEY } } };
    const before = api.requests.length, result = await toolResult(tools(), "fetch", { url: "https://example.test/" });
    assert.equal(result.isError, true); assert.match(result.data.error, match);
    assert.ok(!JSON.stringify(result).includes(KEY));
    assert.equal(api.requests.length, before + 1, `HTTP ${status} must not cause a retry on another key`);
  }
  for (const bad of [{ rawBody: "not json" }, { data: { error: KEY } }, { data: { results: [{ title: "incomplete" }] } }]) {
    response = bad;
    const result = await toolResult(tools(), "search", { query: "test" });
    assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes(KEY));
  }
  const offline = createDeepSeekSearchConnector({ fetchImpl: async () => { throw new Error(KEY); } });
  await assert.rejects(offline.test({ apiKey: KEY }), /连接超时或网络不可用/);
  const invalidBalance = createDeepSeekSearchConnector({ fetchImpl: async () => new Response(JSON.stringify({ error: KEY })) });
  await assert.rejects(invalidBalance.test({ apiKey: KEY }), /余额格式不正确/);
});

test("App HTTP catalog/form/balance/icon and native dynamic tool routing work without choosing a DeepSeek model", async t => {
  const api = await fakeConnectorApi(req => ({ data: req.path === "/user/balance" ? BALANCE : SEARCH }));
  t.after(() => api.close());
  // This test process forwards only the official balance host to the isolated fake.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => realFetch(typeof input === "string" && input.startsWith("https://api.deepseek.com/") ? api.url + new URL(input).pathname : input, options);
  t.after(() => { globalThis.fetch = realFetch; });
  initialize(config.root);
  const bus = { emit() {}, on() {} }, hub = new DeviceHub();
  const definition = createDeepSeekSearchConnector({ baseUrl: api.url });
  const connectors = new ConnectorManager({ root: config.root, definitions: [definition] });
  const harness = new Harness({ hub, bus, connectors, runtime: { close: async () => {} } });
  t.after(() => harness.close());
  harness.history.put("search-routing", { status: "running" });
  harness.sessionRuns.set("agent:main:main", { id: "search-routing" });
  const server = startServer({ harness, hub, bus, connectors, log() {}, listen: { host: "127.0.0.1", port: 0 } });
  await once(server, "listening");
  t.after(async () => { server.closeSockets(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${config.token}`, "x-doudou-protocol": "2", "content-type": "application/json" };
  const get = async () => (await realFetch(endpoint + "/api/connectors", { headers })).json();
  assert.equal((await get()).cloud.catalog[0].title, "DeepSeek Search");
  assert.equal("deepseek-search" in connectors.toolGroups(), false, "unconnected services do not load tool schemas");
  const saved = await realFetch(endpoint + "/api/connectors/deepseek-search/accounts", { method: "POST", headers, body: JSON.stringify({ values: { apiKey: KEY, label: "测试账号" } }) });
  assert.equal(saved.status, 201); const account = await saved.json();
  const installed = (await get()).cloud.installed[0];
  assert.equal(installed.usage.items[0].remaining, 10); assert.equal(installed.accounts[0].values.apiKey, SECRET_MASK);
  assert.ok(!JSON.stringify(installed).includes(KEY));
  const icon = await realFetch(endpoint + installed.icon, { headers });
  assert.equal(icon.status, 200); assert.match(icon.headers.get("content-type"), /image\/png/);
  assert.equal(Buffer.from(await icon.arrayBuffer()).readUInt32BE(0), 0x89504e47);
  const schema = JSON.parse((await harness.productTool("catalog", { sessionKey: "agent:main:main", group: "deepseek-search" })).content[0].text);
  assert.deepEqual(schema.map(tool => tool.name), ["deepseek-search.search", "deepseek-search.fetch"]);
  const reply = await harness.productTool("call", { sessionKey: "agent:main:main", name: "deepseek-search.search", args_json: JSON.stringify({ query: "最新官方文档" }) });
  assert.notEqual(reply.isError, true); assert.equal(JSON.parse(reply.content[0].text).results[0].url, SEARCH.results[0].url);
  assert.ok(harness.taskHistory("search-routing").items.some(item => item.tool === "deepseek-search.search"));
  const deleted = await realFetch(endpoint + `/api/connectors/deepseek-search/accounts/${account.id}`, { method: "DELETE", headers });
  assert.equal(deleted.status, 200); assert.equal("deepseek-search" in connectors.toolGroups(), false);
});
