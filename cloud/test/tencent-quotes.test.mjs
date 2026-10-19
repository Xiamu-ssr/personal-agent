import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ConnectorManager } from "../src/connectors.mjs";
import { createTencentQuotesConnector, normalizeSymbol, parseTencentQuotes } from "../connectors/tencent-quotes/index.mjs";
import { callTool, toolResult } from "./tool-call.mjs";
import { fakeConnectorApi } from "./fake-connector-api.mjs";

function wire(code, { price = 3200.5, time = "20261016150000", name = "INDEX" } = {}) {
  const fields = Array(88).fill("");
  Object.assign(fields, { 0: "1", 1: name, 2: code.slice(2), 3: String(price), 4: "3200", 30: time, 31: "0.5", 32: "0.02", 33: "3210", 34: "3190", 38: "0.8" });
  return `v_${code}="${fields.join("~")}";`;
}
const toolsFor = (manager, definition) => {
  const accounts = structuredClone(manager.accounts.get(definition.name));
  return definition.tools(accounts, manager.context(definition.name, accounts));
};
async function setup(t, handler, options = {}) {
  const api = await fakeConnectorApi(handler || ((req) => ({ rawBody: wire(req.path.split("=")[1].split(",")[0]) })));
  t.after(() => api.close());
  const definition = createTencentQuotesConnector({ endpoint: api.url + "/q=", ...options });
  const root = fs.mkdtempSync(path.join(testRoot, "tencent-"));
  const manager = new ConnectorManager({ root, definitions: [definition] });
  return { api, definition, manager, root };
}

test("Tencent symbols preserve exchange identity instead of guessing what a bare 000001 means", () => {
  assert.equal(normalizeSymbol(" sh000001 "), "sh000001");
  assert.equal(normalizeSymbol("000001.SZ"), "sz000001");
  assert.equal(normalizeSymbol("510300.SH"), "sh510300");
  assert.equal(normalizeSymbol("920002.BJ"), "bj920002");
  for (const input of ["000001", "HK00700", "sh600519,sz000001", "https://example.test", "sh600519/../../private"]) assert.throws(() => normalizeSymbol(input), /代码请带市场/);
});

test("Tencent parser keeps upstream quote time, handles partial results and never invents zero quotes", () => {
  const data = parseTencentQuotes(wire("sh000001") + wire("sz000001", { price: 0 }) + "v_bj920002=\"bad\";", ["sh000001", "sz000001", "bj920002"]);
  assert.equal(data.quotes[0].price, 3200.5);
  assert.equal(data.quotes[0].symbol, "000001.SH");
  assert.equal(data.quotes[0].asOf, "2026-10-16T15:00:00+08:00");
  assert.equal(data.quotes[0].previousClose, 3200);
  assert.equal(data.quotes[0].changePercent, 0.02);
  assert.deepEqual(data.missing, ["sz000001", "bj920002"]);
  assert.deepEqual(parseTencentQuotes("<html>temporarily blocked</html>", ["sh000001"]).quotes, []);
});

test("Tencent connects without credentials, decodes actual GBK bytes and disconnecting removes its tools", async (t) => {
  const gbk = Buffer.concat([Buffer.from(wire("sh000001", { name: "__NAME__" }).split("__NAME__")[0]), Buffer.from("yc/WpNa4yv0=", "base64"), Buffer.from(wire("sh000001", { name: "__NAME__" }).split("__NAME__")[1])]);
  const { api, definition, manager, root } = await setup(t, () => ({ rawBody: gbk, headers: { "Content-Type": "text/plain; charset=gbk" } }));
  assert.deepEqual(manager.list().catalog[0].fields, []);
  assert.equal(manager.list().catalog[0].status, "off");
  const account = await manager.addAccount("tencent-quotes", {});
  assert.equal(manager.list().installed[0].status, "on");
  assert.deepEqual(manager.find("tencent-quotes", account.id).values, {});
  const tools = toolsFor(manager, definition);
  const result = await callTool(tools, "quotes", { symbols: ["000001.SH"] });
  assert.equal(result.quotes[0].name, "上证指数");
  assert.equal(result.source, "腾讯证券公开行情");
  assert.equal(result.quotes[0].asOf, "2026-10-16T15:00:00+08:00");
  assert.ok(api.requests.every((req) => req.method === "GET" && !req.authorization && req.body === undefined));
  await assert.rejects(manager.addAccount("tencent-quotes", {}), /只支持一个账号/);
  await assert.rejects(manager.addAccount("tencent-quotes", { apiKey: "not-required" }), /不支持的配置字段/);
  assert.equal(fs.statSync(path.join(root, "system/connectors/tencent-quotes/accounts.json")).mode & 0o777, 0o600);
  await manager.removeAccount("tencent-quotes", account.id);
  assert.equal("tencent-quotes" in manager.toolGroups(), false);
  const before = api.requests.length;
  assert.match((await toolResult(tools, "quotes", { symbols: ["sh000001"] })).data.error, /配置已变更/);
  assert.equal(api.requests.length, before);
});

test("Tencent batches/deduplicates symbols, shares short cache between isolated queries and refreshes after expiry", async (t) => {
  let now = Date.UTC(2026, 9, 16, 14), price = 3200.5;
  const { api, definition, manager } = await setup(t, (req) => ({ rawBody: req.path.split("=")[1].split(",").filter((code) => code !== "bj920002").map((code) => wire(code, { price })).join("\n") }), { now: () => now });
  await manager.addAccount("tencent-quotes", {});
  const tools = toolsFor(manager, definition);
  const first = await callTool(tools, "quotes", { symbols: ["000001.SZ", "000001.SH", "sh000001", "920002.BJ"] });
  assert.deepEqual(first.quotes.map((quote) => quote.code), ["sz000001", "sh000001"]);
  assert.deepEqual(first.missing, ["bj920002"]);
  assert.equal(first.cached, false);
  assert.equal(api.requests.at(-1).path, "/q=bj920002,sh000001,sz000001");
  const count = api.requests.length;
  price = 3210;
  const second = await callTool(toolsFor(manager, definition), "quotes", { symbols: ["bj920002", "sh000001", "sz000001"] });
  assert.equal(second.cached, true);
  assert.equal(second.quotes[0].price, 3200.5);
  assert.equal(second.fetchedAt, first.fetchedAt);
  assert.equal(api.requests.length, count);
  now += 5001;
  const refreshed = await callTool(tools, "quotes", { symbols: ["bj920002", "sh000001", "sz000001"] });
  assert.equal(refreshed.cached, false);
  assert.equal(refreshed.quotes[0].price, 3210);
  assert.equal(api.requests.length, count + 1);
});

test("Tencent coalesces concurrent identical queries and rejects invalid inputs without a network request", async (t) => {
  const { api, definition, manager } = await setup(t, async () => { await new Promise((resolve) => setTimeout(resolve, 15)); return { rawBody: wire("sh000001") }; });
  await manager.addAccount("tencent-quotes", {});
  const tools = toolsFor(manager, definition), count = api.requests.length;
  const results = await Promise.all([callTool(tools, "quotes", { symbols: ["sh000001"] }), callTool(toolsFor(manager, definition), "quotes", { symbols: ["000001.SH"] })]);
  assert.ok(results.every((item) => item.quotes[0].price === 3200.5));
  assert.equal(api.requests.length, count + 1);
  assert.equal((await toolResult(tools, "quotes", { symbols: ["000001"] })).isError, true);
  await assert.rejects(callTool(tools, "quotes", { symbols: Array(51).fill("sh000001") }));
  assert.equal(api.requests.length, count + 1);
});

test("Tencent connection failure saves no activation and failed queries do not return stale prices", async (t) => {
  let fail = true;
  const { api, definition, manager } = await setup(t, () => fail ? { status: 503 } : { rawBody: wire("sh000001") });
  await assert.rejects(manager.addAccount("tencent-quotes", {}), /HTTP 503/);
  assert.equal(manager.list().installed.length, 0);
  fail = false;
  await manager.addAccount("tencent-quotes", {});
  fail = true;
  const result = await toolResult(toolsFor(manager, definition), "quotes", { symbols: ["sh000001"] });
  assert.equal(result.isError, true);
  assert.equal(result.data.quotes, undefined);
  assert.match(result.data.error, /HTTP 503/);
  assert.equal(api.requests.length, 3);
});

test("Tencent bounds public responses and reports malformed or disconnected data in Chinese", async (t) => {
  for (const rawBody of ["invalid data", "x".repeat(1024 * 1024 + 1)]) await t.test(rawBody.length > 100 ? "oversized" : "malformed", async (t) => {
    const { manager } = await setup(t, () => ({ rawBody }));
    await assert.rejects(manager.addAccount("tencent-quotes", {}), /有效行情|响应过大/);
  });
  const disconnected = createTencentQuotesConnector({ fetchImpl: async () => { throw new Error("offline"); } });
  await assert.rejects(disconnected.test({}), /连接超时或网络不可用/);
});
