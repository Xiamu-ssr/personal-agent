// Device gateway: phones and Macs connect over WebSocket and register a capability list.
// The agent reaches them through one in-process MCP server ("devices").
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.mjs";
import { readJson, writeJson } from "./store.mjs";

const CALL_TIMEOUT_MS = 60_000;
// A call may ask for more time (Mac shell allows up to 300s); give the device 15s on top to report back.
const callTimeout = (args) => {
  const t = Number(args?.timeout);
  return Number.isFinite(t) && t > 0 ? Math.min(t, 300) * 1000 + 15_000 : CALL_TIMEOUT_MS;
};
const REGISTRY = () => path.join(config.system, "devices.json");

// Devices send every capability they have, each with `enabled` (what the user switched on there).
// Older clients only sent the enabled ones, without the flag.
const enabledCaps = (info) => (info.capabilities || []).filter((c) => c.enabled !== false);

export const DEVICE_IMAGE_LIMIT = 5 * 1024 * 1024;
export function deviceContent(value) {
  if (Array.isArray(value) && !value.some((item) => item && typeof item === "object" && Object.hasOwn(item, "image"))) {
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
  }
  const content = [];
  for (const item of Array.isArray(value) ? value : [value]) {
    if (item && typeof item === "object" && Object.hasOwn(item, "image")) {
      if (typeof item.image !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.image) || item.image.length % 4 !== 0 || !item.image.length) {
        throw new Error("设备图片的 base64 格式不正确");
      }
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(item.mime)) throw new Error("设备图片只支持 PNG、JPEG、WebP 或 GIF");
      if (Buffer.byteLength(item.image, "base64") > DEVICE_IMAGE_LIMIT) throw new Error("设备图片超过 5MB，请降低截图尺寸后重试");
      content.push({ type: "image", data: item.image, mimeType: item.mime });
      const { image: _image, mime: _mime, ...rest } = item;
      if (Object.keys(rest).length) content.push({ type: "text", text: JSON.stringify(rest) });
    } else content.push({ type: "text", text: typeof item === "string" ? item : JSON.stringify(item) ?? "null" });
  }
  return { content };
}

export class DeviceHub {
  constructor() {
    this.devices = new Map(); // id -> { info, ws, pending: Map }
    this.batches = new Map(); // batchId -> { device, source, cursor }
    this.onChange = () => {};
    this.onReconnect = () => {};
  }

  register(ws, info) {
    const reg = readJson(REGISTRY(), {});
    reg[info.id] = { ...info, lastSeen: Date.now() };
    writeJson(REGISTRY(), reg);
    const prev = this.devices.get(info.id);
    if (prev && prev.ws !== ws) prev.ws.close(4000, "replaced");
    this.devices.set(info.id, { info, ws, pending: new Map() });
    ws.on("close", () => {
      const cur = this.devices.get(info.id);
      if (cur?.ws !== ws) return;
      for (const p of cur.pending.values()) p.reject(new Error("设备离线"));
      this.devices.delete(info.id);
      const reg = readJson(REGISTRY(), {});
      if (reg[info.id]) {
        reg[info.id].lastSeen = Date.now();
        writeJson(REGISTRY(), reg);
      }
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
      capabilities: enabledCaps(info).map((c) => c.name),
    }));
  }

  // Every device that ever registered, online or not, with all its capabilities (for the App's connector pages).
  known() {
    return Object.values(readJson(REGISTRY(), {}))
      .map((info) => ({
        id: info.id, name: info.name, kind: info.kind, online: this.devices.has(info.id), lastSeen: info.lastSeen,
        capabilities: (info.capabilities || []).map((c) => ({
          name: c.name, title: c.title || c.name, description: c.hint || c.description || "", enabled: c.enabled !== false,
        })),
      }))
      .sort((a, b) => b.online - a.online || b.lastSeen - a.lastSeen);
  }

  // Forget only disconnected devices, including their sync cursors and outstanding batches.
  forget(id) {
    if (this.devices.has(id)) {
      const error = new Error("设备在线时不能移除，请先断开设备");
      error.status = 409;
      throw error;
    }
    const registry = readJson(REGISTRY(), {});
    if (!Object.hasOwn(registry, id)) {
      const error = new Error("没有这台设备");
      error.status = 404;
      throw error;
    }
    delete registry[id];
    writeJson(REGISTRY(), registry);
    fs.rmSync(this.cursorFile(id), { force: true });
    for (const [batch, value] of this.batches) if (value.deviceId === id) this.batches.delete(batch);
    this.onChange();
    return { ok: true };
  }

  // Push a small event to every connected device (e.g. so the phone can notify while the App is closed).
  broadcast(ev) {
    const s = JSON.stringify(ev);
    for (const d of this.devices.values()) if (d.ws.readyState === 1) d.ws.send(s);
  }

  call(deviceId, capability, args, {timeoutMs=callTimeout(args)}={}) {
    const d = this.devices.get(deviceId);
    if (!d) return Promise.reject(new Error("设备离线"));
    if (!capability.startsWith("__") && !enabledCaps(d.info).some((c) => c.name === capability)) {
      return Promise.reject(new Error(`这台设备没有开启「${capability}」。要用的话，请用户在那台设备的豆豆里打开`));
    }
    const id = crypto.randomUUID();
    const started = Date.now();
    // Log only the capability, outcome and device error text, never args or results (they can hold personal data).
    const done = (outcome) => console.log(new Date().toISOString(), `device call: ${deviceId} ${capability} ${outcome} ${Date.now() - started}ms`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        d.pending.delete(id);
        done("timeout");
        reject(new Error("设备超时"));
      }, timeoutMs);
      d.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), done(v?.image ? "ok image" : "ok"), resolve(v)),
        reject: (e) => (clearTimeout(timer), done(`error: ${String(e?.message || e).slice(0, 80)}`), reject(e)),
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
          text([...this.devices.values()].map(({ info }) => ({ ...info, capabilities: enabledCaps(info) })))),
        tool(
          "call_device",
          "调用某台设备的一个能力。args 按能力清单里的说明传。设备离线会直接返回错误。",
          { device: z.string(), capability: z.string(), args: z.record(z.string(), z.any()).optional() },
          async ({ device, capability, args }) => {
            try {
              return deviceContent(await this.call(device, capability, args));
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
