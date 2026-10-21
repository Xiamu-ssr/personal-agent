import { WebSocket } from "ws";

// One server tick aligns keepalives for app and device transports.
// Native WebSocket transports automatically reply with pong; no app payloads.
export const CONNECTION_HEARTBEAT_MS = 90_000;
export function pingConnections(clients) {
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}
