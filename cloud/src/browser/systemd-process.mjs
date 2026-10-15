import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const endpointValid = (value) => typeof value === "string" && /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+$/.test(value);
export function userSystemdEnv(env = process.env) {
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  return { ...env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus` };
}

export class SystemdBrowserProcess extends EventEmitter {
  constructor({ root = process.env.AGENT_ROOT || "/srv/agent", service = process.env.AGENT_BROWSER_SERVICE,
    env = process.env, executeCommand = execute, startupMs = 25_000, pollMs = 2000 } = {}) {
    super();
    if (!/^[\w@.-]+\.service$/.test(service || "")) throw new Error("浏览器 systemd unit 名称不正确");
    Object.assign(this, { root, service, executeCommand, startupMs, pollMs });
    this.env = userSystemdEnv(env);
    this.profile = path.join(root, "system/browser/profile");
    this.downloads = path.join(root, "workspace/browser-downloads");
    this.stateFile = path.join(root, "system/browser/service.json");
  }

  async command(...args) {
    const { stdout } = await this.executeCommand("systemctl", ["--user", ...args, this.service], { env: this.env, timeout: 8000, maxBuffer: 16 * 1024 });
    return stdout.trim();
  }

  readState() { try { const state = JSON.parse(fs.readFileSync(this.stateFile, "utf8")); return state && typeof state === "object" ? state : {}; } catch { return {}; } }

  async ensure() {
    if (this.stopping) await this.stopping;
    if (this.starting) return this.starting;
    if (this.endpoint && Number(await this.command("show", "--property=MainPID", "--value")) === this.pid) return this.endpoint;
    this.starting = this.start();
    try { return await this.starting; } finally { this.starting = null; }
  }

  async start() {
    this.disconnected();
    try {
      await this.command("start");
      const pid = Number(await this.command("show", "--property=MainPID", "--value"));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error();
      const deadline = Date.now() + this.startupMs;
      while (Date.now() < deadline) {
        const state = this.readState();
        if (state.pid === pid && endpointValid(state.endpoint)) {
          this.pid = pid; this.endpoint = state.endpoint;
          this.timer = setInterval(() => this.check(), this.pollMs); this.timer.unref?.();
          return this.endpoint;
        }
        if (Number(await this.command("show", "--property=MainPID", "--value")) !== pid) throw new Error();
        await delay(50);
      }
      throw new Error();
    } catch {
      await this.command("stop").catch(() => {});
      this.disconnected();
      throw new Error("独立浏览器服务未就绪，请检查用户 systemd、cgroup v2 和浏览器安装；没有退回主服务启动 Chrome");
    }
  }

  async check() {
    if (this.checking || !this.pid) return;
    this.checking = true;
    const pid = this.pid;
    try { if (Number(await this.command("show", "--property=MainPID", "--value")) !== pid && this.pid === pid) this.disconnected(); }
    catch { if (this.pid === pid) this.disconnected(); }
    finally { this.checking = false; }
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
      if (this.pid || this.readState().pid) await this.command("stop");
      this.disconnected();
    })();
    try { await this.stopping; } finally { this.stopping = null; }
  }
}
