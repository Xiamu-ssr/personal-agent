// Device gateway: phones and Macs connect over WebSocket and register a capability list.
// The agent reaches them through one in-process MCP server ("devices").
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.mjs";
import { readJson, writeJson } from "./store.mjs";

const CALL_TIMEOUT_MS = 60_000;

export class DeviceHub {
  constructor() {
    this.devices = new Map(); // id -> { info, ws, pending: Map }
    this.batches = new Map(); // batchId -> { device, source, cursor }
    this.onChange = () => {};
    this.onReconnect = () => {};
  }

  register(ws, info) {
    const prev = this.devices.get(info.id);
    if (prev && prev.ws !== ws) prev.ws.close(4000, "replaced");
    this.devices.set(info.id, { info, ws, pending: new Map() });
    ws.on("close", () => {
      const cur = this.devices.get(info.id);
      if (cur?.ws !== ws) return;
      for (const p of cur.pending.values()) p.reject(new Error("设备离线"));
      this.devices.delete(info.id);
      this.onChange();
    });
    this.onChange();
    this.onReconnect(info);
  }

  handleResult(msg) {
    for (const d of this.devices.values()) {
      const p = d.pending.get(msg.id);
      if (!p) continue;
      d.pending.delete(msg.id);
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error || "设备返回错误"));
      return;
    }
  }

  online() {
    return [...this.devices.values()].map(({ info }) => ({
      id: info.id,
      name: info.name,
      kind: info.kind,
      capabilities: (info.capabilities || []).map((c) => c.name),
    }));
  }

  call(deviceId, capability, args) {
    const d = this.devices.get(deviceId);
    if (!d) return Promise.reject(new Error("设备离线"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        d.pending.delete(id);
        reject(new Error("设备超时"));
      }, CALL_TIMEOUT_MS);
      d.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      d.ws.send(JSON.stringify({ t: "call", id, capability, args: args || {} }));
    });
  }

  cursorFile(deviceId) {
    return path.join(config.sync, `${deviceId.replace(/[^\w.-]/g, "_")}.json`);
  }

  async readSince(deviceId, source, limit) {
    const state = readJson(this.cursorFile(deviceId), {});
    const cursor = state[source]?.cursor ?? null;
    const res = await this.call(deviceId, "__read_since", { source, cursor, limit });
    const batchId = crypto.randomUUID().slice(0, 8);
    if (res?.items?.length) this.batches.set(batchId, { deviceId, source, cursor: res.next_cursor });
    return { batch: res?.items?.length ? batchId : null, items: res?.items || [], more: !!res?.more };
  }

  commit(batchId) {
    const b = this.batches.get(batchId);
    if (!b) throw new Error("没有这个批次（可能已提交或服务重启过）");
    const file = this.cursorFile(b.deviceId);
    const state = readJson(file, {});
    state[b.source] = { cursor: b.cursor, committedAt: new Date().toISOString() };
    writeJson(file, state);
    this.batches.delete(batchId);
  }

  lastCatchup(deviceId) {
    return readJson(this.cursorFile(deviceId), {}).__lastCatchup || 0;
  }

  markCatchup(deviceId) {
    const file = this.cursorFile(deviceId);
    const state = readJson(file, {});
    state.__lastCatchup = Date.now();
    writeJson(file, state);
  }

  mcpServer() {
    const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
    const fail = (e) => ({ content: [{ type: "text", text: String(e.message || e) }], isError: true });
    return createSdkMcpServer({
      name: "devices",
      version: "0.1.0",
      instructions: "用户的手机和电脑。先 list_devices 看谁在线、有哪些能力，再 call_device。",
      tools: [
        tool("list_devices", "列出在线设备和每台设备的能力清单（含参数说明）。", {}, async () =>
          text([...this.devices.values()].map(({ info }) => info))),
        tool(
          "call_device",
          "调用某台设备的一个能力。args 按能力清单里的说明传。设备离线会直接返回错误。",
          { device: z.string(), capability: z.string(), args: z.record(z.string(), z.any()).optional() },
          async ({ device, capability, args }) => {
            try {
              return text(await this.call(device, capability, args));
            } catch (e) {
              return fail(e);
            }
          },
        ),
        tool(
          "read_since",
          "补读：从设备上取上次提交之后的一批新数据（最多 limit 条）。处理完记忆后必须 sync_commit 这个 batch。",
          { device: z.string(), source: z.string(), limit: z.number().int().max(50).optional() },
          async ({ device, source, limit }) => {
            try {
              return text(await this.readSince(device, source, limit || 50));
            } catch (e) {
              return fail(e);
            }
          },
        ),
        tool("sync_commit", "提交一批已经处理完的补读数据，游标前移。", { batch: z.string() }, async ({ batch }) => {
          try {
            this.commit(batch);
            return text("已提交");
          } catch (e) {
            return fail(e);
          }
        }),
      ],
    });
  }
}
