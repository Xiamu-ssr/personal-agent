import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export const VIEWPORT = { width: 1280, height: 800 };

export function browserExecutable(platform = process.platform) {
  const candidates = [process.env.AGENT_BROWSER_EXECUTABLE, ...(platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"])];
  return candidates.find((file) => file && fs.existsSync(file));
}

export function chromeArgs(profile, { noSandbox = false } = {}) {
  return [
    `--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    "--window-size=1280,800", "--force-device-scale-factor=1", "--app=about:blank",
    "--no-first-run", "--no-default-browser-check", "--disable-session-crashed-bubble",
    "--disable-background-networking", "--disable-background-mode", "--disable-component-update",
    "--disable-sync", "--disable-extensions", "--disable-default-apps", "--disable-gpu",
    "--disable-features=BackForwardCache,MediaRouter,OptimizationHints,Prerender2,SpareRendererForSitePerProcess",
    "--disable-dev-shm-usage", "--renderer-process-limit=1", "--js-flags=--max-old-space-size=192",
    "--disk-cache-size=67108864", "--media-cache-size=16777216", "--mute-audio",
    ...(noSandbox ? ["--no-sandbox"] : []),
  ];
}

const alive = (child) => child && child.exitCode === null && child.signalCode === null;

export class BrowserProcess extends EventEmitter {
  constructor({ root = process.env.AGENT_ROOT || "/srv/agent", platform = process.platform,
    env = process.env, executablePath, spawnProcess = spawn, startupMs = 20_000,
    noSandbox = process.env.AGENT_BROWSER_NO_SANDBOX === "1", stopMs = 2000 } = {}) {
    super();
    Object.assign(this, { root, platform, env, executablePath, spawnProcess, startupMs, noSandbox, stopMs });
    this.profile = path.join(root, "system/browser/profile");
    this.downloads = path.join(root, "workspace/browser-downloads");
  }

  launch(command, args, env) {
    const child = this.spawnProcess(command, args, { env, stdio: "ignore", detached: true });
    child.on("error", () => {});
    return child;
  }

  async ensure() {
    if (this.stopping) await this.stopping;
    if (this.starting) return this.starting;
    if (alive(this.chrome) && this.endpoint) return this.endpoint;
    this.starting = this.start();
    try { return await this.starting; }
    finally { this.starting = null; }
  }

  async start() {
    await this.cleanup();
    const executable = this.executablePath || browserExecutable(this.platform);
    if (!executable) throw new Error("云端浏览器尚未安装，请运行 cloud/deploy/browser-setup.sh");
    fs.mkdirSync(this.profile, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(this.profile), 0o700);
    fs.chmodSync(this.profile, 0o700);
    fs.mkdirSync(this.downloads, { recursive: true, mode: 0o700 });
    const portFile = path.join(this.profile, "DevToolsActivePort");
    fs.rmSync(portFile, { force: true });
    try {
      let display = this.env.DISPLAY;
      if (this.platform === "linux" && !display) {
        // -displayfd chooses an unused display atomically; never expose an X11 TCP socket.
        const xvfb = this.spawnProcess("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-noreset"],
          { env: this.env, detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"] });
        this.xvfb = xvfb;
        xvfb.on("error", () => {});
        display = await new Promise((resolve, reject) => {
          let output = "";
          const timer = setTimeout(() => done(new Error("Xvfb 启动超时")), this.startupMs);
          const done = (error, value) => {
            clearTimeout(timer); xvfb.off("error", onError); xvfb.off("exit", onExit);
            xvfb.stdio[3].off("data", onData);
            error ? reject(error) : resolve(value);
          };
          const onError = () => done(new Error("Xvfb 未安装或无法启动，请运行 browser-setup.sh"));
          const onExit = () => done(new Error("Xvfb 启动失败"));
          const onData = (data) => { output += data; if (/^\d+\n/.test(output)) done(null, `:${Number(output.trim())}`); };
          xvfb.on("error", onError); xvfb.on("exit", onExit); xvfb.stdio[3].on("data", onData);
        });
        xvfb.on("exit", () => { if (this.xvfb === xvfb) { this.emit("exit"); void this.cleanup(); } });
        if (!alive(xvfb)) throw new Error("Xvfb 意外退出");
      }
      const chrome = this.launch(executable, chromeArgs(this.profile, this), { ...this.env, ...(display ? { DISPLAY: display } : {}) });
      this.chrome = chrome;
      chrome.on("exit", () => {
        if (this.chrome !== chrome) return;
        this.endpoint = null;
        this.emit("exit");
        void this.cleanup();
      });
      const deadline = Date.now() + this.startupMs;
      while (Date.now() < deadline) {
        if (!alive(chrome) || !chrome.pid) throw new Error("Chrome 启动失败，请检查安装、沙箱和 profile 是否被其他进程占用");
        if (fs.existsSync(portFile)) {
          const [port, wsPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
          if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535 && /^\/devtools\/browser\/[\w-]+$/.test(wsPath)) {
            this.endpoint = `ws://127.0.0.1:${port}${wsPath}`;
            return this.endpoint;
          }
        }
        await delay(40);
      }
      throw new Error("Chrome 远程调试启动超时");
    } catch (error) { await this.cleanup(); throw error; }
  }

  async kill(child) {
    if (!child?.pid) return;
    const signal = (name) => {
      try { process.kill(-child.pid, name); }
      catch { if (alive(child)) { try { child.kill(name); } catch {} } }
    };
    signal("SIGTERM");
    if (alive(child)) await new Promise((resolve) => {
      const timer = setTimeout(done, this.stopMs);
      function done() { clearTimeout(timer); child.off("exit", done); resolve(); }
      child.once("exit", done);
      if (!alive(child)) done();
    });
    // Also remove orphan renderers when the browser's main process has already exited.
    signal("SIGKILL");
  }

  async cleanup() {
    if (this.cleaning) return this.cleaning;
    const chrome = this.chrome, xvfb = this.xvfb;
    this.chrome = null; this.xvfb = null; this.endpoint = null;
    this.cleaning = (async () => { await this.kill(chrome); await this.kill(xvfb); })();
    try { await this.cleaning; }
    finally { this.cleaning = null; }
  }

  async waitForExit(timeoutMs = 2000) {
    const child = this.chrome;
    if (!alive(child)) return;
    await new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done() { clearTimeout(timer); child.off("exit", done); resolve(); }
      child.once("exit", done);
      if (!alive(child)) done();
    });
  }

  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => { await this.starting?.catch(() => {}); await this.cleanup(); })();
    try { await this.stopping; }
    finally { this.stopping = null; }
  }
}
