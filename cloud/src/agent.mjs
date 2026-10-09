// The Claude Harness: one long-lived main thread + isolated sessions for cron / catch-up.
import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config, MEMORY_CATEGORIES } from "./config.mjs";
import { readJson, writeJson, appendJsonl, nowIn } from "./store.mjs";
import { transcribe, audioFormat } from "./transcribe.mjs";
import { ConnectorManager, customPlugins, customConnectorEnv } from "./connectors.mjs";
import { checkConnectorAccess, CONNECTOR_GUARD_TOOLS } from "./connector-guard.mjs";

const WRITE_TOOLS = "Write|Edit|MultiEdit|NotebookEdit";
const IMAGE_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
const KIND_LABEL = { image: "图片", file: "文件", voice: "语音笔记" };

// An async iterable the SDK reads user messages from (streaming input mode).
class Inbox {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(item) {
    const w = this.waiters.shift();
    w ? w({ value: item, done: false }) : this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

// The spec file starts with notes for humans; the prompt is everything after the first "---" line.
// Placeholders are filled once, so the string never changes between turns (prompt cache).
let promptCache = null;
function systemPrompt() {
  if (promptCache) return promptCache;
  const raw = fs.readFileSync(config.promptFile, "utf8");
  const body = raw.split(/\n---\n/).slice(1).join("\n---\n").trim();
  // The source keeps a space around placeholders for readability; drop it only where it touches CJK text.
  const cjk = "[\\u3000-\\u9fff\\uff00-\\uffef]";
  const fill = (s, key, val) => (!new RegExp(cjk).test(val) ? s : s
    .replace(new RegExp(`(?<=${cjk}) \\{${key}\\}`, "g"), `{${key}}`)
    .replace(new RegExp(`\\{${key}\\} (?=${cjk})`, "g"), `{${key}}`))
    .replaceAll(`{${key}}`, val);
  promptCache = fill(fill(fill(body, "名字", config.agentName), "称呼", config.userCall), "时区", config.timezone);
  return promptCache;
}

function rel(p) {
  if (!p) return "";
  const abs = path.isAbsolute(p) ? p : path.join(config.root, p);
  return path.relative(config.root, abs);
}

// "data/memory/<category>/<topic>.md", one level, known categories only.
function memoryPathError(r) {
  if (!r.startsWith("data/memory/")) return null;
  const parts = r.split("/");
  if (parts.length !== 4 || !parts[3].endsWith(".md")) {
    return `记忆路径必须是 data/memory/<分类>/<主题>.md（只有一层目录），你写的是 ${r}`;
  }
  if (!MEMORY_CATEGORIES.includes(parts[2])) {
    return `没有分类「${parts[2]}」。可用分类：${MEMORY_CATEGORIES.join(" · ")}`;
  }
  if (parts[2] === "profile" && parts[3] !== "总档.md") return "profile/ 里只能有 总档.md";
  return null;
}

export class Harness {
  constructor({ hub, bus, log, connectors = new ConnectorManager(), queryFactory = query }) {
    this.hub = hub;
    this.bus = bus;
    this.log = log;
    this.connectors = connectors;
    this.queryFactory = queryFactory;
    this.main = null;
    this.turnQueue = [];
    this.dispatchChain = Promise.resolve();
    this.reloadRevision = 0;
    const previousOnChange = connectors.onChange;
    connectors.onChange = (name) => {
      previousOnChange(name);
      this.reloadSoon();
      this.bus.emit({ t: "connectors_changed", name });
    };
    this.jobChain = Promise.resolve();
    this.busy = false;
    this.running = new Map(); // label -> started (isolated jobs, queued or running)
  }

  options({ isolated, onWrite }) {
    const m = config.model;
    return {
      model: m,
      cwd: config.root,
      systemPrompt: systemPrompt(),
      permissionMode: config.permissionMode,
      // The user grants device capabilities on the device itself; asking the classifier again only adds cost and false refusals.
      allowedTools: [
        "mcp__devices__list_devices", "mcp__devices__call_device", "mcp__devices__read_since", "mcp__devices__sync_commit",
        "mcp__connectors__list", "mcp__connectors__add_account", "mcp__connectors__update_account", "mcp__connectors__remove_account",
        ...[...this.connectors.definitions.keys()].map((name) => "mcp__" + name + "__*"),
      ],
      thinking: { type: "adaptive" },
      effort: config.effort,
      allowDangerouslySkipPermissions: config.permissionMode === "bypassPermissions",
      settingSources: ["project"],
      settings: { availableModels: [m] },
      plugins: customPlugins(),
      mcpServers: { devices: this.hub.mcpServer(), ...this.connectors.mcpServers() },
      includePartialMessages: !isolated,
      agentProgressSummaries: true,
      env: {
        ...process.env,
        ...customConnectorEnv(),
        CLAUDE_CONFIG_DIR: config.sessions,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: m,
        ANTHROPIC_DEFAULT_SONNET_MODEL: m,
        ANTHROPIC_DEFAULT_OPUS_MODEL: m,
        CLAUDE_CODE_SUBAGENT_MODEL: m,
      },
      hooks: {
        UserPromptSubmit: [{ hooks: [async () => this.promptContext()] }],
        PreToolUse: [
          { matcher: CONNECTOR_GUARD_TOOLS, hooks: [async (input) => checkConnectorAccess(input)] },
          { matcher: WRITE_TOOLS, hooks: [async (input) => this.checkWrite(input)] },
        ],
        PostToolUse: [{ matcher: WRITE_TOOLS, hooks: [async (input) => (onWrite(rel(input.tool_input?.file_path)), {})] }],
      },
      stderr: (d) => {
        const s = String(d).trim();
        if (s && !s.includes("unrecognized_model")) this.log("[cc]", this.connectors.redact(s).slice(0, 500));
      },
    };
  }

  promptContext() {
    const devs = this.hub.online();
    const devText = devs.length ? devs.map((d) => `${d.name}（${d.id}）`).join("、") : "无";
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `当前时间：${nowIn(config.timezone)}（${config.timezone}）\n在线设备：${devText}`,
      },
    };
  }

  checkWrite(input) {
    const err = memoryPathError(rel(input.tool_input?.file_path || input.tool_input?.notebook_path));
    if (!err) return {};
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: err },
    };
  }

  // Shared side effects of any write the agent makes.
  noteWrite(r, job) {
    if (!r) return;
    if (r.startsWith("data/memory/")) this.bus.emit({ t: "memory_updated", path: r });
    if (r.startsWith("data/")) this.bus.emit({ t: "files_changed", path: r });
    if (r.startsWith("system/custom-connectors/")) this.reloadSoon();
    if (job && r.endsWith(".html") && (r.startsWith("data/briefs/") || r.startsWith("data/sites/"))) job.outputs.add(r);
  }

  reloadSoon() {
    // SDK setMcpServers() keeps an already-registered same-name SDK instance.
    // Reconstruct the query BEFORE dispatching the next turn instead of replacing it in a running tool call.
    // This also discovers new custom plugin directories and reloads their .env without interrupting a reply.
    this.reloadRevision++;
  }

  // ---------- main thread ----------

  startMain() {
    clearTimeout(this.restartTimer);
    const state = readJson(config.stateFile, {});
    const inbox = new Inbox();
    const startedAt = Date.now();
    const opts = this.options({ isolated: false, onWrite: (r) => this.noteWrite(r) });
    if (state.mainSessionId) opts.resume = state.mainSessionId;
    const q = this.queryFactory({ prompt: inbox, options: opts });
    const main = { q, inbox, reply: "", reloadRevision: this.reloadRevision, connectorRevision: this.connectors.revision };
    this.main = main;
    this.busy = false;
    main.finished = (async () => {
      try {
        for await (const m of q) this.onMainMessage(m, main);
        if (!main.intentionalClose) this.log("main thread ended");
      } catch (e) {
        if (!main.intentionalClose) this.log("main thread error:", this.connectors.redact(e.message));
        if (!main.intentionalClose && opts.resume && Date.now() - startedAt < 15_000) {
          this.log("resume failed, starting a fresh main session");
          writeJson(config.stateFile, { ...state, mainSessionId: null });
        }
      }
      if (main.intentionalClose || this.main !== main) return;
      main.ended = true;
      main.inbox.close();
      this.busy = false;
      this.bus.emit({ t: "status", busy: false });
      this.restartTimer = setTimeout(() => {
        this.startMain();
        this.scheduleDispatch().catch((e) => this.log("dispatch failed:", this.connectors.redact(e.message)));
      }, 3000);
    })();
  }

  async dispatchNextTurn() {
    if (this.busy || !this.turnQueue.length) return;
    if (!this.main) this.startMain();
    if (this.main.ended || this.main.reloadRevision !== this.reloadRevision || this.main.connectorRevision !== this.connectors.revision) {
      const old = this.main;
      old.intentionalClose = true;
      old.inbox.close();
      old.q.close();
      await old.finished;
      this.startMain(); // startMain reads mainSessionId and resumes the same conversation.
      this.log("main query rebuilt with current connectors");
    }
    this.busy = true;
    this.bus.emit({ t: "status", busy: true });
    this.main.inbox.push(this.turnQueue.shift());
  }

  scheduleDispatch() {
    this.dispatchChain = this.dispatchChain.then(() => this.dispatchNextTurn(), () => this.dispatchNextTurn());
    return this.dispatchChain;
  }

  onMainMessage(m, main = this.main) {
    if (this.main !== main || main.intentionalClose) return;
    if (m.type === "system" && m.subtype === "init") {
      const state = readJson(config.stateFile, {});
      if (state.mainSessionId !== m.session_id) writeJson(config.stateFile, { ...state, mainSessionId: m.session_id });
      this.log(`main session ${m.session_id} mode=${m.permissionMode} model=${m.model}`);
      return;
    }
    if (m.type === "system" && m.subtype?.startsWith("task_")) {
      if (m.ambient) return;
      this.bus.emit({
        t: "task", phase: m.subtype.slice(5), id: m.task_id,
        description: m.description, summary: m.summary, status: m.status,
      });
      return;
    }
    if (m.parent_tool_use_id) return; // subagent internals stay out of the chat
    if (m.type === "stream_event") {
      const ev = m.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        this.bus.emit({ t: "delta", text: ev.delta.text });
      }
      return;
    }
    if (m.type === "assistant") {
      for (const b of m.message?.content || []) {
        if (b.type === "text") main.reply += (main.reply ? "\n\n" : "") + b.text;
        if (b.type === "tool_use") this.bus.emit({ t: "tool", name: b.name, hint: this.connectors.redact(toolHint(b)) });
      }
      return;
    }
    if (m.type === "result") {
      const text = main.reply.trim();
      main.reply = "";
      if (text) appendJsonl(config.chatLog, { role: "assistant", text, ts: Date.now() });
      this.busy = false;
      this.bus.emit({ t: "turn_end", text, error: m.subtype !== "success" ? m.subtype : undefined });
      this.scheduleDispatch().catch((e) => this.log("dispatch failed:", this.connectors.redact(e.message)));
    }
  }

  // attachments: [{ path: "data/uploads/...", name, kind: "image" | "file" | "voice" }], already uploaded.
  async send(text, source = "app", attachments = []) {
    if (!this.main) throw new Error("main thread not ready");
    const atts = [];
    for (const a of attachments) {
      const abs = path.resolve(config.root, a.path || "");
      if (!abs.startsWith(path.join(config.data, "uploads") + path.sep) || !fs.existsSync(abs)) continue;
      const att = { path: path.relative(config.root, abs), name: a.name || path.basename(abs), kind: KIND_LABEL[a.kind] ? a.kind : "file" };
      if (att.kind === "voice") {
        try {
          att.transcript = await transcribe(fs.readFileSync(abs), audioFormat(abs));
          fs.writeFileSync(abs.replace(/\.[^.]+$/, "") + ".txt", att.transcript + "\n");
        } catch (e) {
          att.transcript = `（转写失败：${e.message}）`;
        }
      }
      atts.push(att);
    }
    const entry = { role: "user", text, ts: Date.now(), source };
    if (atts.length) entry.attachments = atts;
    appendJsonl(config.chatLog, entry);
    this.bus.emit({ t: "user", text, source, attachments: atts });
    this.turnQueue.push({ type: "user", message: { role: "user", content: userContent(text, atts) }, parent_tool_use_id: null });
    await this.scheduleDispatch();
  }

  async interrupt() {
    try {
      await this.main?.q?.interrupt();
    } catch (e) {
      this.log("interrupt failed:", e.message);
    }
  }

  compactMain() {
    if (this.busy) return false;
    this.turnQueue.push({ type: "user", message: { role: "user", content: "/compact" }, parent_tool_use_id: null });
    this.scheduleDispatch().catch((e) => this.log("compact failed:", this.connectors.redact(e.message)));
    return true;
  }

  // ---------- isolated sessions (cron, catch-up, night tidy) ----------

  runIsolated(label, prompt) {
    this.running.set(label, Date.now());
    const run = async () => {
      const job = { label, outputs: new Set(), text: "" };
      const started = Date.now();
      this.running.set(label, started);
      this.bus.emit({ t: "job", phase: "started", label });
      this.log(`job start: ${label}`);
      try {
        const q = this.queryFactory({ prompt, options: this.options({ isolated: true, onWrite: (r) => this.noteWrite(r, job) }) });
        for await (const m of q) {
          if (m.type === "assistant" && !m.parent_tool_use_id) {
            for (const b of m.message?.content || []) if (b.type === "text") job.text = b.text;
          }
          if (m.type === "result") job.ok = m.subtype === "success";
        }
      } catch (e) {
        job.ok = false;
        job.text = `出错：${e.message}`;
      }
      const outputs = [...job.outputs];
      const entry = { role: "card", label, title: job.text.trim().split("\n").pop() || label, outputs, ok: !!job.ok, ts: Date.now() };
      appendJsonl(path.join(config.system, "jobs.jsonl"), { ...entry, ms: Date.now() - started });
      if (outputs.length) appendJsonl(config.chatLog, entry);
      this.bus.emit({ t: "job", phase: "done", ...entry });
      this.running.delete(label);
      this.log(`job done: ${label} ok=${job.ok} outputs=${outputs.join(",")}`);
      return job;
    };
    // One isolated session at a time: the box has under 2 GB of RAM.
    const p = this.jobChain.then(run, run);
    this.jobChain = p.catch(() => {});
    return p;
  }
}

// Text plus a list of attachment paths; images also go in as image blocks so the model sees them right away.
function userContent(text, atts) {
  if (!atts.length) return text;
  const lines = atts.map((a) => {
    if (a.kind === "voice") return `- ${a.path}（语音笔记，转写：${a.transcript || "空"}）`;
    if (a.kind === "image") return `- ${a.path}（图片，已附在本条消息里）`;
    return `- ${a.path}（文件，需要时自己读）`;
  });
  const body = `${text || (atts.every((a) => a.kind === "voice") ? "（一段语音笔记）" : "（发来了附件）")}\n\n[附件]\n${lines.join("\n")}`;
  const blocks = [{ type: "text", text: body }];
  for (const a of atts) {
    const type = IMAGE_TYPES[path.extname(a.path).toLowerCase()];
    if (a.kind !== "image" || !type) continue;
    const buf = fs.readFileSync(path.join(config.root, a.path));
    if (buf.length <= 5 * 1024 * 1024) blocks.push({ type: "image", source: { type: "base64", media_type: type, data: buf.toString("base64") } });
  }
  return blocks;
}

function toolHint(b) {
  const i = b.input || {};
  const s = i.description || i.file_path || i.path || i.pattern || i.url || i.query || i.command || i.prompt || "";
  return String(s).slice(0, 80);
}
