// SDK edges carry progress/results; the level signal is authoritative for activity.
import { humanError, contextFailure } from "./conversation-recovery.mjs";

export class TaskError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

export class BackgroundTasks {
  constructor({ bus, log, redact, onComplete }) {
    Object.assign(this, { bus, log, redact, onComplete });
    this.records = new Map();
    this.live = new Map();
    this.levelSeen = false;
  }

  list() {
    return [...this.live.values()].map(({ id, description, startedAt }) => ({ id, description, startedAt }));
  }

  reset() {
    this.records.clear(); this.live.clear(); this.levelSeen = false;
    this.bus.emit({ t: "task", phase: "snapshot", tasks: [] });
  }

  record(m) {
    const id = m.task_id;
    let record = this.records.get(id);
    if (m.run_id && record?.runId && m.run_id < record.runId) return null;
    if (!record || (m.run_id && record.runId && m.run_id !== record.runId)) {
      record = { id, startedAt: Date.now(), outputs: new Set() };
      this.records.set(id, record);
    }
    if (m.run_id) record.runId = m.run_id;
    if (m.description) record.description = this.redact(m.description);
    record.description ||= "后台任务";
    return record;
  }

  handle(m) {
    if (m.subtype === "background_tasks_changed") {
      this.levelSeen = true;
      const live = new Map();
      for (const item of m.tasks) {
        if (item.ambient) continue;
        const record = this.record(item);
        if (record) { record.background = true; live.set(record.id, record); }
      }
      this.live = live; // Never infer this set by pairing potentially missing/late edges.
      this.bus.emit({ t: "task", phase: "snapshot", tasks: this.list() });
      return true;
    }
    if (!m.subtype?.startsWith("task_")) return false;
    if (m.ambient) return true;
    const record = this.record(m);
    if (!record) return true;
    if (m.subtype === "task_started") {
      if (record.ended) return true; // late bookend after completion
      record.background = m.is_backgrounded ?? record.background ?? true;
      if (record.background && !this.levelSeen) this.live.set(record.id, record);
    }
    if (m.subtype === "task_updated") {
      if (m.patch.description) record.description = this.redact(m.patch.description);
      if (m.patch.error) this.log("[task error]", this.redact(m.patch.error));
      if (m.patch.is_backgrounded) {
        record.background = true;
        if (!this.levelSeen && !record.ended) this.live.set(record.id, record);
      }
    }
    if (m.subtype === "task_notification") {
      record.background = true;
      if (!this.levelSeen) this.live.delete(record.id);
      if (record.ended) return true; // cards/results are emitted only once per run
      record.ended = true; record.stopping = false; record.status = m.status;
      this.onComplete(record, m);
      // Retain a bounded set of ended IDs to distinguish "already ended" from "unknown".
      const ended = [...this.records.values()].filter((r) => r.ended);
      for (const old of ended.slice(0, Math.max(0, ended.length - 256))) this.records.delete(old.id);
    }
    if (!record.background) return true;
    const taskError = contextFailure(m.summary || "") || /^(?:API Error|Error during)/i.test(m.summary || "");
    if (taskError) this.log("[task model error]", this.redact(m.summary));
    this.bus.emit({ t: "task", phase: m.subtype.slice(5), id: record.id, description: record.description,
      startedAt: record.startedAt, status: m.status, patch: m.patch && this.redact({ ...m.patch, error: m.patch.error && humanError(m.patch.error) }),
      summary: taskError ? humanError(m.summary) : this.redact(m.summary), background: true });
    return true;
  }

  running(id) {
    if (typeof id !== "string" || !id.trim()) throw new TaskError("请提供任务 id", 400, "invalid_task_id");
    const record = this.records.get(id);
    if (record?.ended) throw new TaskError("任务已经结束", 409, "task_ended");
    if (record?.stopping) throw new TaskError("任务正在停止", 409, "task_stopping");
    if (!this.live.has(id)) throw new TaskError("没有这个运行中的后台任务", 404, "task_not_found");
    return record;
  }
}
