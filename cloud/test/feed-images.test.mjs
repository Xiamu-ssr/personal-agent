import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { ConnectorManager } from "../src/connectors.mjs";
import { Content } from "../src/content.mjs";
import { config } from "../src/config.mjs";

test("a nested feed image survives HTTP serialization and loads through the existing authenticated file route", async (t) => {
  const root = testRoot, directory = path.join(root, "data/feed/2026-10-16/img");
  fs.mkdirSync(directory, { recursive: true });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXcAAAAASUVORK5CYII=", "base64");
  fs.writeFileSync(path.join(directory, "封面.png"), png);
  fs.writeFileSync(path.join(root, "data/feed/2026-10-16/2139-消息.md"), "---\ntitle: 有图的动态\nimage: img/封面.png\n---\n原文摘要。");
  const connectors = new ConnectorManager({ root, definitions: [] }), bus = { on() {}, emit() {} };
  const server = startServer({ harness: { busy: false, running: new Map(), connectors }, hub: new DeviceHub(), bus, log() {}, connectors,
    content: new Content({ root }), listen: { host: "127.0.0.1", port: 0 } });
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`, headers = { "X-Doudou-Protocol":"2", Authorization: "Bearer " + config.token };
  const feed = await (await fetch(base + "/api/feed", { headers })).json();
  const image = feed.items[0].image;
  assert.equal(image, "data/feed/2026-10-16/img/封面.png");
  const route = "/files/" + image.split("/").map(encodeURIComponent).join("/");
  assert.equal((await fetch(base + route)).status, 401);
  const response = await fetch(base + route, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});
