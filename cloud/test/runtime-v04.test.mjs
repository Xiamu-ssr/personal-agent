import "./environment.mjs";
import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fakeAnthropic } from "./fake-anthropic.mjs";
import { fakeConnectorApi } from "./fake-connector-api.mjs";
import { nativeHarness, resultFor, toolReply, textReply } from "./native-fixture.mjs";
import { DeviceHub, deviceContent, DEVICE_IMAGE_LIMIT } from "../src/devices.mjs";
import { ConnectorManager } from "../src/connectors.mjs";
import { createTavilyConnector } from "../connectors/tavily/index.mjs";
import { createWereadConnector } from "../connectors/weread/index.mjs";

test("device image MCP content supports one/multiple/mixed images, keeps metadata and rejects >5MB or malformed data in Chinese", async (t) => {
  const small = Buffer.from("fake-image").toString("base64");
  assert.deepEqual(deviceContent({ image: small, mime: "image/png" }), { content: [{ type: "image", data: small, mimeType: "image/png" }] });
  assert.deepEqual(deviceContent([{ image: small, mime: "image/jpeg", width: 100 }, "备注", { image: small, mime: "image/webp" }]).content.map((c) => c.type), ["image", "text", "text", "image"]);
  assert.equal(deviceContent({ image: Buffer.alloc(DEVICE_IMAGE_LIMIT).toString("base64"), mime: "image/png" }).content[0].type, "image");
  assert.throws(() => deviceContent({ image: Buffer.alloc(DEVICE_IMAGE_LIMIT + 1).toString("base64"), mime: "image/png" }), /超过 5MB/);
  assert.throws(() => deviceContent([{ image: small, mime: "image/png" }, { image: "invalid#", mime: "image/png" }]), /base64 格式/);
  assert.throws(() => deviceContent({ image: small, mime: "image/svg+xml" }), /只支持/);
  const hub = new DeviceHub();
  hub.call = async () => ({ image: Buffer.alloc(DEVICE_IMAGE_LIMIT + 1).toString("base64"), mime: "image/png" });
  const client = new Client({ name: "device-test", version: "0.4" }), server = hub.mcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport); await client.connect(clientTransport); t.after(() => client.close());
  const failed = await client.callTool({ name: "call_device", arguments: { device: "fake", capability: "computer_use" } });
  assert.equal(failed.isError, true); assert.match(failed.content[0].text, /超过 5MB/); assert.equal(failed.content.length, 1);
});

test("real SDK sends device screenshot as an Anthropic image block and Tavily/WeRead MCP requests never expose credentials to the model", { timeout: 45_000 }, async (t) => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKZ8AAAAASUVORK5CYII=";
  const api = await fakeAnthropic((body) => {
    if (!resultFor(body, "device_image")) return toolReply("device_image", "mcp__devices__call_device", { device: "fake-mac", capability: "computer_use", args: { action: "screenshot" } });
    assert.ok(resultFor(body, "device_image").content.some((b) => b.type === "image" && b.source?.data === png && b.source.media_type === "image/png"));
    if (!resultFor(body, "tavily_search")) return toolReply("tavily_search", "mcp__tavily__search", { query: "深入调研", depth: "advanced" });
    if (!resultFor(body, "weread_shelf")) return toolReply("weread_shelf", "mcp__weread__shelf", {});
    return textReply("图片与连接器完成");
  });
  const tavilyKey = "tvly-FAKE-NATIVE-KEY", wereadKey = "wrk-FAKE-NATIVE-KEY";
  const remote = await fakeConnectorApi((req) => ({ data: { echo: req.authorization.slice(7), results: [], books: [] } }));
  t.after(() => remote.close());
  const connectors = new ConnectorManager({ definitions: [createTavilyConnector({ baseUrl: remote.url }), createWereadConnector({ gateway: remote.url + "/api/agent/gateway" })] });
  await connectors.addAccount("tavily", { apiKey: tavilyKey }); await connectors.addAccount("weread", { apiKey: wereadKey });
  const hub = new DeviceHub(), ws = new EventEmitter();
  ws.readyState = 1; ws.send = (raw) => { const call = JSON.parse(raw); queueMicrotask(() => hub.handleResult({ t: "result", id: call.id, ok: true, data: { image: png, mime: "image/png", width: 1, height: 1 } })); };
  hub.register(ws, { id: "fake-mac", name: "测试 Mac", kind: "mac", capabilities: [{ name: "computer_use", enabled: true }] });
  const { harness, events, until } = nativeHarness(t, api, { connectors, hub });
  await harness.send("IMAGE_CONNECTOR_NATIVE");
  await until(() => events.some((e) => e.t === "turn_end") && !harness.busy);
  for (const key of [tavilyKey, wereadKey]) assert.equal(JSON.stringify(api.requests).includes(key), false);
  assert.ok(remote.requests.some((r) => r.path === "/search")); assert.ok(remote.requests.some((r) => r.body?.api_name === "/shelf/sync"));
});
