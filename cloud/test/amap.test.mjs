import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ConnectorManager } from "../src/connectors.mjs";
import { createAmapConnector } from "../connectors/amap/index.mjs";
import { callTool, toolResult } from "./tool-call.mjs";
import { fakeConnectorApi } from "./fake-connector-api.mjs";

const KEY = "0123456789abcdef0123456789abcdef";
const OK = { status: "1", infocode: "10000", info: "OK" };
const point = "116.397428,39.90923", other = "116.407428,39.91923";
async function setup(t, handler = () => ({ data: { ...OK, geocodes: [{ location: point, adcode: "110101" }] } })) {
  const api = await fakeConnectorApi(handler);
  t.after(() => api.close());
  const definition = createAmapConnector({ baseUrl: api.url });
  const root = fs.mkdtempSync(path.join(testRoot, "amap-"));
  const manager = new ConnectorManager({ root, definitions: [definition] });
  const tools = () => { const records = structuredClone(manager.accounts.get("amap")); return definition.tools(records, manager.context("amap", records)); };
  return { api, definition, manager, tools, root };
}
const last = (api) => new URL(api.requests.at(-1).path, api.url);

test("AMap starts disconnected; key is private, verified with a public landmark and revoked tools cannot query", async (t) => {
  const { api, manager, tools, root } = await setup(t);
  assert.equal(manager.list().catalog[0].status, "off");
  await assert.rejects(manager.addAccount("amap", { apiKey: "bad" }), /32 位/);
  assert.equal(api.requests.length, 0);
  const account = await manager.addAccount("amap", { apiKey: ` ${KEY} ` });
  assert.equal(last(api).pathname, "/v3/geocode/geo");
  assert.equal(last(api).searchParams.get("address"), "天安门");
  assert.equal(last(api).searchParams.get("key"), KEY);
  assert.equal(manager.list().installed[0].accounts[0].values.apiKey, "••••");
  assert.ok(!JSON.stringify(manager.list()).includes(KEY));
  assert.equal(fs.statSync(path.join(root, "system/connectors/amap/accounts.json")).mode & 0o777, 0o600);
  await assert.rejects(manager.addAccount("amap", { apiKey: KEY }), /只支持一个账号/);
  const stale = tools(), count = api.requests.length;
  await manager.removeAccount("amap", account.id);
  assert.equal("amap" in manager.mcpServers(), false);
  assert.match((await toolResult(stale, "geocode", { address: "天安门" })).data.error, /配置已变更/);
  assert.equal(api.requests.length, count);
});

test("AMap queries fixed read-only endpoints, URL-encodes input, paginates and keeps GCJ-02 identity", async (t) => {
  const { api, manager, tools } = await setup(t, (req) => ({ data: { ...OK, pois: [], echo: KEY, query: new URL(req.path, "http://local").searchParams.get("keywords") } }));
  await manager.addAccount("amap", { apiKey: KEY });
  const result = await callTool(tools(), "search_places", { keywords: "咖啡&key=evil", city: "北京", page: 2, limit: 5 });
  assert.equal(last(api).pathname, "/v3/place/text");
  assert.equal(last(api).searchParams.get("keywords"), "咖啡&key=evil");
  assert.deepEqual(last(api).searchParams.getAll("key"), [KEY]);
  assert.equal(last(api).searchParams.get("offset"), "5");
  assert.equal(last(api).searchParams.get("page"), "2");
  assert.equal(last(api).searchParams.get("citylimit"), "true");
  assert.equal(result.coordinateSystem, "GCJ-02");
  assert.equal(result.echo, "••••");
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.deepEqual(result.pois, []);
  assert.ok(api.requests.every((r) => r.method === "GET" && !r.body && !r.authorization));
  await callTool(tools(), "geocode", { address: "公共图书馆", city: "北京" });
  assert.equal(last(api).searchParams.get("city"), "北京");
  await callTool(tools(), "reverse_geocode", { location: point });
  assert.equal(last(api).pathname, "/v3/geocode/regeo");
  await callTool(tools(), "search_nearby", { location: point, keywords: "公园", radius: 1500, limit: 3 });
  assert.equal(last(api).pathname, "/v3/place/around");
  assert.equal(last(api).searchParams.get("sortrule"), "distance");
  assert.equal(last(api).searchParams.get("radius"), "1500");
});

test("AMap maps route/distance modes and converts GPS instead of silently mixing coordinate systems", async (t) => {
  const { api, manager, tools } = await setup(t, (req) => ({ data: req.path.startsWith("/v4/") ? { errcode: 0, data: { paths: [{ distance: "800", duration: "200" }] } } : { ...OK, locations: other, route: { paths: [{ distance: "900", duration: "600" }] } } }));
  await manager.addAccount("amap", { apiKey: KEY });
  const tt = tools(), before = api.requests.length;
  assert.equal((await toolResult(tt, "route", { origin: point, destination: other, mode: "transit" })).isError, true);
  assert.equal(api.requests.length, before);
  for (const mode of ["walking", "driving", "transit", "bicycling"]) {
    const r = await callTool(tt, "route", { origin: point, destination: other, mode, ...(mode === "transit" && { city: "北京", destination_city: "天津" }) });
    assert.equal(last(api).pathname, mode === "bicycling" ? "/v4/direction/bicycling" : `/v3/direction/${mode === "transit" ? "transit/integrated" : mode}`);
    if (mode === "transit") assert.equal(last(api).searchParams.get("cityd"), "天津");
    assert.equal(r.coordinateSystem, "GCJ-02");
  }
  for (const [mode, type] of [["straight", "0"], ["driving", "1"], ["walking", "3"]]) {
    await callTool(tt, "distance", { origins: [point, other], destination: other, mode });
    assert.equal(last(api).pathname, "/v3/distance");
    assert.equal(last(api).searchParams.get("origins"), `${point}|${other}`);
    assert.equal(last(api).searchParams.get("type"), type);
  }
  const converted = await callTool(tt, "convert_coordinates", { locations: [point], from: "gps" });
  assert.equal(last(api).pathname, "/v3/assistant/coordinate/convert");
  assert.equal(last(api).searchParams.get("coordsys"), "gps");
  assert.equal(converted.locations, other);
  await callTool(tt, "weather", { city: "110101", forecast: true });
  assert.equal(last(api).pathname, "/v3/weather/weatherInfo");
  assert.equal(last(api).searchParams.get("extensions"), "all");
});

test("AMap rejects bad coordinates and oversized queries before contacting the service", async (t) => {
  const { api, manager, tools } = await setup(t);
  await manager.addAccount("amap", { apiKey: KEY });
  const tt = tools(), before = api.requests.length;
  for (const location of ["200,39", "116,91", "116,39;evil", "116.1234567,39", "39,116"]) await assert.rejects(callTool(tt, "reverse_geocode", { location }));
  await assert.rejects(callTool(tt, "search_nearby", { location: point, keywords: "cafe", radius: 99999 }));
  await assert.rejects(callTool(tt, "distance", { origins: Array(11).fill(point), destination: other }));
  assert.equal(api.requests.length, before);
});

test("AMap translates HTTP-200 quota/IP/platform failures without echoing credentials or retrying", async (t) => {
  for (const [code, pattern] of [[10001, /Key 无效/], [10003, /额度已用完/], [10005, /IP 白名单/], [10009, /平台类型/], [20001, /参数不正确/]]) {
    const { api, manager } = await setup(t, () => ({ data: { status: "0", infocode: String(code), info: KEY } }));
    await assert.rejects(manager.addAccount("amap", { apiKey: KEY }), (error) => pattern.test(error.message) && !error.message.includes(KEY));
    assert.equal(api.requests.length, 1);
    assert.equal(manager.list().installed.length, 0);
  }
});

test("AMap bounds large routes, removes geometry and labels truncation", async (t) => {
  const { manager, tools } = await setup(t, () => ({ data: { ...OK, route: { paths: Array.from({ length: 4 }, () => ({ distance: "1000", duration: "600", steps: Array.from({ length: 80 }, () => ({ instruction: "向北", polyline: "large geometry" })) })) } } }));
  await manager.addAccount("amap", { apiKey: KEY });
  const r = await callTool(tools(), "route", { origin: point, destination: other });
  assert.equal(r.route.paths.length, 3);
  assert.equal(r.route.paths[0].steps.length, 60);
  assert.equal(r.route.paths[0].distance, "1000");
  assert.equal(r.truncated, true);
  assert.ok(!JSON.stringify(r).includes("polyline"));
});

test("AMap reports offline, malformed, oversized and v4 failures safely", async (t) => {
  const offline = createAmapConnector({ fetchImpl: async () => { throw new Error(KEY); } });
  await assert.rejects(offline.test({ apiKey: KEY }), (error) => /网络不可用/.test(error.message) && !error.message.includes(KEY));
  for (const [response, pattern] of [[{ status: 503 }, /HTTP 503/], [{ rawBody: "not JSON" }, /无法解析/], [{ rawBody: "x".repeat(2 * 1024 * 1024 + 1) }, /响应过大/]]) {
    const { manager } = await setup(t, () => response);
    await assert.rejects(manager.addAccount("amap", { apiKey: KEY }), pattern);
  }
  const { manager, tools } = await setup(t, (req) => ({ data: req.path.startsWith("/v4/") ? { errcode: 30001, errmsg: KEY } : OK }));
  await manager.addAccount("amap", { apiKey: KEY });
  const r = await toolResult(tools(), "route", { origin: point, destination: other, mode: "bicycling" });
  assert.equal(r.isError, true);
  assert.ok(!JSON.stringify(r).includes(KEY));
});
