import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { CONNECTION_HEARTBEAT_MS, pingConnections } from "../src/connection-heartbeat.mjs";

test("server-owned heartbeat keeps quiet app/device transports alive and removes a silent peer without application messages", async t => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  t.after(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
  const peers = [];
  wss.on("connection", ws => { ws.isAlive = true; ws.on("pong", () => { ws.isAlive = true; }); peers.push(ws); });
  const url = `ws://127.0.0.1:${wss.address().port}`;
  const app = new WebSocket(url), device = new WebSocket(url), silent = new WebSocket(url, { autoPong: false });
  t.after(() => { app.terminate(); device.terminate(); silent.terminate(); });
  await Promise.all([once(app, "open"), once(device, "open"), once(silent, "open")]);
  let payloads = 0; app.on("message", () => payloads++); device.on("message", () => payloads++);
  const pongs = peers.slice(0, 2).map(ws => once(ws, "pong"));
  pingConnections(wss.clients); await Promise.all(pongs);
  const closed = once(silent, "close");
  pingConnections(wss.clients); await closed;
  assert.equal(app.readyState, WebSocket.OPEN); assert.equal(device.readyState, WebSocket.OPEN);
  assert.equal(payloads, 0, "connection health must not poll history, wake the model or send fake chat");
  assert.equal(CONNECTION_HEARTBEAT_MS, 90_000);
  pingConnections([{ readyState: WebSocket.CLOSING, ping() { assert.fail("do not ping a closing transport"); } }]);
});
