import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ConnectorManager, SECRET_MASK } from "../src/connectors.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { startServer } from "../src/server.mjs";
import { config } from "../src/config.mjs";
import { createTavilyConnector } from "../connectors/tavily/index.mjs";
import { createWindConnector } from "../connectors/wind/index.mjs";
import { queryAccounts, QuotaExhaustedError, nextMonth, nextChinaDay, secretPreview } from "../connectors/_shared/query-accounts.mjs";
import { fakeConnectorApi } from "./fake-connector-api.mjs";
import { callTool, toolResult } from "./tool-call.mjs";

const KEYS = ["tvly-fake-primary-001234", "tvly-fake-backup-005678"];
function toolsFor(manager, definition) {
  const accounts = structuredClone(manager.accounts.get(definition.name));
  return definition.tools(accounts, manager.context(definition.name, accounts));
}
async function tavily(t, handler, options = {}) {
  const root = fs.mkdtempSync(path.join(testRoot, "pool-tavily-"));
  const api = await fakeConnectorApi((req) => req.path === "/usage" ? { data: { key: { usage: 0, limit: 1000 } } } : handler(req));
  t.after(() => api.close());
  const definition = createTavilyConnector({ baseUrl: api.url, ...options });
  const manager = new ConnectorManager({ root, definitions: [definition] });
  const accounts = [];
  for (const [i, apiKey] of KEYS.entries()) accounts.push(await manager.addAccount("tavily", { apiKey, label: `账号 ${i + 1}` }));
  return { root, api, definition, manager, accounts, tools: toolsFor(manager, definition) };
}
const search = (tools) => callTool(tools, "search", { query: "核验公司公告", depth: "advanced", time_range: "week", max_results: 3 });

test("Tavily retries the identical query once on explicit quota, shares cooldown across isolated queries and restarts", async (t) => {
  const setup = await tavily(t, (req) => req.authorization === `Bearer ${KEYS[0]}` ? { status: 432 } : { data: { results: [{ title: "公司公告", content: KEYS.join(" ") }] } });
  const { manager, definition, accounts, root, api, tools } = setup;
  const result = await search(tools);
  assert.equal(result.connector_account, accounts[1].id);
  assert.equal(result.results[0].content, `${SECRET_MASK} ${SECRET_MASK}`);
  const calls = api.requests.filter((req) => req.path === "/search");
  assert.deepEqual(calls.map((req) => req.authorization), KEYS.map((key) => `Bearer ${key}`));
  assert.deepEqual(calls[0].body, calls[1].body);
  assert.equal((await search(toolsFor(manager, definition))).connector_account, accounts[1].id);
  const restarted = new ConnectorManager({ root, definitions: [definition] });
  assert.equal((await search(toolsFor(restarted, definition))).connector_account, accounts[1].id);
  assert.equal((await callTool(toolsFor(restarted, definition), "extract", { urls: ["https://example.test/filing"] })).connector_account, accounts[1].id);
  assert.deepEqual(api.requests.at(-1).body, { urls: ["https://example.test/filing"] });
  assert.equal(api.requests.filter((req) => req.path === "/search" && req.authorization === `Bearer ${KEYS[0]}`).length, 1);
  assert.equal(restarted.list().installed[0].accounts[0].status, "quota");
  const stateFile = path.join(root, "system/connectors/tavily/state.json");
  const state = fs.readFileSync(stateFile, "utf8");
  for (const key of KEYS) assert.equal(state.includes(key), false);
  assert.equal(state.includes("核验公司公告"), false);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.notEqual(manager.mcpServers().tavily.instance, manager.mcpServers().tavily.instance, "query transports must remain isolated");
});

test("Tavily distinguishes official quota failures from ordinary throttling, authentication, server and parse errors", async (t) => {
  const cases = [
    { status: 433, data: {}, rotate: true },
    { status: 402, data: { error: { message: "Insufficient credits" } }, rotate: true },
    { status: 429, data: { detail: "Your monthly quota has been exhausted" }, rotate: true },
    { status: 403, data: { error: "积分余额不足" }, rotate: true },
    { status: 429, data: { error: "Too many requests; retry later" }, rotate: false },
    { status: 401, data: { error: "invalid API key" }, rotate: false },
    { status: 403, data: { error: "Feature not available on this plan" }, rotate: false },
    { status: 503, data: { error: "Service temporarily unavailable" }, rotate: false },
    { status: 200, rawBody: "not-json", rotate: false },
  ];
  for (const fixture of cases) await t.test(`${fixture.status} ${JSON.stringify(fixture.data || fixture.rawBody)}`, async (t) => {
    const { api, tools, accounts, manager } = await tavily(t, (req) => req.authorization === `Bearer ${KEYS[0]}` ? fixture : { data: { results: [] } });
    const result = await toolResult(tools, "search", { query: "x" });
    assert.equal(result.isError, !fixture.rotate);
    assert.equal(api.requests.filter((req) => req.path === "/search").length, fixture.rotate ? 2 : 1);
    if (fixture.rotate) assert.equal(result.data.connector_account, accounts[1].id);
    else assert.equal(manager.readState("tavily").queryAccounts, undefined);
  });
});

test("Tavily never rotates on network failures or quota words inside successful search results", async (t) => {
  let disconnect = true;
  const { tools, api, accounts } = await tavily(t, () => ({ data: { results: [{ content: "报道提到积分余额不足" }] } }), {
    fetchImpl: (url, init) => disconnect && url.endsWith("/search") ? Promise.reject(new Error("offline")) : fetch(url, init),
  });
  assert.equal((await toolResult(tools, "search", { query: "x" })).isError, true);
  assert.equal(api.requests.some((req) => req.path === "/search"), false);
  disconnect = false;
  const result = await search(tools);
  assert.equal(result.connector_account, accounts[0].id);
  assert.equal(api.requests.filter((req) => req.path === "/search").length, 1);
});

test("exhausted accounts are not hammered; retest, replacing credentials and removal clear the appropriate cooldown", async (t) => {
  let available = false;
  const { manager, tools, api, definition, accounts } = await tavily(t, (req) => available || req.authorization.includes("replacement") ? { data: { results: [] } } : { status: 432 });
  const first = await toolResult(tools, "search", { query: "x" });
  assert.match(first.data.error, /所有已配置账号/);
  const count = api.requests.length;
  await toolResult(tools, "search", { query: "x" });
  assert.equal(api.requests.length, count);
  available = true;
  await manager.testAccount("tavily", accounts[0].id);
  assert.equal((await search(tools)).connector_account, accounts[0].id);
  available = false;
  await toolResult(tools, "search", { query: "x" });
  await assert.rejects(manager.updateAccount("tavily", accounts[0].id, { apiKey: KEYS[1] }), /已经添加过/);
  await manager.updateAccount("tavily", accounts[0].id, { apiKey: "tvly-fake-replacement-009999" });
  assert.equal(manager.readState("tavily").queryAccounts.blocked[accounts[0].id], undefined);
  assert.equal((await toolResult(tools, "search", { query: "x" })).isError, true, "old query snapshots must not use changed credentials");
  assert.equal((await search(toolsFor(manager, definition))).connector_account, accounts[0].id);
  await manager.removeAccount("tavily", accounts[0].id);
  assert.equal(manager.readState("tavily").queryAccounts.activeId, undefined);
});

test("quota cooldown expires on schedule and a concurrent late success cannot revive a newly exhausted account", async () => {
  let now = Date.UTC(2026, 9, 31, 23, 59), saved = {};
  const accounts = KEYS.map((apiKey, i) => ({ id: String(i), values: { apiKey } }));
  const ctx = { readState: () => structuredClone(saved), writeState: (state) => { saved = structuredClone(state); } };
  const pool = queryAccounts(accounts, ctx, { title: "测试", now: () => now });
  const exhausted = () => { throw new QuotaExhaustedError("额度耗尽", nextMonth(now)); };
  await assert.rejects(pool.run(exhausted), /所有已配置账号/);
  await assert.rejects(pool.run(() => "must not run", { account: "0" }), /指定账号额度/);
  now = nextMonth(now);
  assert.equal((await pool.run(() => "recovered")).value, "recovered");
  let release;
  const late = pool.run(() => new Promise((resolve) => { release = resolve; }), { account: "0" });
  await assert.rejects(pool.run(exhausted, { account: "0" }), /指定账号额度/);
  release("old successful response");
  await late;
  assert.ok(saved.queryAccounts.blocked["0"]);
  await assert.rejects(pool.run(() => "must not run", { account: "0" }), /指定账号额度/);
  assert.equal(nextChinaDay(Date.UTC(2026, 9, 16, 15, 59)), Date.UTC(2026, 9, 16, 16));
  assert.equal(nextChinaDay(Date.UTC(2026, 9, 16, 16)), Date.UTC(2026, 9, 17, 16));
});

test("App HTTP lists distinguishable secret hints while model tools and editable values stay fully masked", async (t) => {
  const root = fs.mkdtempSync(path.join(testRoot, "secret-hints-"));
  const password = "fake-password-123456789", authorization = "abcdef", key = KEYS[0];
  const definition = { name: "fixture", title: "表单", description: "测试", multiAccount: true, icon: "icon.png",
    fields: [{ key: "label", label: "备注", type: "text" }, { key: "apiKey", label: "API Key", type: "secret" },
      { key: "password", label: "密码", type: "secret" }, { key: "authorization", label: "授权码", type: "secret" }],
    label: (values) => values.label, test: async () => {}, tools: () => [] };
  const manager = new ConnectorManager({ root, definitions: [definition] });
  const added = await manager.addAccount("fixture", { label: "常用", apiKey: key, password, authorization });
  const bus = { on: () => {}, emit: () => {} };
  const server = startServer({ harness: { busy: false, running: new Map(), connectors: manager }, hub: new DeviceHub(), bus, log: () => {}, connectors: manager, listen: { port: 0, host: "127.0.0.1" } });
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/connectors`, { headers: { Authorization: `Bearer ${config.token}` } });
  assert.equal(response.status, 200);
  const body = await response.json(), account = body.cloud.installed[0].accounts[0];
  for (const [title, value] of [["API Key", key], ["密码", password], ["授权码", authorization]]) {
    assert.ok(account.label.includes(`${title}: ${secretPreview(value)}`));
    assert.equal(JSON.stringify(body).includes(value), false);
  }
  assert.equal(account.values.apiKey, SECRET_MASK);
  assert.equal(account.values.password, SECRET_MASK);
  assert.equal(account.values.authorization, SECRET_MASK);
  const modelList = await callTool(manager.managementTools(), "list");
  assert.equal(modelList.installed[0].accounts[0].label, "常用");
  assert.equal(JSON.stringify(modelList).includes(secretPreview(key)), false);
  await manager.updateAccount("fixture", added.id, { ...account.values, label: "备用" });
  assert.equal(manager.find("fixture", added.id).values.apiKey, key);
  assert.equal(manager.find("fixture", added.id).values.password, password);
  assert.equal(manager.list({ forApp: true }).installed[0].accounts[0].label.startsWith("备用 ·"), true);
  assert.equal(secretPreview("xy"), SECRET_MASK);
  assert.equal(secretPreview("123456"), "1••••6");
  assert.equal(secretPreview("a".repeat(40) + "z"), "aaaa••••aaaz");
});

// Real local MCP transport: test actual initialize/tools-call and Alice SSE, not a mocked pool callback.
async function wind(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), key = req.headers.authorization?.replace(/^Bearer /, "");
    const request = { route: req.url, body, key };
    requests.push(request);
    const result = await handler(request);
    if (result?.status) { res.writeHead(result.status, { "Content-Type": "application/json" }); return res.end(JSON.stringify(result.data || {})); }
    if (req.url === "/skills/alice") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of result?.events || []) res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, ...event })}\n\n`);
      return res.end();
    }
    const mcp = new McpServer({ name: "wind-account-fixture", version: "1.0.0" });
    mcp.registerTool("quote", { description: "本地证券数据", inputSchema: { symbol: z.string(), cursor: z.string().optional() } }, async () => result?.toolResult || { content: [{ type: "text", text: "本地假数据" }] });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    res.on("close", () => { mcp.close().catch(() => {}); });
    await transport.handleRequest(req, res, body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const root = fs.mkdtempSync(path.join(testRoot, "pool-wind-"));
  const definition = { ...createWindConnector({ baseUrl: `http://127.0.0.1:${server.address().port}` }), install: undefined, uninstall: undefined };
  const manager = new ConnectorManager({ root, definitions: [definition] }), accounts = [];
  for (const [i, apiKey] of KEYS.entries()) accounts.push(await manager.addAccount("wind", { apiKey, label: `Wind ${i + 1}` }));
  requests.length = 0;
  return { manager, definition, accounts, requests, tools: toolsFor(manager, definition) };
}
const windCall = (tools, extra = {}) => callTool(tools, "call", { server: "stock_data", tool: "quote", args: { symbol: "600519.SH" }, ...extra });
const quotaResult = { isError: true, content: [{ type: "text", text: '{"code":"QUOTA_ERROR","message":"积分余额不足"}' }] };
const aliceResult = { result: { kind: "artifact-update", artifact: { name: "agentResult", parts: [{ kind: "data", data: { data: "本地分析" } }] } } };

test("Wind retries an explicit HTTP-200 MCP quota error on backup and preserves account hints", async (t) => {
  const { tools, accounts, requests, manager } = await wind(t, (req) => req.body.method === "tools/call" && req.key === KEYS[0] ? { toolResult: quotaResult } : undefined);
  const result = await windCall(tools);
  assert.equal(result.connector_account, accounts[1].id);
  assert.deepEqual(requests.filter((req) => req.body.method === "tools/call").map((req) => req.key), KEYS);
  assert.equal(manager.list().installed[0].accounts[0].status, "quota");
  await windCall(tools);
  assert.equal(requests.filter((req) => req.body.method === "tools/call" && req.key === KEYS[0]).length, 1);
});

test("Wind does not rotate permission errors or normal HTTP throttling and server failures", async (t) => {
  for (const fault of ["permission", 429, 503]) await t.test(String(fault), async (t) => {
    let testing = false;
    const { tools, requests, manager } = await wind(t, (req) => {
      if (!testing) return;
      if (fault !== "permission") return { status: fault, data: { error: "rate limit or temporarily unavailable" } };
      if (req.body.method === "tools/call") return { toolResult: { isError: true, content: [{ type: "text", text: "数据权限不足" }] } };
    });
    testing = true;
    const result = await toolResult(tools, "call", { server: "stock_data", tool: "quote", args: { symbol: "x" } });
    assert.equal(result.isError, true);
    assert.equal(requests.some((req) => req.key === KEYS[1]), false);
    assert.equal(Object.keys(manager.readState("wind").queryAccounts?.blocked || {}).length, 0);
  });
});

test("Wind requires account pinning for stateful followups and never changes the pinned account", async (t) => {
  const { tools, accounts, requests } = await wind(t, (req) => req.body.method === "tools/call" ? { toolResult: quotaResult } : undefined);
  const args = { server: "stock_data", tool: "quote", args: { symbol: "x", cursor: "next-page" } };
  assert.match((await toolResult(tools, "call", args)).data.error, /指定上次返回/);
  assert.equal(requests.length, 0);
  assert.match((await toolResult(tools, "call", { ...args, account: accounts[0].id })).data.error, /指定账号额度/);
  assert.equal(requests.some((req) => req.key === KEYS[1]), false);
  const count = requests.length;
  assert.match((await toolResult(tools, "call", { ...args, account: accounts[0].id })).data.error, /指定账号额度/);
  assert.equal(requests.length, count);
});

test("Wind Alice retries quota rejection only before acceptance, never after a task was accepted", async (t) => {
  for (const accepted of [false, true]) await t.test(accepted ? "accepted task" : "rejected before acceptance", async (t) => {
    const { tools, accounts, requests, manager } = await wind(t, (req) => {
      if (req.route !== "/skills/alice") return;
      if (req.key === KEYS[1]) return { events: [aliceResult] };
      return { events: [...(accepted ? [{ result: { kind: "status-update", status: { state: "working" } } }] : []), { error: { code: -32000, message: "每日调用次数已达上限" } }] };
    });
    const result = await toolResult(tools, "ask_alice", { question: "核验公告" });
    assert.equal(result.isError, accepted);
    const submissions = requests.filter((req) => req.route === "/skills/alice");
    assert.equal(submissions.length, accepted ? 1 : 2);
    if (accepted) {
      assert.match(result.data.error, /已开始处理/);
      assert.ok(manager.readState("wind").queryAccounts.blocked[accounts[0].id]);
    } else {
      assert.equal(result.data.connector_account, accounts[1].id);
      assert.equal(result.data.text, "本地分析");
      assert.deepEqual(submissions.map((req) => req.body.params.message.parts[0].text), ["核验公告", "核验公告"]);
    }
  });
});

test("Wind successful data mentioning quota is not retried and cached skill listing never calls remote accounts", async (t) => {
  const { tools, accounts, requests } = await wind(t, (req) => req.body.method === "tools/call" ? { toolResult: { content: [{ type: "text", text: "报告中讨论了积分余额不足" }] } } : undefined);
  assert.equal((await windCall(tools)).connector_account, accounts[0].id);
  assert.equal(requests.filter((req) => req.body.method === "tools/call").length, 1);
  requests.length = 0;
  const skills = await toolResult(tools, "list_skills");
  assert.equal(skills.isError, true); // This isolated fixture deliberately skips the official skill download.
  assert.match(skills.data.error, /缓存尚未安装/);
  assert.equal(requests.length, 0);
});
