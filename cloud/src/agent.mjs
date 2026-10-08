// The Claude Harness: one long-lived main thread + isolated sessions for cron / catch-up.
import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config, MEMORY_CATEGORIES } from "./config.mjs";
import { readJson, writeJson, appendJsonl, nowIn } from "./store.mjs";

const WRITE_TOOLS = "Write|Edit|MultiEdit|NotebookEdit";

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
  promptCache = body
    .replace(/ ?\{名字\} ?/g, config.agentName)
    .replace(/ ?\{称呼\} ?/g, config.userCall)
    .replace(/ ?\{时区\} ?/g, config.timezone);
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

function connectorPlugins() {
  try {
    return fs
      .readdirSync(config.connectors, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ type: "local", path: path.join(config.connectors, d.name) }));
  } catch {
    return [];
  }
}

// Connector secrets live in system/connectors/<name>/.env; .mcp.json can reference them as ${VAR}.
function connectorEnv() {
  const env = {};
  for (const p of connectorPlugins()) {
    try {
      for (const line of fs.readFileSync(path.join(p.path, ".env"), "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {}
  }
  return env;
}

export class Harness {
  constructor({ hub, bus, log }) {
    this.hub = hub;
    this.bus = bus;
    this.log = log;
    this.main = null;
    this.jobChain = Promise.resolve();
    this.busy = false;
  }

  options({ isolated, onWrite }) {
    const m = config.model;
    return {
      model: m,
      cwd: config.root,
      systemPrompt: systemPrompt(),
      permissionMode: config.permissionMode,
      allowDangerouslySkipPermissions: config.permissionMode === "bypassPermissions",
      settingSources: ["project"],
      settings: { availableModels: [m] },
      plugins: connectorPlugins(),
      mcpServers: { devices: this.hub.mcpServer() },
      includePartialMessages: !isolated,
      agentProgressSummaries: true,
      env: {
        ...process.env,
        ...connectorEnv(),
        CLAUDE_CONFIG_DIR: config.sessions,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: m,
        ANTHROPIC_DEFAULT_SONNET_MODEL: m,
        ANTHROPIC_DEFAULT_OPUS_MODEL: m,
        CLAUDE_CODE_SUBAGENT_MODEL: m,
      },
      hooks: {
        UserPromptSubmit: [{ hooks: [async () => this.promptContext()] }],
        PreToolUse: [{ matcher: WRITE_TOOLS, hooks: [async (input) => this.checkWrite(input)] }],
        PostToolUse: [{ matcher: WRITE_TOOLS, hooks: [async (input) => (onWrite(rel(input.tool_input?.file_path)), {})] }],
      },
      stderr: (d) => {
        const s = String(d).trim();
        if (s && !s.includes("unrecognized_model")) this.log("[cc]", s.slice(0, 500));
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
    if (r.startsWith("system/connectors/")) this.reloadSoon();
    if (job && r.endsWith(".html") && (r.startsWith("data/briefs/") || r.startsWith("data/sites/"))) job.outputs.add(r);
  }

  reloadSoon() {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(async () => {
      try {
        await this.main?.q?.reloadPlugins();
        this.log("plugins reloaded");
      } catch (e) {
        this.log("reloadPlugins failed:", e.message);
      }
    }, 2000);
  }

  // ---------- main thread ----------

  startMain() {
    const state = readJson(config.stateFile, {});
    const inbox = new Inbox();
    const startedAt = Date.now();
    const opts = this.options({ isolated: false, onWrite: (r) => this.noteWrite(r) });
    if (state.mainSessionId) opts.resume = state.mainSessionId;
    const q = query({ prompt: inbox, options: opts });
    this.main = { q, inbox, reply: "" };
    this.busy = false;
    (async () => {
      try {
        for await (const m of q) this.onMainMessage(m);
        this.log("main thread ended");
      } catch (e) {
        this.log("main thread error:", e.message);
        if (opts.resume && Date.now() - startedAt < 15_000) {
          this.log("resume failed, starting a fresh main session");
          writeJson(config.stateFile, { ...state, mainSessionId: null });
        }
      }
      this.busy = false;
      this.bus.emit({ t: "status", busy: false });
      setTimeout(() => this.startMain(), 3000);
    })();
  }

  onMainMessage(m) {
    const main = this.main;
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
        if (b.type === "tool_use") this.bus.emit({ t: "tool", name: b.name, hint: toolHint(b) });
      }
      return;
    }
    if (m.type === "result") {
      const text = main.reply.trim();
      main.reply = "";
      if (text) appendJsonl(config.chatLog, { role: "assistant", text, ts: Date.now() });
      this.busy = false;
      this.bus.emit({ t: "turn_end", text, error: m.subtype !== "success" ? m.subtype : undefined });
    }
  }

  send(text, source = "app") {
    if (!this.main) throw new Error("main thread not ready");
    appendJsonl(config.chatLog, { role: "user", text, ts: Date.now(), source });
    this.bus.emit({ t: "user", text, source });
    this.busy = true;
    this.bus.emit({ t: "status", busy: true });
    this.main.inbox.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
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
    this.main?.inbox.push({ type: "user", message: { role: "user", content: "/compact" }, parent_tool_use_id: null });
    return true;
  }

  // ---------- isolated sessions (cron, catch-up, night tidy) ----------

  runIsolated(label, prompt) {
    const run = async () => {
      const job = { label, outputs: new Set(), text: "" };
      const started = Date.now();
      this.bus.emit({ t: "job", phase: "started", label });
      this.log(`job start: ${label}`);
      try {
        const q = query({ prompt, options: this.options({ isolated: true, onWrite: (r) => this.noteWrite(r, job) }) });
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
      this.log(`job done: ${label} ok=${job.ok} outputs=${outputs.join(",")}`);
      return job;
    };
    // One isolated session at a time: the box has under 2 GB of RAM.
    const p = this.jobChain.then(run, run);
    this.jobChain = p.catch(() => {});
    return p;
  }
}

function toolHint(b) {
  const i = b.input || {};
  const s = i.description || i.file_path || i.path || i.pattern || i.url || i.query || i.command || i.prompt || "";
  return String(s).slice(0, 80);
}
