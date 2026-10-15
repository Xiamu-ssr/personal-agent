import { EventEmitter } from "node:events";
import { chromium } from "playwright-core";
import { BrowserProcess, VIEWPORT } from "./process.mjs";
import { SystemdBrowserProcess } from "./systemd-process.mjs";
import { dispatchInput } from "./input.mjs";

export const USER_BUSY = "用户正在操作，等他交还";
const blocked = () => ({ blocked: true, message: USER_BUSY });

export function jpegSize(data) {
  const bytes = Buffer.from(data, "base64");
  for (let offset = 2; offset + 8 < bytes.length;) {
    if (bytes[offset++] !== 0xff) break;
    const marker = bytes[offset++];
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    const size = bytes.readUInt16BE(offset);
    if (size < 2) break;
    offset += size;
  }
  throw new Error("浏览器画面不是有效 JPEG");
}

export class CloudBrowser extends EventEmitter {
  constructor({ manager, connect = (endpoint) => chromium.connectOverCDP(endpoint, { timeout: 10_000 }),
    idleMs = 10 * 60_000, fps = 5, ...options } = {}) {
    super();
    if (!Number.isFinite(idleMs) || idleMs <= 0 || !Number.isFinite(fps) || fps <= 0) throw new Error("浏览器 idleMs/fps 必须是正数");
    this.manager = manager || ((options.service || process.env.AGENT_BROWSER_SERVICE) ? new SystemdBrowserProcess(options) : new BrowserProcess(options));
    Object.assign(this, { connect, idleMs, fps: Math.max(1, Math.min(5, fps)) });
    this.owner = "agent"; this.epoch = 0; this.tail = Promise.resolve();
    this.viewers = 0; this.frames = new Map(); this.sequence = 0; this.lastFrameAt = 0;
    this.url = ""; this.title = ""; this.reason = "";
    this.manager.on("exit", () => this.disconnected());
  }

  state() {
    return { t: "browser_state", state: !this.page ? "closed" : this.owner === "user" ? "user" : this.activeAgent ? "agent" : "idle",
      control: this.owner, url: this.url, title: this.title, reason: this.reason,
      dialog: this.dialog || null,
      viewers: this.viewers, idleTimeoutMs: this.idleMs, lastActivityAt: this.lastActivityAt || null };
  }

  publish() { this.emit("state", this.state()); }
  queue(fn) { const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result; }

  touch() {
    this.lastActivityAt = Date.now();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const finish = () => this.queue(async () => {
        if (!this.activeAgent && this.page && Date.now() - this.lastActivityAt >= this.idleMs) await this.closeNow("idle");
      });
      // A modal dialog can hold the CDP input call open; dismiss only when closing on idle.
      if (this.dialog) void this.dismissDialog().then(finish).catch(() => {});
      else void finish().catch(() => {});
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  disconnected() {
    this.abort?.abort();
    clearTimeout(this.ackTimer); this.ackTimer = null; clearTimeout(this.idleTimer); clearInterval(this.stateTimer);
    this.browser = null; this.page = null; this.cdp = null; this.casting = false; this.dialog = null; this.titleRead = null;
    this.frames.clear(); this.lastFrame = null; this.pendingFrame = null; this.pendingAcks = [];
    this.publish();
  }

  async ensure() {
    if (this.page && !this.page.isClosed() && this.browser?.isConnected()) return;
    const endpoint = await this.manager.ensure();
    const browser = await this.connect(endpoint);
    this.browser = browser;
    browser.on("disconnected", () => { if (this.browser === browser) this.disconnected(); });
    try {
      const context = browser.contexts()[0];
      if (!context) throw new Error("Chrome 默认用户上下文不可用");
      this.page = context.pages()[0] || await context.newPage();
      for (const extra of context.pages()) if (extra !== this.page) await extra.close();
      context.on("page", (extra) => { if (extra !== this.page) void extra.close().catch(() => {}); });
      // Keep links and scripted popups in the sole tab, including on subsequent navigations.
      await context.addInitScript(() => {
        window.open = (url) => { if (url) location.assign(url); return null; };
        document.addEventListener("click", (event) => {
          const link = event.composedPath().find((node) => node?.tagName === "A");
          if (link) link.target = "_self";
        }, true);
        document.addEventListener("submit", (event) => { event.target.target = "_self"; }, true);
      });
      context.setDefaultTimeout(8000); context.setDefaultNavigationTimeout(15_000);
      await this.page.setViewportSize(VIEWPORT);
      this.cdp = await context.newCDPSession(this.page);
      await this.cdp.send("Page.enable");
      await this.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: this.manager.downloads });
      this.cdp.on("Page.screencastFrame", (event) => this.onFrame(event));
      this.cdp.on("Page.javascriptDialogClosed", () => { this.dialog = null; this.publish(); });
      this.page.on("dialog", (dialog) => {
        this.dialog = { type: dialog.type(), message: dialog.message().slice(0, 4000), defaultValue: dialog.defaultValue().slice(0, 4000) };
        if (this.owner === "user") this.publish();
        else void this.takeover("网页弹出对话框，请你确认").catch(() => {});
      });
      this.page.on("framenavigated", (frame) => {
        if (frame !== this.page?.mainFrame()) return;
        this.frames.clear(); this.lastFrame = null; this.pendingFrame = null;
        void this.refreshState();
      });
      this.page.on("close", () => { if (this.browser === browser) this.disconnected(); });
      this.stateTimer = setInterval(() => void this.refreshState(), 2000);
      this.stateTimer.unref?.();
      await this.refreshState();
      this.touch();
      await this.syncCast();
    } catch (error) { await this.manager.stop(); this.disconnected(); throw error; }
  }

  async refreshState() {
    const page = this.page;
    if (!page || this.dialog) return;
    const url = page.url();
    if (url !== this.url) { this.url = url; this.title = ""; this.publish(); }
    // title() has no Playwright timeout. Never let a stalled renderer hold the control queue.
    if (this.titleRead) return;
    const read = page.title().catch(() => this.title);
    this.titleRead = read;
    void read.then((title) => {
      if (page === this.page && page.url() === url && title !== this.title) { this.title = title; this.publish(); }
    }).finally(() => { if (this.titleRead === read) this.titleRead = null; });
  }

  async runAgent(fn, { onStart = () => {} } = {}) {
    if (this.owner === "user") return blocked();
    const epoch = this.epoch;
    return this.queue(async () => {
      if (this.owner === "user" || epoch !== this.epoch) return blocked();
      await onStart();
      if (this.owner === "user" || epoch !== this.epoch) return blocked();
      this.abort = new AbortController();
      const signal = this.abort.signal;
      this.activeAgent = true; this.touch(); this.publish();
      try {
        await this.ensure();
        signal.throwIfAborted();
        this.publish();
        return await fn(this.page, signal);
      } catch (error) {
        if (this.owner === "user" || epoch !== this.epoch) return blocked();
        throw error;
      } finally {
        this.abort = null; this.activeAgent = false;
        if (this.page) this.touch();
        await this.refreshState(); this.publish();
      }
    });
  }

  async open() { return this.queue(async () => { await this.ensure(); this.touch(); this.publish(); return this.state(); }); }

  async takeover(reason = "") {
    this.owner = "user"; this.reason = reason; this.epoch++;
    this.abort?.abort(); this.touch(); this.publish();
    return this.queue(async () => { await this.ensure(); this.touch(); this.publish(); return this.state(); });
  }

  async handBack() {
    if (this.dialog) throw Object.assign(new Error("请先处理网页对话框再交还"), { status: 409 });
    return this.queue(async () => {
      if (this.dialog) throw Object.assign(new Error("请先处理网页对话框再交还"), { status: 409 });
      await this.releasePointer();
      const wasUser = this.owner === "user", reason = this.reason;
      this.owner = "agent"; this.reason = ""; this.epoch++;
      if (this.page) this.touch();
      this.publish();
      if (wasUser) this.emit("returned", { ...this.state(), t: "browser_returned", reason });
      return this.state();
    });
  }

  async input(event) {
    const epoch = this.epoch;
    if (this.owner !== "user") throw Object.assign(new Error("请先接管浏览器"), { status: 409 });
    // Dialog answers must unblock, rather than queue behind, the click which opened the dialog.
    if (event.type === "dialog") {
      if (!this.dialog || !this.cdp) throw Object.assign(new Error("当前没有网页对话框"), { status: 409 });
      this.touch(); await dispatchInput(this.cdp, event, this.frames, this);
      this.dialog = null; this.publish(); return { ok: true };
    }
    if (this.dialog) throw Object.assign(new Error("请先处理网页对话框"), { status: 409 });
    return this.queue(async () => {
      if (this.owner !== "user" || epoch !== this.epoch) throw Object.assign(new Error("接管已结束，请重新接管"), { status: 409 });
      if (!this.cdp) throw Object.assign(new Error("浏览器已关闭，请重新打开并接管"), { status: 409 });
      this.touch();
      await dispatchInput(this.cdp, event, this.frames, this);
      await this.refreshState();
      return { ok: true };
    });
  }

  async releasePointer() {
    if (this.pointerDown && this.cdp) await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...this.pointerDown, button: "left", buttons: 0, clickCount: 1 }).catch(() => {});
    this.pointerDown = null;
  }

  setViewers(count) {
    this.viewers = count; this.publish();
    void this.syncCast().catch(() => {});
  }

  async syncCast() {
    if (!this.cdp) return;
    if (this.viewers > 0 && !this.casting) {
      this.casting = true; this.lastFrameAt = 0;
      try { await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 65, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 }); }
      catch (error) { this.casting = false; throw error; }
    } else if (!this.viewers && this.casting) {
      this.casting = false; clearTimeout(this.ackTimer); this.ackTimer = null;
      this.flushAcks(); this.pendingFrame = null;
      await this.cdp.send("Page.stopScreencast").catch(() => {});
      this.lastFrame = null;
    }
  }

  onFrame({ data, metadata, sessionId }) {
    const cdp = this.cdp;
    const ack = () => { void cdp?.send("Page.screencastFrameAck", { sessionId }).catch(() => {}); };
    if (!this.casting || !this.viewers) { ack(); return; }
    this.pendingFrame = { data, metadata };
    (this.pendingAcks ||= []).push(ack);
    if (this.ackTimer) return;
    const wait = Math.max(0, 1000 / this.fps - (Date.now() - this.lastFrameAt));
    // Delay acknowledgements as well as delivery, so a busy page cannot encode unbounded frames.
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null; this.flushAcks();
      if (cdp !== this.cdp || !this.casting || !this.viewers) return;
      try {
        const { data, metadata } = this.pendingFrame;
        this.pendingFrame = null;
        const { width, height } = jpegSize(data);
        const viewport = { width: metadata.deviceWidth / metadata.pageScaleFactor,
          height: (metadata.deviceHeight - metadata.offsetTop) / metadata.pageScaleFactor };
        const frame = { t: "browser_frame", frameId: ++this.sequence, mimeType: "image/jpeg", data, width, height, viewport, timestamp: Date.now() };
        this.frames.set(frame.frameId, { width, height, viewport });
        while (this.frames.size > 32) this.frames.delete(this.frames.keys().next().value);
        this.lastFrame = frame; this.lastFrameAt = frame.timestamp;
        this.emit("frame", frame);
      } catch {}
    }, wait);
    this.ackTimer.unref?.();
  }

  flushAcks() { for (const ack of this.pendingAcks || []) ack(); this.pendingAcks = []; }

  async closeNow(reason = "closed") {
    this.abort?.abort();
    await this.dismissDialog();
    await this.releasePointer();
    clearTimeout(this.ackTimer); clearInterval(this.stateTimer); clearTimeout(this.idleTimer);
    // Browser.close flushes cookies/profile before falling back to process-group termination.
    if (this.cdp) {
      let timer;
      await Promise.race([this.cdp.send("Browser.close").catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, 1000); })]);
      clearTimeout(timer);
      await this.manager.waitForExit?.();
    }
    await this.manager.stop();
    this.reason = reason; this.disconnected();
  }

  async dismissDialog() {
    if (this.dialog && this.cdp) await this.cdp.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
    this.dialog = null;
  }

  async close() {
    this.abort?.abort(); this.epoch++;
    const dismissed = this.dismissDialog();
    return this.queue(async () => { await dismissed; return this.closeNow(); });
  }
}

const browsers = new Map();
export function sharedBrowser(options = {}) {
  const root = options.root || process.env.AGENT_ROOT || "/srv/agent";
  if (!browsers.has(root)) browsers.set(root, new CloudBrowser({ ...options, root }));
  return browsers.get(root);
}
