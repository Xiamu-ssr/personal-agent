import path from "node:path";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { serviceRequest } from "./service-client.mjs";

const endpointValid = (value) => typeof value === "string" && /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+$/.test(value);

export class SystemdBrowserProcess extends EventEmitter {
  constructor({ root = process.env.AGENT_ROOT || "/srv/agent", startupMs = 25_000, pollMs = 2000 } = {}) {
    super();
    Object.assign(this, { root, startupMs, pollMs });
    this.sharedThumbnails = true;
    this.profile = path.join(root, "system/browser/profile");
    this.downloads = path.join(root, "workspace/browser-downloads");
  }
  request(route, options) { return serviceRequest(this.root, route, options); }
  async ensure() {
    if (this.stopping) await this.stopping;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try { return await this.starting; } finally { this.starting = null; }
  }
  async start() {
    const deadline = Date.now() + this.startupMs;
    while (Date.now() < deadline) {
      try {
        await this.request("/status", { method: "GET", timeoutMs: Math.max(1, Math.min(1000, deadline - Date.now())) });
        const state = await this.request("/browser/ensure", { timeoutMs: Math.max(1, deadline - Date.now()) });
        if (!endpointValid(state.endpoint)) throw new Error();
        this.pid = state.pid; this.endpoint = state.endpoint;
        clearInterval(this.timer);
        this.timer = setInterval(() => this.check(), this.pollMs); this.timer.unref?.();
        return this.endpoint;
      } catch { if (Date.now() < deadline) await delay(Math.min(100, deadline - Date.now())); }
    }
    this.disconnected();
    throw new Error("独立浏览器服务未就绪，请检查 personal-agent-browser.service、Chrome/Xvfb 和目录权限；没有退回主服务启动 Chrome");
  }
  async check() {
    if (this.checking || !this.pid) return;
    this.checking = true;
    const pid = this.pid, endpoint = this.endpoint;
    try {
      const state = await this.request("/status", { method: "GET", timeoutMs: 2000 });
      if (this.pid === pid && (state.pid !== pid || state.endpoint !== endpoint)) this.disconnected();
    } catch { if (this.pid === pid) this.disconnected(); }
    finally { this.checking = false; }
  }
  touch() {
    if (this.endpoint) void this.request("/browser/touch", { timeoutMs: 2000 }).catch(() => {});
  }
  disconnected() {
    clearInterval(this.timer);
    const hadEndpoint = !!this.endpoint;
    this.endpoint = null; this.pid = null;
    if (hadEndpoint) this.emit("exit");
  }
  async waitForExit(timeoutMs = 2000) {
    const end = Date.now() + timeoutMs;
    while (this.pid && Date.now() < end) { await this.check(); if (this.pid) await delay(50); }
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      await this.starting?.catch(() => {});
      try { if (this.endpoint) await this.request("/browser/stop", { timeoutMs: 8000 }); }
      finally { this.disconnected(); }
    })();
    try { await this.stopping; } finally { this.stopping = null; }
  }
}
