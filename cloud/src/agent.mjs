// The Claude Harness: one long-lived main thread + isolated sessions for cron / catch-up.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config, CODE, MEMORY_CATEGORIES } from "./config.mjs";
import { readJson, appendJsonl, nowIn } from "./store.mjs";
import { transcribe, audioFormat } from "./transcribe.mjs";
import { ConnectorManager, customPlugins, customConnectorEnv, writePrivateJson } from "./connectors.mjs";
import { checkConnectorAccess, CONNECTOR_GUARD_TOOLS } from "./connector-guard.mjs";
import { COMPACT_INSTRUCTIONS, inputUsage } from "./context-policy.mjs";
import { contextFailure, humanError, recoveryContext, withRecovery, RECOVERY_NOTICE } from "./conversation-recovery.mjs";

const WRITE_TOOLS = "Write|Edit|MultiEdit|NotebookEdit";
const IMAGE_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
const KIND_LABEL = { image: "图片", file: "文件", voice: "语音笔记" };
const shellQuote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";

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
    for (const [key, value] of Object.entries(process.env)) {
      if (/(?:TOKEN|KEY|SECRET|PASSWORD)$/i.test(key) && value?.length >= 8) connectors.knownSecrets?.add(value);
    }
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

  compactionControl(getQuery = () => undefined) {
    const owners = new Set();
    const control = {
      active: false,
      before: async (input) => {
        owners.add(input?.agent_id || "main");
        control.active = true;
        const q = getQuery();
        if (!q?.applyFlagSettings) throw new Error("SDK 缺少压缩 effort 控制接口，请使用锁定的 SDK 版本");
        // The CLI's compactor inherits thinking/effort. Change its live flag cap BEFORE its request.
        // Keep adaptive thinking: Haiku at max cannot accept disabled thinking; low is sufficient here.
        await q.applyFlagSettings({ effortLevel: config.compactEffort, maxEffortLevel: config.compactEffort });
        return {};
      },
      restore: async (input) => {
        if (input?.hook_event_name) owners.delete(input.agent_id || "main");
        else owners.clear(); // turn ended/failed: no stale compact flag may carry into the next main turn
        if (!control.active || owners.size) return {};
        const q = getQuery();
        if (!q?.applyFlagSettings) return {};
        await q.applyFlagSettings({ effortLevel: config.effort, maxEffortLevel: "max" });
        control.active = false;
        return {};
      },
    };
    return control;
  }

  options({ isolated, onWrite, compaction = this.compactionControl() }) {
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
      settings: {
        availableModels: [m],
        // Teach the CLI that a gateway's dotted/provider ID has the canonical model's capabilities.
        ...(config.context.canonical && { modelOverrides: { [config.context.canonical]: m } }),
        autoCompactEnabled: true,
        precomputeCompactionEnabled: false,
        idleCompaction: false,
        hooks: { PreCompact: [{ hooks: [{ type: "command", timeout: 10,
          command: `${shellQuote(process.execPath)} ${shellQuote(path.join(CODE, "scripts/compact-instructions.mjs"))}` }] }] },
      },
      plugins: customPlugins(),
      mcpServers: { devices: this.hub.mcpServer(), ...this.connectors.mcpServers() },
      includePartialMessages: !isolated,
      agentProgressSummaries: true,
      spawnClaudeCodeProcess: (o) => {
        // Log only these numeric policy values, never the subprocess's full environment.
        this.log(`[sdk env] max_output=${o.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS} compact_window=${o.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW} compact_pct=${o.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE}`);
        return spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ["pipe", "pipe", "pipe"] });
      },
      env: {
        ...process.env,
        ...customConnectorEnv(),
        CLAUDE_CONFIG_DIR: config.sessions,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: m,
        ANTHROPIC_DEFAULT_SONNET_MODEL: m,
        ANTHROPIC_DEFAULT_OPUS_MODEL: m,
        CLAUDE_CODE_SUBAGENT_MODEL: m,
        // Last in the env overlay: project/custom .env cannot disable the 100K policy.
        ...config.context.env,
      },
      hooks: {
        UserPromptSubmit: [{ hooks: [async () => this.promptContext()] }],
        PreCompact: [{ hooks: [compaction.before] }],
        PostCompact: [{ hooks: [compaction.restore] }],
        SubagentStop: [{ hooks: [compaction.restore] }],
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
    let q;
    const compaction = this.compactionControl(() => q);
    const opts = this.options({ isolated: false, onWrite: (r) => this.noteWrite(r), compaction });
    if (state.mainSessionId) opts.resume = state.mainSessionId;
    q = this.queryFactory({ prompt: inbox, options: opts });
    const main = { q, inbox, compaction, reply: "", recoveryContext: state.mainRecovery?.context,
      reloadRevision: this.reloadRevision, connectorRevision: this.connectors.revision };
    this.main = main;
    this.busy = false;
    main.finished = (async () => {
      try {
        for await (const m of q) this.onMainMessage(m, main);
        if (!main.intentionalClose && main.active) {
          if (!main.failure) this.recordFailure(main, "SDK process ended before a result");
          this.finishMainTurn(main, { subtype: "error_during_execution" });
        }
        if (!main.intentionalClose) this.log("main thread ended");
      } catch (e) {
        if (!main.intentionalClose) {
          this.recordFailure(main, e.message);
          this.finishMainTurn(main, { subtype: "error_during_execution" });
        }
      }
      if (main.intentionalClose || this.main !== main) return;
      main.ended = true;
      main.inbox.close();
      this.busy = false;
      this.bus.emit({ t: "status", busy: false });
      if (this.turnQueue.length || main.needsFresh) {
        this.scheduleDispatch().catch((e) => this.log("dispatch failed:", this.connectors.redact(e.message)));
        return;
      }
      this.restartTimer = setTimeout(() => {
        this.startMain();
        this.scheduleDispatch().catch((e) => this.log("dispatch failed:", this.connectors.redact(e.message)));
      }, 3000);
    })();
  }

  async dispatchNextTurn() {
    if (this.busy) return;
    if (!this.turnQueue.length && !this.main?.needsFresh) return;
    if (!this.main) this.startMain();
    if (this.main.ended || this.main.needsFresh || this.main.reloadRevision !== this.reloadRevision || this.main.connectorRevision !== this.connectors.revision) {
      const old = this.main;
      old.intentionalClose = true;
      old.inbox.close();
      old.q.close();
      await old.finished;
      this.startMain(); // Same session for MCP changes; fresh session only after an explicit context failure.
      this.log("main query rebuilt");
    }
    if (!this.turnQueue.length) return;
    await this.main.compaction.restore();
    const active = this.turnQueue.shift();
    this.main.active = active;
    this.main.toolsUsed = false;
    this.main.failure = null;
    this.main.reply = "";
    this.busy = true;
    this.bus.emit({ t: "status", busy: true });
    this.main.inbox.push(withRecovery(active.input, this.main.recoveryContext));
  }

  scheduleDispatch() {
    this.dispatchChain = this.dispatchChain.then(() => this.dispatchNextTurn(), () => this.dispatchNextTurn());
    return this.dispatchChain;
  }

  onMainMessage(m, main = this.main) {
    if (this.main !== main || main.intentionalClose) return;
    if (m.type === "system" && m.subtype === "init") {
      const state = readJson(config.stateFile, {});
      if (state.mainSessionId !== m.session_id) writePrivateJson(config.stateFile, { ...state, mainSessionId: m.session_id });
      this.log(`main session ${m.session_id} mode=${m.permissionMode} model=${m.model}`);
      return;
    }
    if (m.type === "system" && m.subtype === "status") {
      if (m.status === "compacting") {
        if (!main.compacting) this.bus.emit({ t: "delta", text: "对话太长，正在整理上下文…\n" });
        main.compacting = true;
      }
      if (m.compact_result === "failed") this.recordFailure(main, `Error during compaction: ${m.compact_error || "unknown"}`);
      if (m.status === null) main.compacting = false;
      return;
    }
    if (m.type === "system" && m.subtype === "compact_boundary") {
      main.compacting = false;
      main.failure = null; // a CLI retry can successfully recover after a prompt-too-long response
      this.log("[compact] success", JSON.stringify(m.compact_metadata || {}));
      return;
    }
    if (m.type === "system" && m.subtype === "local_command_output") {
      if (contextFailure(m.content)) this.recordFailure(main, m.content);
      return;
    }
    if (m.type === "system" && m.subtype === "api_retry") {
      this.log("[api retry]", m.error, m.error_status, `attempt=${m.attempt}`);
      return;
    }
    if (m.type === "system" && m.subtype?.startsWith("task_")) {
      if (m.ambient) return;
      const taskError = contextFailure(m.summary || "") || /^(?:API Error|Error during)/i.test(m.summary || "");
      if (taskError) this.log("[task model error]", this.connectors.redact(m.summary));
      this.bus.emit({
        t: "task", phase: m.subtype.slice(5), id: m.task_id,
        description: m.description, summary: taskError ? humanError(m.summary) : m.summary, status: m.status,
      });
      return;
    }
    if (m.parent_tool_use_id) return; // subagent internals stay out of the chat
    if (m.type === "stream_event") {
      const ev = m.event;
      if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") main.toolsUsed = true;
      if (!main.compacting && !main.failure && ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        this.bus.emit({ t: "delta", text: ev.delta.text });
      }
      return;
    }
    if (m.type === "assistant") {
      const raw = (m.message?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (m.error || (m.message?.model === "<synthetic>" && contextFailure(raw))) {
        this.recordFailure(main, raw || m.error, m.error);
        return;
      }
      if (m.message?.usage) {
        const tokens = inputUsage(m.message.usage);
        this.log(`[context] input=${tokens} target=${config.context.inputLimit} trigger=${config.context.triggerTokens}`);
      }
      for (const b of m.message?.content || []) {
        if (b.type === "text") main.reply += (main.reply ? "\n\n" : "") + b.text;
        if (b.type === "tool_use") {
          main.toolsUsed = true;
          this.bus.emit({ t: "tool", name: b.name, hint: this.connectors.redact(toolHint(b)) });
        }
      }
      return;
    }
    if (m.type === "result") {
      if (m.subtype !== "success" && !main.failure) this.recordFailure(main, (m.errors || []).join("\n") || m.result || m.subtype);
      this.finishMainTurn(main, m);
    }
  }

  recordFailure(main, raw, code) {
    this.log("[model error]", this.connectors.redact(raw));
    const isContext = contextFailure(raw);
    // A later generic result must not obscure the compaction error that explains the failure.
    if (!main.failure?.context || isContext) main.failure = { raw, code, context: isContext };
  }

  finishMainTurn(main, result) {
    let text = main.reply.trim(), error;
    if (main.failure) {
      error = humanError(main.failure.raw, main.failure.code);
      text = error;
      if (main.failure.context) {
        const state = readJson(config.stateFile, {});
        if (main.reply.trim()) {
          const partial = main.reply.length <= 8000 ? main.reply : main.reply.slice(0, 2000) + "\n（中段省略）\n" + main.reply.slice(-6000);
          appendJsonl(config.chatLog, { role: "assistant", partial: true, ts: Date.now(),
            text: this.connectors.redact("本轮失败前的部分回复（未完成，需核对文件中的实际进度）：\n" + partial) });
        }
        const context = recoveryContext({ root: config.root, chatLog: config.chatLog, redact: (s) => this.connectors.redact(s) });
        // Update only session routing. Never touch data/, schedule.json, the chat archive or old SDK transcripts.
        writePrivateJson(config.stateFile, { ...state, mainSessionId: null,
          mainRecovery: { context, fromSession: state.mainSessionId, ts: Date.now() } });
        main.needsFresh = true;
        const active = main.active;
        const retry = active && !active.manualCompact && !main.toolsUsed && !active.recoveryAttempt;
        if (retry) this.turnQueue.unshift({ ...active, recoveryAttempt: 1 });
        text = RECOVERY_NOTICE + (retry ? "正在继续处理刚才的消息。" : active?.recoveryAttempt ? "这条消息仍然过长，请缩短内容或分批发送。" : "请继续发送消息。");
        this.log("[context recovery] fresh session; automatic replay=" + Boolean(retry));
      }
    } else if (result.subtype === "success" && main.recoveryContext) {
      const state = readJson(config.stateFile, {});
      delete state.mainRecovery;
      writePrivateJson(config.stateFile, state);
      main.recoveryContext = null;
    }
    main.reply = "";
    main.active = null;
    this.busy = false;
    if (text) appendJsonl(config.chatLog, { role: "assistant", text, ts: Date.now(), ...(error && { error: true }) });
    this.bus.emit({ t: "turn_end", text, error });
    this.scheduleDispatch().catch((e) => this.log("dispatch failed:", this.connectors.redact(e.message)));
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
    this.turnQueue.push({ input: { type: "user", message: { role: "user", content: userContent(text, atts) }, parent_tool_use_id: null } });
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
    this.turnQueue.push({ manualCompact: true, input: { type: "user", message: { role: "user", content: `/compact ${COMPACT_INSTRUCTIONS}` }, parent_tool_use_id: null } });
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
      let q;
      const inbox = new Inbox();
      const compaction = this.compactionControl(() => q);
      try {
        // Streaming input permits live effort control in PreCompact, just as in the main session.
        q = this.queryFactory({ prompt: inbox, options: this.options({ isolated: true, onWrite: (r) => this.noteWrite(r, job), compaction }) });
        inbox.push({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null });
        for await (const m of q) {
          if (m.type === "system" && m.subtype === "compact_boundary") job.error = undefined;
          if (m.type === "system" && m.subtype === "status" && m.compact_result === "failed") {
            job.error = `Error during compaction: ${m.compact_error || "unknown"}`;
          }
          if (m.type === "assistant" && !m.parent_tool_use_id) {
            for (const b of m.message?.content || []) if (b.type === "text") {
              if (m.error || (m.message?.model === "<synthetic>" && contextFailure(b.text))) job.error = b.text;
              else job.text = b.text;
            }
          }
          if (m.type === "result") {
            job.ok = m.subtype === "success" && !job.error;
            if (!job.ok) job.error ||= (m.errors || []).join("\n") || m.subtype;
            inbox.close();
          }
        }
      } catch (e) {
        job.ok = false;
        job.error = e.message;
      } finally {
        inbox.close();
        q?.close();
      }
      if (job.error) {
        this.log("[job model error]", this.connectors.redact(job.error));
        job.text = humanError(job.error);
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
