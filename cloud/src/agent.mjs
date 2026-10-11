// One long-lived main thread: user/schedule turns, native background forks, isolated maintenance.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config, MEMORY_CATEGORIES } from "./config.mjs";
import { readJson, appendJsonl, nowIn } from "./store.mjs";
import { transcribe, audioFormat } from "./transcribe.mjs";
import { ConnectorManager, writePrivateJson } from "./connectors.mjs";
import { checkConnectorAccess, CONNECTOR_GUARD_TOOLS } from "./connector-guard.mjs";
import { inputUsage, contextPolicy, CLI_MODEL_PROFILE } from "./context-policy.mjs";
import { readAppSettings, MODELS, modelEnvironment } from "./app-settings.mjs";
import { TaskHistory } from "./task-history.mjs";
import { contextFailure, humanError, recoveryContext, withRecovery, RECOVERY_NOTICE } from "./conversation-recovery.mjs";
import { BackgroundTasks, TaskError } from "./background-tasks.mjs";
import { isBriefPath, isOutputPath, readBrief } from "./briefs.mjs";

const WRITE_TOOLS = "Write|Edit|MultiEdit|NotebookEdit";
const SCHEDULE_FORK_REASON = '定时简报请先用 Agent（subagent_type: "fork"，run_in_background: true）派到后台，再简短回复用户';
// Some models send tool booleans as strings; the CLI accepts both.
const isTrue = (v) => v === true || v === "true";
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
  if (r === "data/memory/health/latest.json") return null;
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
    this.running = new Map(); // id -> { label, started } (isolated jobs, queued or running)
    this.history = new TaskHistory({ root: config.root, sessions: config.sessions, redact: (s) => connectors.redact(s) });
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
    const selected = readAppSettings(config.root), m = selected.model, context = contextPolicy(m);
    const inheritedEnv = { ...process.env };
    for (const key of ["AGENT_MODEL", "AGENT_PERMISSION_MODE", "AGENT_EFFORT", "AGENT_MODEL_CANONICAL", "AGENT_MAX_OUTPUT_TOKENS", "AGENT_CONTEXT_INPUT_LIMIT", "AGENT_CONTEXT_HEADROOM", "CLAUDE_CODE_CURRIED_TRINKET"]) delete inheritedEnv[key];
    return {
      model: m,
      cwd: config.root,
      systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt() },
      permissionMode: selected.permissionMode,
      // The user grants device capabilities on the device itself; asking the classifier again only adds cost and false refusals.
      allowedTools: [
        "mcp__devices__list_devices", "mcp__devices__call_device", "mcp__devices__read_since", "mcp__devices__sync_commit",
        "mcp__connectors__list", "mcp__connectors__add_account", "mcp__connectors__update_account", "mcp__connectors__remove_account",
        ...[...this.connectors.definitions.keys()].map((name) => "mcp__" + name + "__*"),
      ],
      thinking: { type: "adaptive" },
      effort: config.effort,
      allowDangerouslySkipPermissions: true,
      settingSources: ["project"],
      settings: {
        availableModels: MODELS.map((row) => row.id),
        modelPicker: { replaceBuiltInOptions: true, options: MODELS.map((row) => ({ model: row.id, label: row.label, behavesAs: CLI_MODEL_PROFILE })) },
        autoCompactEnabled: true,
        precomputeCompactionEnabled: false,
        idleCompaction: false,
      },
      mcpServers: { devices: this.hub.mcpServer(), ...this.connectors.mcpServers() },
      includePartialMessages: !isolated,
      agentProgressSummaries: true,
      perTaskStopAffordance: !isolated, // The App's per-task stop controls target the open main query.
      spawnClaudeCodeProcess: (o) => {
        // Log only these numeric policy values, never the subprocess's full environment.
        this.log(`[sdk env] max_output=${o.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS} compact_window=${o.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW} compact_pct=${o.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE}`);
        return spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ["pipe", "pipe", "pipe"] });
      },
      env: {
        ...inheritedEnv,
        CLAUDE_CONFIG_DIR: config.sessions,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        ...modelEnvironment(m),
        CLAUDE_CODE_FORK_SUBAGENT: "1",
        // SDK_READS_SESSION_STATE alone marks frames sdk_host_only; sdk.mjs consumes those internally.
        // Explicit emission makes the native lifecycle visible to this harness as SDKMessage frames.
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
        // CLI defaults to treating background agents as session "running" even between main turns.
        // We expose their separate activity list, so idle must describe the main thread alone.
        CLAUDE_CODE_BG_TASKS_REPORT_RUNNING: "0",
        // Last in the env overlay: inherited values cannot disable the 200K policy.
        ...context.env,
      },
      hooks: {
        UserPromptSubmit: [{ hooks: [async (input) => this.promptContext({ isolated, agentId: input?.agent_id })] }],
        PreCompact: [{ hooks: [compaction.before] }],
        PostCompact: [{ hooks: [compaction.restore] }],
        SubagentStop: [{ hooks: [compaction.restore] }],
        PreToolUse: [
          { matcher: CONNECTOR_GUARD_TOOLS, hooks: [async (input) => checkConnectorAccess(input)] },
          { matcher: WRITE_TOOLS, hooks: [async (input) => this.checkWrite(input)] },
          ...(!isolated ? [{ hooks: [async (input) => this.checkScheduleFork(input), async (input) => this.checkTaskContinuation(input)] }] : []),
        ],
        PostToolUse: [{ matcher: WRITE_TOOLS, hooks: [async (input) => {
          const r = rel(input.tool_input?.file_path || input.tool_input?.notebook_path);
          const error = isBriefPath(r) && readBrief(config.root, r).error;
          onWrite(r, input, !error);
          return error ? { decision: "block", reason: `简报校验失败：${error}。请用 Write / Edit 修正。`,
            hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `简报校验失败：${error}。请修正后再完成任务。` } } : {};
        }] }],
      },
      stderr: (d) => {
        const s = String(d).trim();
        if (s && !s.includes("unrecognized_model")) this.log("[cc]", this.connectors.redact(s).slice(0, 500));
      },
    };
  }

  promptContext({ isolated = false, agentId } = {}) {
    const devs = this.hub.online();
    const devText = devs.length ? devs.map((d) => `${d.name}（${d.id}）`).join("、") : "无";
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `当前时间：${nowIn(config.timezone)}（${config.timezone}）\n在线设备：${devText}` +
          (!isolated && !agentId && this.main?.reason === "schedule" ? "\n这份定时任务请放到后台做，完成后通知用户。" : "") +
          (!isolated && !agentId && this.main?.active?.taskContinuation ? `\n用户在继续任务 ${this.main.active.taskContinuation.id}。请只用 SendMessage，to 为这个任务 id，message 原样使用用户这条消息；任务继续在后台做，简短确认即可。` : ""),
      },
    };
  }

  checkWrite(input) {
    const r = rel(input.tool_input?.file_path || input.tool_input?.notebook_path);
    const err = /^data\/briefs\/.+\.json$/.test(r) ? "简报只接受 HTML，请写到 data/briefs/<日期>/<任务名>.html" : memoryPathError(r);
    if (!err) return {};
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: err },
    };
  }

  checkScheduleFork(input) {
    const main = this.main, guard = main?.scheduleFork;
    if (input.agent_id || !main?.turnOpen || main.reason !== "schedule" || !guard || guard.dispatched) return {};
    // The CLI strips run_in_background from its parsed Agent schema with the fork gate on.
    // Match its normalized hook input to the original assistant tool_use by id, never infer intent.
    const background = isTrue(input.tool_input?.run_in_background) ||
      (input.tool_input?.run_in_background === undefined && guard.requestedForks.has(input.tool_use_id));
    if (input.tool_name === "Agent" && input.tool_input?.subagent_type === "fork" && background) {
      guard.dispatched = true; // Once this call passes the guard, the rest of the main turn is unrestricted.
      guard.toolUseId = input.tool_use_id;
      return {};
    }
    if (guard.failOpen) return {};
    guard.denials++;
    this.log(`[schedule] fork guard denied count=${guard.denials} tool=${this.connectors.redact(input.tool_name)}`);
    if (guard.denials === 3) {
      guard.failOpen = true; // The third call is still denied; subsequent calls use the normal path.
      this.log("[schedule] fork guard fail-open");
    }
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: SCHEDULE_FORK_REASON } };
  }

  checkTaskContinuation(input) {
    const continuation = this.main?.active?.taskContinuation;
    if (!continuation || input.agent_id || continuation.dispatched) return {};
    const i = input.tool_input || {};
    if (input.tool_name === "SendMessage" && i.to === continuation.id && i.message === continuation.text) {
      continuation.dispatched = true;
      return {};
    }
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: `请用 SendMessage 给任务 ${continuation.id} 发送用户原文，不新建任务，也不在主会话执行。` } };
  }

  // Shared side effects of any write the agent makes.
  noteWrite(r, job, valid = true) {
    if (!r) return;
    if (r.startsWith("data/memory/")) this.bus.emit({ t: "memory_updated", path: r });
    if (r.startsWith("data/")) this.bus.emit({ t: "files_changed", path: r });
    if (job && isOutputPath(r)) valid ? job.outputs.add(r) : job.outputs.delete(r);
  }

  backgroundTasks() { return this.main?.tasks.list() || []; }

  noteMainWrite(r, input, valid = true) {
    this.noteWrite(r);
    if (input?.agent_id && isOutputPath(r)) {
      const outputs = this.main?.tasks.record({ task_id: input.agent_id })?.outputs;
      if (outputs) valid ? outputs.add(r) : outputs.delete(r);
    }
  }

  taskCard(task, notification) {
    const outputs = this.validOutputs(task.outputs);
    const briefFields = this.briefCardFields(outputs);
    const entry = { role: "card", id: task.id, label: task.description, title: (briefFields.name || task.description) + (notification.status === "completed" ? "" : "（未完成）"),
      outputs, ...briefFields, ok: notification.status === "completed", ts: Date.now(), taskId: task.id };
    appendJsonl(path.join(config.system, "jobs.jsonl"), { ...entry, ms: Date.now() - task.startedAt });
    this.history.put(task.id, { outputs, ...this.briefCardFields(outputs) });
    if (outputs.length) appendJsonl(config.chatLog, entry);
    this.bus.emit({ t: "job", phase: "done", ...entry }); // Same card/files protocol as isolated briefs.
  }

  reloadSoon() {
    // SDK setMcpServers() keeps an already-registered same-name SDK instance.
    // Reconstruct the query BEFORE dispatching the next turn instead of replacing it in a running tool call.
    this.reloadRevision++;
  }

  validOutputs(outputs) { return [...outputs].filter((r) => isOutputPath(r) && (!isBriefPath(r) || !readBrief(config.root, r).error)); }

  briefCardFields(outputs) {
    const briefPath = outputs.find(isBriefPath);
    if (!briefPath) return {};
    const { brief } = readBrief(config.root, briefPath);
    return { path: briefPath, name: brief.name, time: brief.time };
  }

  // ---------- main thread ----------

  startMain() {
    clearTimeout(this.restartTimer);
    const state = readJson(config.stateFile, {});
    const inbox = new Inbox();
    let q;
    const compaction = this.compactionControl(() => q);
    const opts = this.options({ isolated: false, onWrite: (r, input, valid) => this.noteMainWrite(r, input, valid), compaction });
    if (state.mainSessionId) opts.resume = state.mainSessionId;
    q = this.queryFactory({ prompt: inbox, options: opts });
    const tasks = new BackgroundTasks({ bus: this.bus, log: this.log, redact: (s) => this.connectors.redact(s),
      onComplete: (task, m) => this.taskCard(task, m) });
    tasks.reset(); // Process-local activity: never restore a stale running list from disk.
    const main = { q, inbox, compaction, tasks, reply: "", settings: { model: opts.model, permissionMode: opts.permissionMode }, sessionId: state.mainSessionId,
      recoveryContext: state.mainRecovery?.context,
      reloadRevision: this.reloadRevision, connectorRevision: this.connectors.revision };
    this.main = main;
    this.busy = false;
    main.finished = (async () => {
      try {
        for await (const m of q) this.onMainMessage(m, main);
        if (!main.intentionalClose && main.turnOpen) {
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
      for (const task of main.tasks.list()) {
        if (this.history.records.has(task.id)) this.history.put(task.id,{status:"stopped",endedAt:Date.now()});
      }
      main.tasks.reset();
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
    if (!this.turnQueue.length && !this.main?.needsFresh && !this.settingsPending) return;
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
    let main = this.main;
    main = await this.applySettings(main);
    if (!this.turnQueue.length) return;
    await main.compaction.restore();
    // A native task-result turn can start while the control request above is awaiting acknowledgement.
    if (this.busy || this.main !== main || main.ended || !this.turnQueue.length) return;
    const active = this.turnQueue.shift();
    if (active.entry && !active.persisted) {
      appendJsonl(config.chatLog, active.entry);
      active.persisted = true;
    }
    this.beginMainTurn(main, active, active.source === "schedule" ? "schedule" : active.taskContinuation ? "task_continuation" : "user");
    main.inbox.push(withRecovery(active.input, main.recoveryContext));
  }

  beginMainTurn(main, active = null, reason = "task_result") {
    main.active = active; // Native turns have no user envelope and can never be auto-replayed.
    main.reason = reason;
    main.scheduleFork = { dispatched: false, denials: 0, failOpen: false, logged: false, requestedForks: new Set() };
    main.toolsUsed = false;
    main.failure = null;
    main.reply = "";
    main.compacting = false;
    main.turnOpen = true;
    this.busy = true;
    this.bus.emit({ t: "status", busy: true, reason });
  }

  releaseMainTurn() {
    this.busy = false;
    this.bus.emit({ t: "status", busy: false });
    this.scheduleDispatch().catch((e) => this.log("dispatch failed:", this.connectors.redact(e.message)));
  }

  scheduleDispatch() {
    this.dispatchChain = this.dispatchChain.then(() => this.dispatchNextTurn(), () => this.dispatchNextTurn());
    return this.dispatchChain;
  }

  settingsChanged() {
    this.settingsPending = true;
    this.scheduleDispatch().catch((e) => this.log("settings failed:", this.connectors.redact(e.message)));
  }

  async applySettings(main) {
    const selected = readAppSettings(config.root);
    if (main.settings.model === selected.model && main.settings.permissionMode === selected.permissionMode) { this.settingsPending = false; return main; }
    let rebuild = main.settings.model !== selected.model;
    try {
      if (rebuild) await main.q.setModel(selected.model);
      if (main.settings.permissionMode !== selected.permissionMode) await main.q.setPermissionMode(selected.permissionMode);
    } catch (e) {
      rebuild = true;
      this.log("settings control requires resume:", this.connectors.redact(e.message));
    }
    if (this.busy || this.main !== main) { this.settingsPending = true; return main; }
    if (rebuild) {
      // 0.3.295 updateSettings refuses env. Refresh classifier/default-subagent models in a new CLI.
      // Resume, never create a fresh conversation; native SendMessage restores each active agent by id.
      const active = main.tasks.list().filter((task) => this.history.records.get(task.id)?.kind === "subagent");
      main.intentionalClose = true; main.inbox.close(); main.q.close(); await main.finished;
      this.startMain();
      main = this.main;
      for (const task of active.reverse()) {
        if (this.turnQueue.some((turn) => turn.taskContinuation?.id === task.id)) continue;
        const text = "继续原任务，从已经完成的步骤接着做。";
        this.turnQueue.unshift({ source: "task", taskContinuation: { id: task.id, text },
          input: { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } });
      }
    }
    main.settings = selected;
    this.settingsPending = false;
    return main;
  }

  taskHistory(id) { return this.history.history(id); }

  async sendTask(id, text) {
    const task = this.history.get(id);
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text,"utf8") > 32*1024) throw new TaskError("续聊消息不能为空且不能超过 32KB",400,"invalid_task_text");
    text = text.trim();
    if (task.kind === "isolated") {
      this.history.rememberPrompt(id,text);
      this.runIsolated(task.title, text, { id, resumeTask: id }).catch((e) => this.log("task continuation failed:", this.connectors.redact(e.message)));
      return id;
    }
    if (!this.main || this.main.ended || task.sessionId !== this.main.sessionId) throw new TaskError("原任务会话暂不可用，请恢复原主会话后再试",503,"session_unavailable");
    this.history.rememberPrompt(id,text);
    this.turnQueue.push({ source: "task", taskContinuation: { id, text },
      input: { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } });
    await this.scheduleDispatch();
    return id;
  }

  runningJobs() { return [...this.running].map(([id,job]) => ({ id, ...job })); }
  recentJobs() { return this.history.recent(); }

  onMainMessage(m, main = this.main) {
    if (this.main !== main || main.intentionalClose) return;
    if (m.type === "system" && m.subtype === "session_state_changed") {
      main.hasSessionStateSignal = true;
      main.sdkState = m.state;
      if (m.state === "running") {
        if (!main.turnOpen) this.beginMainTurn(main);
      } else if (m.state === "requires_action") {
        // Waiting for an action is busy, but it can belong to a background task between main turns.
        // Do not invent an open reply/result in that case; a subsequent idle must be able to release it.
        if (!this.busy) this.bus.emit({ t: "status", busy: true });
        this.busy = true;
      } else if (m.state === "idle") {
        // result can precede native follow-up turns. Only idle certifies the CLI's entire turn is over.
        // If a model-less command emits idle before result, persist that result before dispatching too.
        if (!main.turnOpen) this.releaseMainTurn();
      }
      return;
    }
    if (m.type === "system" && m.subtype === "init") {
      // Init is also native, per-turn metadata. Covers another result inside a still-running bg do-while.
      if (main.hasSessionStateSignal && main.sdkState !== "idle" && !main.turnOpen) this.beginMainTurn(main);
      const state = readJson(config.stateFile, {});
      main.sessionId = m.session_id;
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
    if (m.type === "system" && m.subtype === "task_started" && m.subagent_type === "fork" && !m.parent_task_id) {
      const guard = main.scheduleFork;
      if (main.reason === "schedule" && guard?.dispatched && !guard.logged && (!guard.toolUseId || guard.toolUseId === m.tool_use_id)) {
        guard.logged = true;
        this.log(`[schedule] fork dispatched task_id=${m.task_id} tool_use_id=${m.tool_use_id || guard.toolUseId || "unknown"}`);
      }
    }
    if (m.type === "system") this.history.handle(m, main.sessionId);
    if (m.type === "system" && main.tasks.handle(m)) return;
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
          if (main.reason === "schedule" && b.name === "Agent" && b.input?.subagent_type === "fork" && isTrue(b.input?.run_in_background)) {
            main.scheduleFork.requestedForks.add(b.id);
          }
          main.toolsUsed = true;
          this.bus.emit({ t: "tool", name: b.name, hint: this.connectors.redact(toolHint(b)) });
        }
      }
      return;
    }
    if (m.type === "result") {
      if (main.active?.taskContinuation && !main.active.taskContinuation.dispatched) this.recordFailure(main, "任务续聊未送达，请重新发送");
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
    main.turnOpen = false;
    if (text) appendJsonl(config.chatLog, { role: "assistant", text, ts: Date.now(), ...(error && { error: true }) });
    this.bus.emit({ t: "turn_end", text, error });
    // Older/fake queries without state events retain the result fallback; 0.3.295 waits for native idle.
    if (!main.hasSessionStateSignal || main.sdkState === "idle") this.releaseMainTurn();
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
    const id = crypto.randomUUID();
    const entry = { role: "user", id, text, ts: Date.now(), source };
    if (atts.length) entry.attachments = atts;
    this.turnQueue.push({ id, entry, source, input: { type: "user", message: { role: "user", content: userContent(text, atts) }, parent_tool_use_id: null } });
    this.bus.emit({ t: "user", id, text, source, ts: entry.ts, attachments: atts });
    await this.scheduleDispatch();
    return id;
  }

  queuedMessages() {
    return this.turnQueue.filter((turn) => turn.entry && !turn.persisted).map(({ entry }) => ({
      id: entry.id, text: entry.text, source: entry.source, ts: entry.ts, attachments: entry.attachments || [],
    }));
  }

  updateQueued(id, text) {
    const index = this.turnQueue.findIndex((turn) => turn.id === id && !turn.persisted && turn.source !== "schedule");
    let event;
    if (index < 0) event = { t: "queue_update", id, state: "too_late" };
    else if (text === undefined) {
      this.turnQueue.splice(index, 1);
      event = { t: "queue_update", id, state: "removed" };
    } else {
      const turn = this.turnQueue[index];
      if (typeof text !== "string" || (!text.trim() && !turn.entry.attachments?.length)) throw new Error("排队消息不能为空");
      turn.entry.text = text.trim();
      turn.input.message.content = userContent(turn.entry.text, turn.entry.attachments || []);
      event = { t: "queue_update", id, state: "edited", text: turn.entry.text };
    }
    // All connected Apps observe the same queue; too_late is returned only to the requester.
    if (event.state !== "too_late") this.bus.emit(event);
    return event;
  }

  async interrupt() {
    try {
      await this.main?.q?.interrupt();
    } catch (e) {
      this.log("interrupt failed:", this.connectors.redact(e.message));
    }
  }

  async stopTask(id) {
    const main = this.main;
    if (!main || main.ended) throw new TaskError("主会话暂时不可用，请稍后再试", 503, "session_unavailable");
    const task = main.tasks.running(id);
    task.stopping = true;
    try { await main.q.stopTask(id); }
    catch (e) {
      task.stopping = false;
      this.log("stop task failed:", this.connectors.redact(e.message));
      if (task.ended || !main.tasks.live.has(id)) throw new TaskError("任务已经结束", 409, "task_ended");
      throw new TaskError("停止任务失败，请稍后再试", 502, "task_stop_failed");
    }
  }

  compactMain() {
    if (this.busy) return false;
    this.turnQueue.push({ manualCompact: true, input: { type: "user", message: { role: "user", content: "/compact" }, parent_tool_use_id: null } });
    this.scheduleDispatch().catch((e) => this.log("compact failed:", this.connectors.redact(e.message)));
    return true;
  }

  // ---------- isolated sessions (cron, catch-up, night tidy) ----------

  runIsolated(label, prompt, { id = crypto.randomUUID(), resumeTask } = {}) {
    this.history.put(id, { kind: "isolated", title: label, status: "running" });
    this.running.set(id, { label, started: Date.now() });
    const run = async () => {
      const job = { label, outputs: new Set(), text: "" };
      const started = Date.now();
      this.running.set(id, { label, started });
      this.history.put(id, { status: "running", startedAt: started });
      this.bus.emit({ t: "job", phase: "started", id, label });
      this.log(`job start: ${label}`);
      let q;
      const inbox = new Inbox();
      const compaction = this.compactionControl(() => q);
      try {
        // Streaming input permits live effort control in PreCompact, just as in the main session.
        const resume = resumeTask && this.history.get(resumeTask).sessionId;
        if (resumeTask && !resume) throw new Error("任务原会话记录暂不可用，无法续聊");
        q = this.queryFactory({ prompt: inbox, options: { ...this.options({ isolated: true, onWrite: (r, _input, valid) => this.noteWrite(r, job, valid), compaction }), ...(resume && { resume }) } });
        inbox.push({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null });
        for await (const m of q) {
          if (m.type === "system" && m.subtype === "init") this.history.put(id, { sessionId: m.session_id });
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
      const outputs = this.validOutputs(job.outputs);
      const briefFields = this.briefCardFields(outputs);
      const entry = { role: "card", id, label, title: (briefFields.name || label) + (job.ok ? "" : "（未完成）"), outputs, ...briefFields, ok: !!job.ok, ts: Date.now() };
      this.history.put(id, { status: job.ok ? "done" : "error", endedAt: entry.ts, outputs, ...this.briefCardFields(outputs) });
      appendJsonl(path.join(config.system, "jobs.jsonl"), { ...entry, ms: Date.now() - started });
      if (outputs.length) appendJsonl(config.chatLog, entry);
      this.bus.emit({ t: "job", phase: "done", ...entry });
      this.running.delete(id);
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
