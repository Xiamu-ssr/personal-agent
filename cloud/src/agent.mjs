// One open main thread for chat/interjections, plus native forks and isolated background work.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config, MEMORY_CATEGORIES } from "./config.mjs";
import { readJson, appendJsonl, tailJsonl, nowIn } from "./store.mjs";
import { ConnectorManager, writePrivateJson } from "./connectors.mjs";
import { checkConnectorAccess, CONNECTOR_GUARD_TOOLS } from "./connector-guard.mjs";
import { inputUsage, contextPolicy, CLI_MODEL_OVERRIDES } from "./context-policy.mjs";
import { readAppSettings, MODELS, modelEnvironment, selectedModel, providerEnvironment } from "./app-settings.mjs";
import { readProviders } from "./providers.mjs";
import { TaskHistory, listedActivity } from "./task-history.mjs";
import { contextFailure, humanError, recoveryContext, withRecovery, RECOVERY_NOTICE } from "./conversation-recovery.mjs";
import { BackgroundTasks, TaskError } from "./background-tasks.mjs";
import { localFile } from "./local-paths.mjs";
import { Speech } from "./say.mjs";
import { Avatar } from "./avatar.mjs";
import { validateMessage, prepareAttachments, userContent } from "./attachments.mjs";
import { checkDataAccess } from "./data-guard.mjs";
import { calendarContext } from "./calendar-context.mjs";
import { PageScreenshot } from "./page-screenshot.mjs";
import { CloudBrowser, createBrowserMcpServer } from "./browser/index.mjs";
import { estimateUsageCost } from "./usage-pricing.mjs";
import { triggerTitle } from "./activity-title.mjs";
import { TurnSpeech } from "./turn-speech.mjs";
import { activitySummary } from "./activity-summary.mjs";
import { frontmatter } from "./content.mjs";

const WRITE_TOOLS = "Write|Edit|MultiEdit|NotebookEdit";
const isOutputPath = (r) => /^data\/(?:feed|ideas|goals|library)\//.test(r);
function isFeedPost(r) {
  if (!/^data\/feed\/\d{4}-\d{2}-\d{2}\/\d{4}-[^/]+\.md$/.test(r)) return false;
  try { return !!frontmatter(fs.readFileSync(localFile(config.root, r, "data/feed"), "utf8")).meta.title; } catch { return false; }
}
function feedPosts() {
  const dir = path.join(config.data, "feed"), result = new Set();
  if (!fs.existsSync(dir)) return result;
  for (const date of fs.readdirSync(dir, { withFileTypes: true })) if (date.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(date.name)) {
    for (const file of fs.readdirSync(path.join(dir, date.name), { withFileTypes: true })) {
      const rel = `data/feed/${date.name}/${file.name}`;
      if (file.isFile() && isFeedPost(rel)) result.add(rel);
    }
  }
  return result;
}

// An async iterable the SDK reads user messages from (streaming input mode).
class Inbox {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(item) {
    if (this.closed) throw new Error("会话输入已经关闭");
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
  const body = [config.basePromptFile, config.promptFile].map((file) => {
    const raw = fs.readFileSync(file, "utf8"), divider = /^---\s*$/m.exec(raw);
    if (!divider) throw new Error(`提示词缺少分隔线：${path.basename(file)}`);
    return raw.slice(divider.index + divider[0].length).trim();
  }).join("\n\n");
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
  constructor({ hub, bus, log, connectors = new ConnectorManager(), queryFactory = query, summarize = activitySummary, browser = new CloudBrowser({ root: config.root }) }) {
    this.hub = hub;
    this.bus = bus;
    this.log = (...args) => log(...args.map((value) => connectors.redact(value)));
    this.connectors = connectors;
    this.browser = browser;
    for (const p of readProviders(config.root)) connectors.knownSecrets?.add(p.apiKey);
    for (const [key, value] of Object.entries(process.env)) {
      if (/(?:TOKEN|KEY|SECRET|PASSWORD)$/i.test(key) && value?.length >= 8) connectors.knownSecrets?.add(value);
    }
    this.queryFactory = queryFactory;
    this.summarize = summarize;
    this.summaryJobs = new Set();
    this.summaryAbort = new AbortController();
    this.mainRuns = [];
    this.closed = false;
    this.main = null;
    this.retired = new Set();
    this.inputChain = Promise.resolve();
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
    this.isolated = new Map();
    this.sideInputs = new Map();
    this.sideRuns = new Map();
    this.sideInputChains = new Map();
    this.cancelled = new Set();
    this.history = new TaskHistory({ root: config.root, sessions: config.sessions, redact: (s) => connectors.redact(s) });
    this.pages = new PageScreenshot({root:config.root});
    this.speech = new Speech({ root: config.root, bus, redact: (s) => connectors.redact(s), onSay: (entry) => {
      if (!entry.error) {
        const turn = this.main?.activityId === entry.activityId ? this.main : this.isolated.get(entry.activityId)?.job;
        turn?.turnSpeech?.say(entry.text);
      }
      if (entry.activityId && this.history.records.has(entry.activityId)) {
        if (this.history.get(entry.activityId).kind === "subagent") this.bus.emit({ t: "activity_step", id: entry.activityId, item: { kind: "text", text: entry.text, time: new Date(entry.ts).toISOString() } });
        else this.step(entry.activityId, "text", entry.text, undefined, { speech: !entry.error });
      }
    } });
    this.avatar = new Avatar({ bus, busy: () => this.busy || this.running.size > 0 || this.backgroundTasks().length > 0, waiting: () => this.speech.waiting(), waitingForUser: () => this.browser.owner === "user" });
    if (this.speech.waiting()) this.avatar.value = { state: "waiting" };
    this.onBrowserState = (state) => {
      if (state.control !== "user") return;
      this.browserSession ||= { main: this.main, activityId: this.main?.activityId };
      const isolated = this.isolated.get(this.browserSession.activityId);
      if (isolated) isolated.job.awaitingBrowser = true;
      this.avatar.working();
    };
    this.onBrowserReturned = () => this.browserReturned().catch((e) => this.log("browser return failed:", this.connectors.redact(e.message)));
    browser.on("state", this.onBrowserState);
    browser.on("returned", this.onBrowserReturned);
  }

  compactionControl(getQuery = () => undefined, basic = !selectedModel(config.root).builtin) {
    const owners = new Set();
    const control = {
      active: false,
      before: async (input) => {
        if (basic) return {};
        owners.add(input?.agent_id || "main");
        control.active = true;
        const q = getQuery();
        if (!q?.applyFlagSettings) throw new Error("SDK 缺少压缩 effort 控制接口，请使用锁定的 SDK 版本");
        // The CLI's compactor inherits thinking/effort. Change its live flag cap BEFORE its request.
        // Haiku 5.5 and Opus 5.5 reject disabled thinking; keep adaptive thinking at low effort.
        await q.applyFlagSettings({ effortLevel: config.compactEffort, maxEffortLevel: config.compactEffort });
        return {};
      },
      restore: async (input) => {
        if (basic) return {};
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

  options({ isolated, onWrite, feed = false, chatType, speechContext = () => ({ activityId: this.main?.activityId }), compaction = this.compactionControl() }) {
    const selected = readAppSettings(config.root), runtime = selectedModel(config.root), m = runtime.id, context = contextPolicy(m, { custom: !runtime.builtin });
    if (!runtime.builtin) this.connectors.knownSecrets.add(runtime.providerRecord.apiKey);
    const speechCalls = new Map();
    const browserCalls = new Map();
    const inheritedEnv = { ...process.env };
    for (const key of ["AGENT_MODEL", "AGENT_PERMISSION_MODE", "AGENT_EFFORT", "AGENT_MODEL_CANONICAL", "AGENT_MAX_OUTPUT_TOKENS", "AGENT_CONTEXT_INPUT_LIMIT", "AGENT_CONTEXT_HEADROOM", "CLAUDE_CODE_CURRIED_TRINKET"]) delete inheritedEnv[key];
    return {
      model: m,
      cwd: config.root,
      systemPrompt: systemPrompt(),
      permissionMode: selected.permissionMode,
      // The user grants device capabilities on the device itself; asking the classifier again only adds cost and false refusals.
      allowedTools: [
        "mcp__devices__list_devices", "mcp__devices__call_device", "mcp__devices__read_since", "mcp__devices__sync_commit",
        "mcp__connectors__list", "mcp__connectors__add_account", "mcp__connectors__update_account", "mcp__connectors__remove_account",
        "mcp__page__screenshot", "mcp__doudou__say", "mcp__browser__*",
        ...[...this.connectors.definitions.keys()].map((name) => "mcp__" + name + "__*"),
      ],
      thinking: { type: runtime.builtin ? "adaptive" : "disabled" },
      ...(runtime.builtin && { effort: config.effort }),
      allowDangerouslySkipPermissions: true,
      settingSources: ["project"],
      settings: {
        availableModels: runtime.providerRecord.models.map((row) => row.id),
        ...(runtime.builtin && { modelOverrides: { ...CLI_MODEL_OVERRIDES } }),
        modelPicker: { replaceBuiltInOptions: true, options: runtime.builtin ? MODELS.map((row) => ({ model: row.id, label: row.label, behavesAs: contextPolicy(row.id).canonical })) : runtime.providerRecord.models.map((row) => ({ model: row.id, label: row.name })) },
        autoCompactEnabled: true,
        precomputeCompactionEnabled: false,
        idleCompaction: false,
      },
      mcpServers: { doudou: this.speech.mcpServer((extra) => {
        const id = extra?._meta?.["claudecode/toolUseId"], owner = speechCalls.get(id);
        speechCalls.delete(id);
        const context = owner || speechContext(extra);
        return { ...context, silent: !!context.silent || !!owner?.agentId || isolated && chatType !== "side" };
      }), browser: createBrowserMcpServer({ browser: this.browser, feed, onCall: (_name, _args, extra) => {
        const id = extra?._meta?.["claudecode/toolUseId"], owner = browserCalls.get(id) || speechContext();
        browserCalls.delete(id);
        if (this.browser.owner !== "user") this.browserSession = { ...owner, main: isolated ? null : this.main, isolated };
      } }), devices: this.hub.mcpServer(), page:this.pages.mcpServer(), ...this.connectors.mcpServers() },
      includePartialMessages: !isolated,
      agentProgressSummaries: true,
      perTaskStopAffordance: !isolated, // The App's per-task stop controls target the open main query.
      spawnClaudeCodeProcess: (o) => {
        // Log only these numeric policy values, never the subprocess's full environment.
        this.log(`[sdk env] max_output=${o.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS} compact_window=${o.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW} compact_pct=${o.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE}`);
        const env = providerEnvironment(runtime, o.env);
        return spawn(o.command, o.args, { cwd: o.cwd, env, signal: o.signal, stdio: ["pipe", "pipe", "pipe"] });
      },
      env: {
        ...providerEnvironment(runtime, inheritedEnv),
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
        // Last in the env overlay: inherited values cannot disable the selected input trigger.
        ...context.env,
      },
      hooks: {
        UserPromptSubmit: [{ hooks: [async (input) => this.promptContext({ isolated, agentId: input?.agent_id })] }],
        PreCompact: [{ hooks: [compaction.before] }],
        PostCompact: [{ hooks: [compaction.restore] }],
        SubagentStop: [{ hooks: [compaction.restore] }],
        ...(!isolated || chatType === "side" ? { Stop: [{ hooks: [async (input) => {
          if (input.agent_id) return {};
          const id = speechContext().activityId, turn = isolated ? this.isolated.get(id)?.job : this.main;
          const decision = turn?.turnSpeech?.stop(input) || {};
          if (decision.decision === "block") this.step(id, "text", decision.reason, "Stop");
          return decision;
        }] }] } : {}),
        PreToolUse: [
          { matcher: CONNECTOR_GUARD_TOOLS, hooks: [async (input) => checkConnectorAccess(input)] },
          { matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash", hooks: [async (input)=>checkDataAccess(input,{feed})] },
          { matcher: WRITE_TOOLS, hooks: [async (input) => this.checkWrite(input)] },
          ...(!isolated ? [{ hooks: [async (input) => this.checkTaskContinuation(input)] }] : []),
          { hooks: [async (input) => {
            this.avatar.working(input.tool_name, input.tool_input);
            const context = speechContext();
            const owner = { ...context, ...(input.agent_id && { agentId: input.agent_id }), activityId: context.chatType === "side" ? context.activityId : input.agent_id || context.activityId };
            if (input.tool_name === "mcp__doudou__say") speechCalls.set(input.tool_use_id, owner);
            if (input.tool_name?.startsWith("mcp__browser__")) {
              browserCalls.set(input.tool_use_id, { ...owner, agentId: input.agent_id });
              if (browserCalls.size > 128) browserCalls.delete(browserCalls.keys().next().value);
            }
            return {};
          }] },

        ],
        PostToolUse: [{ matcher: WRITE_TOOLS, hooks: [async (input) => {
          const r = rel(input.tool_input?.file_path || input.tool_input?.notebook_path);
          onWrite(r, input, true);
          return {};
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
        additionalContext: `当前时间：${nowIn(config.timezone)}（${config.timezone}） · ${calendarContext({timezone:config.timezone})}\n在线设备：${devText}` +
          (!isolated && !agentId && this.main?.continuations?.length ? "\n请用 SendMessage 把用户交代原样发给指定活动，继续在后台执行：" + this.main.continuations.map((c) => JSON.stringify({ to: c.id, message: c.text })).join("\n") : ""),
      },
    };
  }

  checkWrite(input) {
    const r = rel(input.tool_input?.file_path || input.tool_input?.notebook_path);
    const err = memoryPathError(r);
    if (!err) return {};
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: err },
    };
  }

  step(id, kind, text, tool, extra = {}) {
    const record = this.history.records.get(id);
    if (!record) return;
    const listed = listedActivity(record);
    const entry = { kind, text: this.history.safe(text), time: new Date().toISOString(), ...(tool && { tool }), ...(kind === "prompt" && { from: record.kind === "chat" || record.steps?.some((s) => s.kind === "prompt") ? "user" : "agent" }), ...extra };
    const updated = this.history.put(id, { steps: [...(record.steps || []), entry] });
    this.bus.emit({ t: "activity_step", id, item: entry });
    if (!listed && listedActivity(updated)) this.bus.emit({ t: "activity", phase: "started", id, title: updated.title, summary: updated.summary, ts: Date.now() });
  }

  summarizeActivity(id) {
    const record = this.history.get(id);
    if (!listedActivity(record) || record.chatType === "side" && !record.autoTitle || this.closed) return;
    const revision = record.endedAt;
    const task = Promise.resolve().then(() => this.summarize(record, { signal: this.summaryAbort.signal })).then((summary) => {
      const current = this.history.get(id);
      if (!summary || this.closed || current.status === "running" || current.endedAt !== revision) return;
      const updated = this.history.put(id, summary);
      this.bus.emit({ t: "activity", phase: "updated", id, title: updated.title, summary: updated.summary });
    }).catch((e) => { if (!this.closed) this.log("activity summary failed:", this.connectors.redact(e.message)); })
      .finally(() => this.summaryJobs.delete(task));
    this.summaryJobs.add(task);
  }

  checkTaskContinuation(input) {
    const pending = this.main?.continuations;
    if (input.agent_id || !pending?.length) return {};
    const index = pending.findIndex((c) => input.tool_name === "SendMessage" && input.tool_input?.to === c.id && input.tool_input?.message === c.text);
    if (index >= 0) { pending.splice(index, 1); return {}; }
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `请先用 SendMessage 把用户原文交给活动 ${pending[0].id}，message 为：${pending[0].text}` } };
  }

  // Shared side effects of any write the agent makes.
  noteWrite(r, job, valid = true) {
    if (!r) return;
    if (r.startsWith("data/memory/")) this.bus.emit({ t: "memory_updated", path: r });
    if (r.startsWith("data/")) this.bus.emit({ t: "files_changed", path: r });
    if (job && isOutputPath(r)) valid ? job.outputs.add(r) : job.outputs.delete(r);
    if (job?.feedBefore && valid && isFeedPost(r) && !job.feedBefore.has(r) && fs.existsSync(path.join(config.root, r))) this.publishFeedActivity(job.id);
  }

  publishFeedActivity(id) {
    const record = this.history.get(id);
    if (record.feedPublished) return;
    const updated = this.history.put(id, { feedPublished: true });
    this.bus.emit({ t: "activity", phase: "started", id, title: updated.title, summary: updated.summary, ts: Date.now() });
  }

  backgroundTasks() { return [this.main, ...this.retired].flatMap((main) => main?.tasks.list() || []); }

  noteMainWrite(r, input, valid = true) {
    this.noteWrite(r);
    if (input?.agent_id && isOutputPath(r)) {
      const owner = [this.main, ...this.retired].find((main) => main?.tasks.records.has(input.agent_id));
      const outputs = owner?.tasks.record({ task_id: input.agent_id })?.outputs;
      if (outputs) valid ? outputs.add(r) : outputs.delete(r);
    }
  }

  taskCard(task, notification) {
    if (this.history.records.get(task.id)?.detached) return;
    const outputs = this.validOutputs(task.outputs);
    this.history.put(task.id, { outputs });
    this.bus.emit({ t: "activity", phase: "done", id: task.id, title: task.description, status: notification.status === "completed" ? "done" : notification.status === "stopped" ? "stopped" : "error", outputs, ts: Date.now() });
    this.summarizeActivity(task.id);
  }

  reloadSoon() {
    // SDK setMcpServers() keeps an already-registered same-name SDK instance.
    // Reconstruct the query BEFORE dispatching the next turn instead of replacing it in a running tool call.
    this.reloadRevision++;
  }

  validOutputs(outputs) {
    return [...outputs].filter((r) => { try { return isOutputPath(r) && !!localFile(config.root, r, "data"); } catch { return false; } });
  }

  // ---------- main thread ----------

  startMain() {
    if (this.closed) return;
    clearTimeout(this.restartTimer);
    const state = readJson(config.stateFile, {});
    const inbox = new Inbox();
    let q, main;
    const compaction = this.compactionControl(() => q);
    const runtime = selectedModel(config.root);
    const opts = this.options({ isolated: false, onWrite: (r, input, valid) => this.noteMainWrite(r, input, valid), compaction, speechContext: () => ({ activityId: main?.activityId, silent: !!main?.retired }) });
    if (state.mainSessionId) opts.resume = state.mainSessionId;
    q = this.queryFactory({ prompt: inbox, options: opts });
    const tasks = new BackgroundTasks({ bus: this.bus, log: this.log, redact: (s) => this.connectors.redact(s),
      onComplete: (task, m) => this.taskCard(task, m) });
    tasks.reset(); // Process-local activity: never restore a stale running list from disk.
    main = { q, inbox, compaction, tasks, reply: "", settings: { model: opts.model, connection: runtime.connection, builtin: runtime.builtin, permissionMode: opts.permissionMode }, sessionId: state.mainSessionId,
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
      this.retired.delete(main);
      if (main.intentionalClose || this.main !== main) return;
      main.ended = true;
      main.inbox.close();
      this.busy = false;
      this.bus.emit({ t: "status", busy: false });
      if (main.needsFresh) { this.scheduleRefresh(); return; }
      this.restartTimer = setTimeout(() => {
        this.startMain();
        this.scheduleRefresh();
      }, 3000);
    })();
  }

  async refreshMain() {
    if (this.closed || this.busy) return;
    if (!this.main) this.startMain();
    let main = this.main;
    const selected = readAppSettings(config.root), runtime = selectedModel(config.root);
    const changedService = main.settings.connection !== runtime.connection;
    const rebuild = main.ended || main.needsFresh || main.reloadRevision !== this.reloadRevision || main.connectorRevision !== this.connectors.revision || main.settings.model !== selected.model.id || changedService;
    if (rebuild) {
      const active = main.tasks.list().filter((task) => this.history.records.get(task.id)?.kind === "subagent");
      if (changedService && active.length && !main.ended && !main.needsFresh) {
        main.retired = true;
        this.retired.add(main);
      } else {
        main.intentionalClose = true;
        main.inbox.close(); main.q.close(); await main.finished;
      }
      if (this.closed) return;
      this.startMain();
      main = this.main;
      if (!changedService) for (const task of active) this.deliverContinuation(main, task.id, "继续原任务，从已经完成的步骤接着做。");
    }
    if (main.settings.permissionMode !== selected.permissionMode) {
      await main.q.setPermissionMode(selected.permissionMode);
      main.settings.permissionMode = selected.permissionMode;
    }
    if (!this.busy) await main.compaction.restore();
    return main;
  }

  scheduleRefresh() {
    this.inputChain = this.inputChain.then(async () => {
      if (this.closed || this.main?.intentionalClose || this.busy) return;
      const replay = this.main?.replay;
      const main = await this.refreshMain();
      if (replay && main) {
        this.beginMainTurn(main, replay, "user");
        main.inbox.push(withRecovery(replay.input, main.recoveryContext));
      }
      if (!this.busy && this.mainRuns.length) {
        const run = this.mainRuns.shift();
        this.beginMainTurn(main, run, "goal_checkin");
        main.inbox.push(withRecovery(run.input, main.recoveryContext));
      }
    }).catch((e) => this.log("session refresh failed:", this.connectors.redact(e.message)));
    return this.inputChain;
  }

  settingsChanged() {
    this.inputChain = this.inputChain.then(async () => {
      const selected = readAppSettings(config.root), runtime = selectedModel(config.root);
      await Promise.all([this.main, ...this.isolated.values()].filter((session) => session && !session.ended).map(async (session) => {
        if (session.settings.connection === runtime.connection && session.settings.model !== selected.model.id) {
          await session.q.applyFlagSettings({ env: modelEnvironment(selected.model.id) });
          await session.q.setModel(selected.model.id);
          session.settings.model = selected.model.id;
        }
        if (session.settings.permissionMode !== selected.permissionMode) {
          await session.q.setPermissionMode(selected.permissionMode);
          session.settings.permissionMode = selected.permissionMode;
        }
      }));
    });
    return this.scheduleRefresh();
  }

  beginMainTurn(main, active = null, reason = "task_result") {
    main.active = active;
    main.reason = reason;
    main.toolsUsed = false; main.failure = null; main.reply = ""; main.turnSpeech = new TurnSpeech();
    main.compacting = false; main.turnOpen = true;
    main.activityId = active?.id || crypto.randomUUID();
    const title = active?.trigger === "goal" ? [...(active.label || triggerTitle(active.promptText) || "跟进目标")].slice(0, 14).join("") : "处理中";
    const record = this.history.put(main.activityId, { kind: "chat", title, summary: "", trigger: active?.trigger, instruction: active?.promptText || active?.entry?.text || title, status: "running", sessionId: main.sessionId, startedAt: Date.now(), steps: [] });
    if (active?.entry || active?.promptText) this.step(main.activityId, "prompt", active.promptText || active.entry.text, undefined, { ...(!active.entry && { from: "agent" }), ...(active.entry?.attachments?.length && { attachments: active.entry.attachments }) });
    if (listedActivity(record)) this.bus.emit({ t: "activity", phase: "started", id: record.id, title, summary: "", ts: Date.now() });
    this.busy = true;
    this.bus.emit({ t: "status", busy: true, reason });
    this.avatar.working();
  }

  releaseMainTurn() {
    this.busy = false;
    this.bus.emit({ t: "status", busy: false });
    this.avatar.settle(!this.main?.failure);
    this.scheduleRefresh();
  }

  runMain(promptText, { id = crypto.randomUUID(), label = triggerTitle(promptText) } = {}) {
    if (this.closed) return Promise.reject(new Error("云端正在关闭，请稍后重试"));
    const input = { type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: promptText }, parent_tool_use_id: null };
    const done = new Promise((resolve) => this.mainRuns.push({ id, input, promptText, label, trigger: "goal", resolve }));
    this.scheduleRefresh();
    return done;
  }

  taskHistory(id) {
    const result = this.history.history(id);
    return this.history.get(id).chatType === "side" ? { ...result, chatType: "side", messages: this.speech.side(id).history(Number.MAX_SAFE_INTEGER) } : result;
  }

  async createSideChat(text = "", attachments = [], title) {
    if (this.closed) throw new TaskError("云端正在关闭，请稍后重试", 503, "session_unavailable");
    const message = validateMessage(config.root, text, attachments);
    if (title !== undefined && (typeof title !== "string" || !title.trim() || title.length > 200)) throw new TaskError("标题要 1–200 个字符", 400, "invalid_title");
    const atts = await prepareAttachments(config.root, message.attachments);
    const id = crypto.randomUUID();
    const label = title?.trim() || triggerTitle(message.text) || [...(message.text || atts[0].name)].slice(0, 40).join("").replace(/\s+/g, " ");
    const task = this.history.put(id, { kind: "isolated", chatType: "side", title: label, autoTitle: !title, instruction: message.text, steps: [] });
    const entry = this.speech.side(id).user(message.text, atts);
    this.startSideRun(task, entry, atts, false);
    return id;
  }

  startSideRun(task, entry, attachments, continuation = true) {
    const p = this.runIsolated(task.title, entry.text, { id: task.id, chatType: "side", messageId: entry.id, attachments,
      ...(continuation && { resumeTask: task.id, continuationContext: true }) });
    this.sideRuns.set(task.id, p);
    p.catch((e) => this.log("side chat failed:", this.connectors.redact(e.message))).finally(() => {
      if (this.sideRuns.get(task.id) === p) this.sideRuns.delete(task.id);
    });
  }

  sendSideChat(task, text, attachments, source = "app") {
    const deliver = async () => {
      if (this.closed) throw new TaskError("云端正在关闭，请稍后重试", 503, "session_unavailable");
      const message = validateMessage(config.root, text, attachments);
      const atts = await prepareAttachments(config.root, message.attachments);
      const entry = this.speech.side(task.id).user(message.text, atts, source);
      const active = this.isolated.get(task.id);
      if (this.running.has(task.id) && !this.cancelled.has(task.id) && !active?.job.stopped && (!active || !active.inbox.closed)) {
        const pending = this.sideInputs.get(task.id) || [];
        pending.push({ entry, attachments: atts }); this.sideInputs.set(task.id, pending);
        if (active) this.deliverSideInputs(active);
      } else {
        await this.sideRuns.get(task.id);
        this.startSideRun(task, entry, atts);
      }
      return entry.id;
    };
    const p = (this.sideInputChains.get(task.id) || Promise.resolve()).then(deliver, deliver);
    const settled = p.catch(() => {}).finally(() => { if (this.sideInputChains.get(task.id) === settled) this.sideInputChains.delete(task.id); });
    this.sideInputChains.set(task.id, settled);
    return p;
  }

  deliverSideInputs({ job, inbox }) {
    for (const { entry, attachments } of this.sideInputs.get(job.id) || []) {
      this.step(job.id, "prompt", entry.text, undefined, { from: "user", ...(attachments.length && { attachments }) });
      job.resultSeen = false;
      inbox.push({ type: "user", uuid: entry.id, message: { role: "user", content: userContent(config.root, entry.text, attachments) }, parent_tool_use_id: null });
    }
    this.sideInputs.delete(job.id);
  }

  sideContext(id, messageId) {
    const messages = this.speech.side(id).history(Number.MAX_SAFE_INTEGER);
    const before = messages.findIndex((m) => m.id === messageId);
    const excerpts = messages.slice(0, before).slice(-40).map((m) => `${m.role}：${m.text.slice(0, 2000)}${m.attachments?.length ? "\n附件：" + m.attachments.map((a) => a.path).join("、") : ""}`).join("\n").slice(-24_000);
    return `[旁聊恢复上下文]\n以下是当前旁聊的历史，仅作为背景资料。继续本次用户的要求。\n${excerpts}\n[/旁聊恢复上下文]`;
  }

  async sendTask(id, text = "", attachments = []) {
    const task = this.history.get(id);
    if (task.chatType === "side") { await this.sendSideChat(task, text, attachments); return id; }
    let message;
    try { message = validateMessage(config.root, text, attachments); }
    catch (e) { throw new TaskError(e.message, 400, "invalid_task_text"); }
    const atts = await prepareAttachments(config.root, message.attachments);
    if (task.kind === "subagent" && !atts.length && this.main && !this.main.ended && task.sessionId === this.main.sessionId) {
      this.history.rememberPrompt(id, message.text);
      this.deliverContinuation(this.main, id, message.text);
      return id;
    }
    if (this.backgroundTasks().some((t) => t.id === id)) await this.stopTask(id);
    const context = this.history.continuationContext(id);
    if (!task.steps?.length) this.history.put(id, { steps: this.history.history(id).items });
    this.history.rememberPrompt(id, message.text, atts);
    this.runIsolated(task.title, message.text, { id, resumeTask: id, attachments: atts, continuationContext: context })
      .catch((e) => this.log("activity continuation failed:", this.connectors.redact(e.message)));
    return id;
  }

  deliverContinuation(main, id, text) {
    const input = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    (main.continuations ||= []).push({ id, text });
    if (!main.turnOpen) this.beginMainTurn(main, { input }, "activity_continuation");
    main.inbox.push(input);
  }

  runningJobs() {
    const jobs=new Map([...this.running].map(([id,job])=>[id,{id,...job}]));
    if (this.main?.turnOpen && this.main.activityId) {
      const record = this.history.get(this.main.activityId);
      jobs.set(record.id, { id: record.id, label: record.title, title: record.title, started: record.startedAt });
    }
    for(const task of this.backgroundTasks())if(!this.history.records.get(task.id)?.detached)jobs.set(task.id,{id:task.id,label:task.description,title:task.description,started:task.startedAt});
    return [...jobs.values()].filter((job) => listedActivity(this.history.records.get(job.id)))
      .map((job) => { const record = this.history.records.get(job.id); return { ...job, title: record?.title || job.title || job.label, summary: record?.summary || "", ...(record?.chatType === "side" && { chatType: "side" }) }; });
  }
  recentJobs() { return this.history.recent(); }

  onMainMessage(m, main = this.main) {
    if (main.retired) {
      if (m.type === "system") {
        const ended = main.tasks.records.get(m.task_id)?.ended;
        this.history.handle(m, main.sessionId); main.tasks.handle(m);
        if (m.subtype === "task_notification" && !ended) this.inputChain = this.inputChain.then(async () => {
          if (this.closed) return;
          const current = this.main, text = `[后台活动汇报] ${m.task_id}：${this.connectors.redact(m.summary || m.status)}`;
          if (!current.turnOpen) this.beginMainTurn(current, { promptText: text }, "task_result");
          else this.step(current.activityId, "prompt", text, undefined, { from: "agent" });
          current.inbox.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
        }).catch((e) => this.log("task report failed:", this.connectors.redact(e.message)));
        if (![...main.tasks.records.values()].some((task) => task.background && !task.ended)) {
          main.intentionalClose = true; main.inbox.close(); main.q.close(); this.retired.delete(main);
        }
      }
      return;
    }
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
      if (main.activityId && this.history.records.has(main.activityId)) this.history.put(main.activityId, { sessionId: m.session_id });
      this.log(`main session ${m.session_id} mode=${m.permissionMode} model=${m.model}`);
      return;
    }
    if (m.type === "system" && m.subtype === "status") {
      if (m.status === "compacting") {
        if (!main.compacting) this.avatar.working("memory");
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
    if (m.type === "system") this.history.handle(m, main.sessionId);
    if (m.type === "system" && main.tasks.handle(m)) {
      if (this.backgroundTasks().length) this.avatar.working(); else this.avatar.settle(m.status !== "failed");
      return;
    }
    if (m.parent_tool_use_id) return; // subagent internals stay out of the chat
    if (m.type === "stream_event") {
      const ev = m.event;
      if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") main.toolsUsed = true;
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
        if (main.settings.builtin) this.log(`[usage] estimated_usd=${estimateUsageCost(main.settings.model,m.message.usage).toFixed(6)}`);
      }
      if (raw.trim()) {
        this.step(main.activityId, "text", raw);
      }
      (main.turnSpeech ||= new TurnSpeech()).assistant(m.message?.content);
      for (const b of m.message?.content || []) {
        if (b.type === "text") main.reply += (main.reply ? "\n\n" : "") + b.text;
        if (b.type === "tool_use") {
          main.toolsUsed = true;
          this.step(main.activityId, "tool", `${b.name} ${toolHint(b)}`.trim(), b.name);
          this.avatar.working(b.name, b.input);
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
    let text = "", error;
    if (main.failure) {
      error = humanError(main.failure.raw, main.failure.code);
      text = error;
      if (main.failure.context) {
        const state = readJson(config.stateFile, {});
        const context = recoveryContext({ root: config.root, chatLog: config.chatLog, redact: (s) => this.connectors.redact(s) });
        // Update only session routing. Never touch data/, schedule.json, the chat archive or old SDK transcripts.
        writePrivateJson(config.stateFile, { ...state, mainSessionId: null,
          mainRecovery: { context, fromSession: state.mainSessionId, ts: Date.now() } });
        main.needsFresh = true;
        const active = main.active;
        const retry = active && !active.manualCompact && !main.toolsUsed && !active.recoveryAttempt;
        if (retry) main.replay = { ...active, recoveryAttempt: 1 };
        text = RECOVERY_NOTICE + (retry ? "正在继续处理刚才的消息。" : active?.recoveryAttempt ? "这条消息仍然过长，请缩短内容或分批发送。" : "请继续发送消息。");
        this.log("[context recovery] fresh session; automatic replay=" + Boolean(retry));
      }
    } else if (result.subtype === "success" && main.recoveryContext) {
      const state = readJson(config.stateFile, {});
      delete state.mainRecovery;
      writePrivateJson(config.stateFile, state);
      main.recoveryContext = null;
    }
    if (!main.failure && !main.reply.trim() && typeof result.result === "string" && result.result.trim()) this.step(main.activityId, "text", result.result);
    if (error) this.speech.emit({ text }, { activityId: main.activityId, error: true });
    const status = error || result.subtype !== "success" ? "error" : "done";
    if (main.activityId) {
      const record = this.history.put(main.activityId, { status, endedAt: Date.now(), latestResult: text || main.reply.trim() || result.result || "" });
      if (listedActivity(record)) {
        this.bus.emit({ t: "activity", phase: "done", id: record.id, title: record.title, summary: record.summary, status, ts: record.endedAt });
        this.summarizeActivity(record.id);
      }
    }
    if (!main.replay) main.active?.resolve?.({ ok: status === "done", id: main.activityId });
    main.reply = ""; main.active = null; main.turnOpen = false;
    this.bus.emit({ t: "turn_end", activityId: main.activityId, text, error });
    // Queries without state events release on result; 0.3.295 waits for native idle.
    if (!main.hasSessionStateSignal || main.sdkState === "idle") this.releaseMainTurn();
  }

  // attachments: [{ path: "data/uploads/...", name, kind: "image" | "file" | "voice" }], already uploaded.
  send(text, source = "app", attachments = [], { ifEmpty = false, promptText = text, quote } = {}) {
    const deliver = async () => {
      if (this.closed) throw new Error("云端正在关闭，请稍后重试");
      if (ifEmpty && tailJsonl(config.chatLog, 1).length) return null;
      const message = validateMessage(config.root, promptText, attachments);
      const atts = await prepareAttachments(config.root, message.attachments);
      if (!this.busy) await this.refreshMain();
      const main = this.main;
      if (!main || main.ended) throw new Error("主聊天暂时不可用，请稍后重试");
      const id = crypto.randomUUID(), entry = { role: "user", id, activityId: main.turnOpen ? main.activityId : id, text: text.trim(), ts: Date.now(), source, ...(quote && { quote }), ...(atts.length && { attachments: atts }) };
      const input = { type: "user", uuid: id, message: { role: "user", content: userContent(config.root, message.text, atts) }, parent_tool_use_id: null };
      appendJsonl(config.chatLog, entry);
      if (source !== "onboarding") this.bus.emit({ t: "user", ...entry, attachments: atts });
      if (!main.turnOpen) this.beginMainTurn(main, { id, entry, input, promptText: message.text }, "user");
      else {
        this.step(main.activityId, "prompt", message.text, undefined, { ...(atts.length && { attachments: atts }) });
        if (main.active) {
          main.active = { ...main.active, input: { ...input, message: { role: "user", content: [...(Array.isArray(main.active.input.message.content) ? main.active.input.message.content : [{ type: "text", text: main.active.input.message.content }]), ...(Array.isArray(input.message.content) ? input.message.content : [{ type: "text", text: input.message.content }])] } } };
        }
      }
      main.inbox.push(withRecovery(input, main.recoveryContext));
      this.avatar.working();
      return id;
    };
    const result = this.inputChain.then(deliver, deliver);
    this.inputChain = result.catch(() => {});
    return result;
  }

  chooseOption(messageId, optionId, activityId) {
    if (activityId === undefined) return this.speech.choose(messageId, optionId, this.send.bind(this));
    const task = this.history.get(activityId);
    if (task.chatType !== "side") return Promise.reject(new TaskError("这个活动不是旁聊", 400, "not_side_chat"));
    return this.speech.side(activityId).choose(messageId, optionId, (text, source) => this.sendSideChat(task, text, [], source));
  }

  firstChat(device) {
    if (!["android", "mac"].includes(device)) return Promise.reject(Object.assign(new Error("设备必须是 android 或 mac"), { status: 400 }));
    if (this.firstChatPending) return this.firstChatPending;
    if (tailJsonl(config.chatLog, 1).length) return Promise.resolve({ started: false });
    this.firstChatPending = this.send(`[第一次聊天] 设备：${device}`, "onboarding", [], { ifEmpty: true }).then((id) => id ? { started: true, id } : { started: false }).finally(() => { this.firstChatPending = null; });
    return this.firstChatPending;
  }

  async browserReturned() {
    if (this.closed) return;
    const text = "[浏览器交还] 用户已交还浏览器，请重新读取页面后继续原来的工作。不要重复已经完成的点击或提交。";
    const owner = this.browserSession;
    if (owner?.cancelled) { this.avatar.settle(); return; }
    this.avatar.working("mcp__browser__snapshot");
    const isolated = owner && this.isolated.get(owner.activityId);
    if (isolated) {
      isolated.job.browserReturn = text;
      if (isolated.job.waitingBrowser) this.resumeBrowserJob(isolated);
      return;
    }
    if (owner?.isolated || owner?.agentId) {
      if (owner.activityId && this.history.records.has(owner.activityId)) return this.sendTask(owner.activityId, text);
    }
    const deliver = async () => {
      if (this.closed) return;
      if (!this.busy) await this.refreshMain();
      const main = this.main;
      if (!main || main.ended) throw new Error("主聊天暂时不可用");
      const input = { type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: text }, parent_tool_use_id: null };
      if (!main.turnOpen) this.beginMainTurn(main, { input }, "browser_return");
      this.step(main.activityId, "prompt", text, undefined, { from: "agent" });
      main.inbox.push(input);
      this.avatar.working("mcp__browser__snapshot");
    };
    const delivered = this.inputChain.then(deliver, deliver);
    this.inputChain = delivered.catch(() => {});
    return delivered;
  }

  resumeBrowserJob(isolated) {
    const { job, inbox } = isolated;
    this.step(job.id, "prompt", job.browserReturn, undefined, { from: "agent" });
    inbox.push({ type: "user", message: { role: "user", content: job.browserReturn }, parent_tool_use_id: null });
    job.resultSeen = false;
    job.browserReturn = null; job.awaitingBrowser = false; job.waitingBrowser = false;
  }

  async interrupt() {
    try {
      await this.main?.q?.interrupt();
    } catch (e) {
      this.log("interrupt failed:", this.connectors.redact(e.message));
    }
  }

  async stopTask(id) {
    if (this.browserSession?.activityId === id) this.browserSession = { cancelled: true };
    if (this.main?.activityId === id && this.main.turnOpen) return this.interrupt();
    if (this.running.has(id)) {
      if (this.history.records.get(id)?.kind === "maintenance") throw new TaskError("这项系统活动正在进行，请等它结束", 409, "task_not_stoppable");
      const isolated = this.isolated.get(id);
      if (!isolated) {
        this.cancelled.add(id);
        this.history.put(id, { status: "stopped", endedAt: Date.now(), latestResult: "已停止" });
        return;
      }
      if (isolated.job.stopped) throw new TaskError("活动正在停止", 409, "task_stopping");
      isolated.job.stopped = true;
      try { await isolated.q.interrupt(); }
      catch { isolated.job.stopped = false; throw new TaskError("停止活动失败，请稍后重试", 502, "task_stop_failed"); }
      return;
    }
    const main = [this.main, ...this.retired].find((session) => session?.tasks.live?.has(id)) || this.main;
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
    this.send("/compact", "maintenance").catch((e) => this.log("compact failed:", this.connectors.redact(e.message)));
    return true;
  }

  async close() {
    this.closed = true;
    this.summaryAbort.abort();
    for (const run of this.mainRuns.splice(0)) run.resolve({ ok: false, stopped: true });
    this.main?.active?.resolve?.({ ok: false, stopped: true });
    this.browser.off("state", this.onBrowserState);
    this.browser.off("returned", this.onBrowserReturned);
    for (const { q, inbox, job } of this.isolated.values()) { job.stopped = true; inbox.close(); q.close(); }
    clearTimeout(this.restartTimer); this.avatar.close();
    if (this.main) {
      this.main.intentionalClose = true;
      this.main.inbox.close(); this.main.q.close();
      await this.main.finished;
    }
    await Promise.all([...this.retired].map(async (main) => { main.intentionalClose = true; main.inbox.close(); main.q.close(); await main.finished; }));
    this.retired.clear();
    await this.jobChain;
    await Promise.allSettled([...this.summaryJobs]);
    await this.browser.close();
    this.avatar.close();
  }

  // ---------- isolated sessions (cron, catch-up, night tidy) ----------

  runIsolated(label, prompt, { id = crypto.randomUUID(), resumeTask, attachments=[], continuationContext, chatType, messageId } = {}) {
    const prior=resumeTask&&this.history.get(resumeTask);
    chatType ||= prior?.chatType;
    if (!prior && chatType !== "side") label = triggerTitle(prompt) || label;
    const chat = chatType === "side" ? { chatType } : {};
    const feed = /^\[动态\](?:\s|$)/.test(prompt);
    this.history.put(id, { title: label, summary: "", status: "running", feed, ...(feed && { feedPublished: false }), ...chat, ...(prior?{detached:true}:{kind:"isolated",instruction:prompt}) });
    this.running.set(id, { label, started: Date.now() });
    const run = async () => {
      if (this.cancelled.delete(id) || this.closed) {
        this.running.delete(id);
        this.history.put(id, { status: "stopped", endedAt: Date.now(), latestResult: "已停止" });
        this.sideInputs.delete(id);
        if (listedActivity(this.history.get(id))) this.bus.emit({ t: "activity", phase: "done", id, title: label, summary: "", status: "stopped", ts: Date.now(), ...chat });
        return { ok: false, stopped: true, outputs: new Set() };
      }
      const job = { id, label, outputs: new Set(), text: "", turnSpeech: new TurnSpeech(), ...(feed && { feedBefore: feedPosts() }) };
      const started = Date.now();
      const current=resumeTask&&this.history.get(resumeTask);
      const resume=current?.kind==="isolated"&&this.history.transcript(current).length?current.sessionId:null;
      const backgroundContext=!resume&&continuationContext?(chatType === "side" ? this.sideContext(id, messageId) : this.history.continuationContext(id)):null;
      const transcripts=current&&!resume?[...(current.transcripts||[]),{kind:current.kind,sessionId:current.sessionId,continuation:current.continuation}]:current?.transcripts||[];
      this.running.set(id, { label, started });
      this.history.put(id, { kind:"isolated",status: "running",...(current&&{transcripts,continuation:!resume||current.continuation}),...(current&&!resume&&{sessionId:null}),...(!prior&&{startedAt:started}) });
      if (listedActivity(this.history.get(id))) this.bus.emit({ t: "activity", phase: "started", id, title: label, summary: "", ts: started, ...chat });
      this.avatar.working();
      this.step(id, "prompt", prompt, undefined, { from: prior || chatType === "side" ? "user" : "agent", ...(attachments.length && { attachments }) });
      this.log(`job start: ${label}`);
      let q;
      const inbox = new Inbox();
      const compaction = this.compactionControl(() => q);
      try {
        // Streaming input permits live effort control in PreCompact, just as in the main session.
        const options={...this.options({ isolated: true, onWrite: (r, _input, valid) => this.noteWrite(r, job, valid), feed, chatType, speechContext: () => ({ activityId: id, ...chat }), compaction }),...(resume&&{resume})};
        q = this.queryFactory({ prompt: inbox, options });
        const runtime = selectedModel(config.root);
        this.isolated.set(id, { q, job, inbox, settings: { model: options.model, connection: runtime.connection, permissionMode: options.permissionMode } });
        const text=backgroundContext?`${backgroundContext}\n\n本次用户消息：\n${prompt}`:prompt;
        inbox.push({ type: "user", ...(messageId && { uuid: messageId }), message: { role: "user", content: userContent(config.root,text,attachments) }, parent_tool_use_id: null });
        if (chatType === "side") this.deliverSideInputs(this.isolated.get(id));
        for await (const m of q) {
          if (chatType === "side" && m.type === "system" && m.subtype === "session_state_changed") {
            job.hasSessionStateSignal = true; job.sdkState = m.state;
            if (m.state === "idle" && job.resultSeen && !job.awaitingBrowser) inbox.close();
          }
          if (m.type === "system" && m.subtype === "init") this.history.put(id, { sessionId: m.session_id });
          if (m.type === "system" && m.subtype === "compact_boundary") job.error = undefined;
          if (m.type === "system" && m.subtype === "status" && m.compact_result === "failed") {
            job.error = `Error during compaction: ${m.compact_error || "unknown"}`;
          }
          if (m.type === "assistant" && !m.parent_tool_use_id) {
            job.turnSpeech.assistant(m.message?.content);
            if(m.message?.usage && runtime.builtin)this.log(`[usage] estimated_usd=${estimateUsageCost(m.message.model || options.model,m.message.usage).toFixed(6)}`);
            for (const b of m.message?.content || []) if (b.type === "text") {
              if (m.error || (m.message?.model === "<synthetic>" && contextFailure(b.text))) job.error = b.text;
              else if (b.text?.trim()) {
                job.text = b.text;
                this.step(id, "text", b.text);
              }
            }
            for (const b of m.message?.content || []) if (b.type === "tool_use") { this.step(id, "tool", `${b.name} ${toolHint(b)}`.trim(), b.name); this.avatar.working(b.name, b.input); }
          }
          if (m.type === "result") {
            job.result = m.result;
            job.resultSeen = true;
            job.ok = m.subtype === "success" && !job.error && !job.stopped;
            if (!job.ok && !job.stopped) job.error ||= (m.errors || []).join("\n") || m.subtype;
            if (job.awaitingBrowser && job.ok) {
              job.ok = undefined;
              job.waitingBrowser = true;
              if (job.browserReturn) this.resumeBrowserJob(this.isolated.get(id));
              continue;
            }
            if (!job.ok || chatType !== "side" || !job.hasSessionStateSignal || job.sdkState === "idle") inbox.close();
          }
        }
      } catch (e) {
        job.ok = false;
        job.error = e.message;
      } finally {
        inbox.close();
        q?.close();
        this.isolated.delete(id);
        this.sideInputs.delete(id);
      }
      if (job.ok === undefined && !job.stopped) { job.ok = false; job.error ||= "SDK process ended before a result"; }
      if (!job.turnSpeech.prose && typeof job.result === "string" && job.result.trim()) {
        job.text = job.result; this.step(id, "text", job.result);
      }
      if (job.stopped) job.text = "已停止";
      if (job.error) {
        this.log("[job model error]", this.connectors.redact(job.error));
        job.text = humanError(job.error);
        if (chatType === "side") this.speech.emit({ text: job.text }, { activityId: id, error: true, ...chat });
      }
      const outputs = this.validOutputs(job.outputs);
      if (feed) for (const post of feedPosts()) if (!job.feedBefore.has(post)) {
        if (!outputs.includes(post)) outputs.push(post);
        this.publishFeedActivity(id);
      }
      const entry = { id, label, title: label + (job.ok ? "" : "（未完成）"), outputs, ok: !!job.ok, ts: Date.now() };
      const status = job.stopped ? "stopped" : job.ok ? "done" : "error";
      this.history.put(id, { status, endedAt: entry.ts, latestResult:this.connectors.redact(job.text), outputs:[...new Set([...(prior?.outputs||[]),...outputs])] });
      if (listedActivity(this.history.get(id))) {
        this.bus.emit({ t: "activity", phase: "done", ...entry, summary: this.history.get(id).summary, status, ...chat });
        this.summarizeActivity(id);
      }
      this.running.delete(id);
      this.avatar.settle(job.ok);
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
