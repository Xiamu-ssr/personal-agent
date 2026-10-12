// The only owner of built-in connector credentials and state. Neither manifests nor MCP results contain credentials.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import registry from "../connectors/index.mjs";
import { writePrivateJson } from "./private-json.mjs";
import { config, VERSION } from "./config.mjs";

export const SECRET_MASK = "••••";
export class ConnectorError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export { writePrivateJson } from "./private-json.mjs";

function readPrivateJson(file, fallback) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error("symlink");
    fs.chmodSync(file, 0o600);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw new ConnectorError("连接器配置文件损坏或不可读取，请联系管理员检查", 500);
  }
}

const fingerprint = (values) => crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const VALUES = z.record(z.string(), z.union([z.string(), z.number()]));

export class ConnectorManager {
  constructor({ root = config.root, definitions = registry, onChange = () => {} } = {}) {
    this.root = root;
    this.dir = path.join(root, "system", "connectors");
    this.definitions = new Map(definitions.map((d) => [d.name, d]));
    this.accounts = new Map();
    this.chains = new Map();
    this.pending = new Map(); // Connector-specific uncommitted batches survive query reconstruction, not process restart.
    this.knownSecrets = new Set(); // Also redact retired credentials from still-running query snapshots/logs.
    this.revision = 0;
    this.onChange = onChange;
    for (const definition of definitions) {
      if (!/^[a-z][a-z0-9_-]*$/.test(definition.name)) throw new Error("Invalid connector registry id");
      const configured = this.hasAccountFile(definition.name);
      const saved = configured ? readPrivateJson(this.file(definition.name, "accounts.json"), { accounts: [] }) : { accounts: [] };
      if (!Array.isArray(saved.accounts) || saved.accounts.some((a) => !a?.id || !a.values)) {
        throw new ConnectorError("连接器账号文件格式不正确，请联系管理员检查", 500);
      }
      this.accounts.set(definition.name, saved.accounts);
      for (const record of saved.accounts) this.rememberSecrets(definition.name, record.values);
      this.pending.set(definition.name, new Map());
      if (configured) this.readState(definition.name); // Unconfigured legacy directories (including their state) are ignored.
    }
  }

  // Connector lifecycle hooks can install/version-check official skills without exposing credentials.
  async initialize() {
    const failures=[];
    for(const definition of this.definitions.values())if(this.accounts.get(definition.name).length&&definition.install) {
      try{await this.enqueue(definition.name,()=>definition.install(this.context(definition.name,this.accounts.get(definition.name))));}
      catch(e){failures.push({name:definition.name,error:this.redact(e.message)});}
    }
    return failures;
  }

  definition(name) {
    const definition = this.definitions.get(name);
    if (!definition) throw new ConnectorError("没有这个预置连接器", 404);
    return definition;
  }

  hasAccountFile(name) {
    this.definition(name);
    try { fs.lstatSync(path.join(this.dir, name, "accounts.json")); return true; }
    catch (e) {
      if (e.code === "ENOENT") return false;
      throw new ConnectorError("连接器配置文件不可读取，请联系管理员检查", 500);
    }
  }

  file(name, filename) {
    this.definition(name);
    const dir = path.join(this.dir, name);
    // Fail closed for known connector paths; unknown/legacy directories are never opened.
    for (const p of [this.dir, dir]) {
      try { if (fs.lstatSync(p).isSymbolicLink()) throw new ConnectorError("连接器配置目录不能是符号链接", 500); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    return path.join(dir, filename);
  }

  secrets(name, extra = []) {
    const keys = this.definition(name).fields.filter((f) => f.type === "secret").map((f) => f.key);
    return [...(this.accounts.get(name) || []).map((a) => a.values), ...extra]
      .flatMap((v) => keys.map((key) => v?.[key])).filter((v) => typeof v === "string" && v && v !== SECRET_MASK);
  }

  rememberSecrets(name, values) {
    for (const secret of this.secrets(name, [values])) this.knownSecrets.add(secret);
  }

  redact(value, secrets = [...this.knownSecrets]) {
    if (typeof value === "string") {
      for (const secret of secrets.sort((a, b) => b.length - a.length)) value = value.replaceAll(secret, SECRET_MASK);
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => this.redact(v, secrets));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.redact(v, secrets)]));
    return value;
  }

  publicAccount(record, secrets) {
    return this.redact({ id: record.id, label: record.label, status: record.status, error: record.error ?? null, checkedAt: record.checkedAt ?? null }, secrets);
  }

  maskedValues(name, values) {
    const out = { ...values };
    for (const field of this.definition(name).fields) if (field.type === "secret" && field.key in out) out[field.key] = SECRET_MASK;
    return this.redact(out, this.secrets(name, [values]));
  }

  list() {
    const installed = [], catalog = [];
    for (const definition of this.definitions.values()) {
      const accounts = this.accounts.get(definition.name) || [];
      const item = { name: definition.name, title: definition.title, description: definition.description, icon: `/api/connectors/${definition.name}/icon`,
        fields: definition.fields, multiAccount: definition.multiAccount, status: accounts.length ? "on" : "off" };
      if (accounts.length) installed.push({ ...item, accounts: accounts.map((a) => ({ ...this.publicAccount(a), values: this.maskedValues(definition.name, a.values) })) });
      else catalog.push(item);
    }
    return this.redact({ installed, catalog });
  }

  enqueue(name, fn) {
    this.definition(name);
    const task = (this.chains.get(name) || Promise.resolve()).then(fn);
    this.chains.set(name, task.catch(() => {}));
    return task;
  }

  values(name, patch, old = {}) {
    const definition = this.definition(name);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ConnectorError("请提供 values 配置字段");
    const values = { ...old };
    for (const [key, value] of Object.entries(patch)) {
      const field = definition.fields.find((f) => f.key === key);
      if (!field) throw new ConnectorError("包含不支持的配置字段");
      if (field.type === "secret" && (value === SECRET_MASK || value === undefined)) continue;
      if (typeof value !== "string" && typeof value !== "number") throw new ConnectorError(`「${field.label}」格式不正确`);
      values[key] = value;
    }
    for (const field of definition.fields) {
      if (field.showIf && !Object.entries(field.showIf).every(([k, v]) => values[k] === v)) continue;
      if (values[field.key] === undefined && field.default !== undefined) values[field.key] = field.default;
      if (field.required && (values[field.key] === undefined || values[field.key] === "")) throw new ConnectorError(`请填写「${field.label}」`);
      const value = values[field.key];
      if (value === undefined) continue;
      if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new ConnectorError(`「${field.label}」必须是数字`);
      if (field.type !== "number" && typeof value !== "string") throw new ConnectorError(`「${field.label}」必须是文字`);
      if (field.type === "select" && !field.options.some((o) => o.value === value)) throw new ConnectorError(`请选择有效的「${field.label}」`);
    }
    return definition.validate ? definition.validate(values) : values;
  }

  find(name, id) {
    this.definition(name);
    const record = this.accounts.get(name).find((a) => a.id === id);
    if (!record) throw new ConnectorError("没有这个账号", 404);
    return record;
  }

  async check(name, values) {
    this.rememberSecrets(name, values);
    try { await this.definition(name).test({ ...values }); }
    catch (e) { throw new ConnectorError(this.redact(String(e.message || "连接器验证失败"), this.secrets(name, [values]))); }
  }

  save(name, accounts) {
    writePrivateJson(this.file(name, "accounts.json"), { accounts });
    this.accounts.set(name, accounts);
    this.pending.get(name).clear();
    this.revision++;
    this.onChange(name);
  }

  addAccount(name, patch) {
    return this.enqueue(name, async () => {
      const values = this.values(name, patch);
      const accounts = this.accounts.get(name);
      if (!this.definition(name).multiAccount && accounts.length) throw new ConnectorError("这个连接器只支持一个账号");
      await this.check(name, values);
      const record = { id: crypto.randomUUID().slice(0, 8), label: this.redact(this.definition(name).label(values), this.secrets(name, [values])), values, status: "ok", checkedAt: Date.now(), error: null };
      if(this.definition(name).install)await this.definition(name).install(this.context(name,[...accounts,record]));
      // Create state.json on first account as well, with the same private, atomic write guarantees.
      this.writeState(name, this.readState(name));
      this.save(name, [...accounts, record]);
      return this.publicAccount(record);
    });
  }

  updateAccount(name, id, patch) {
    return this.enqueue(name, async () => {
      const old = this.find(name, id);
      const values = this.values(name, patch, old.values);
      await this.check(name, values);
      const record = { ...old, label: this.redact(this.definition(name).label(values), this.secrets(name, [values])), values, status: "ok", checkedAt: Date.now(), error: null };
      if(this.definition(name).install)await this.definition(name).install(this.context(name,this.accounts.get(name).map((a)=>a.id===id?record:a)));
      // A different mailbox under the same account id must never inherit its previous UID cursor.
      if (old.values.address !== values.address || old.values.host !== values.host || old.values.port !== values.port) {
        const state = this.readState(name);
        if (state.accounts) delete state.accounts[id];
        this.writeState(name, state);
      }
      this.save(name, this.accounts.get(name).map((a) => a.id === id ? record : a));
      return this.publicAccount(record);
    });
  }

  removeAccount(name, id) {
    return this.enqueue(name, async () => {
      this.find(name, id);
      if(this.accounts.get(name).length===1&&this.definition(name).uninstall)await this.definition(name).uninstall(this.context(name,this.accounts.get(name)));
      const state = this.readState(name);
      if (state.accounts) delete state.accounts[id];
      this.writeState(name, state);
      this.save(name, this.accounts.get(name).filter((a) => a.id !== id));
      return { ok: true };
    });
  }

  testAccount(name, id) {
    return this.enqueue(name, async () => {
      const record = { ...this.find(name, id), checkedAt: Date.now(), status: "ok", error: null };
      try { await this.check(name, record.values); } catch (e) { record.status = "error"; record.error = e.message; }
      this.save(name, this.accounts.get(name).map((a) => a.id === id ? record : a));
      return this.publicAccount(record);
    });
  }

  readState(name) { return this.hasAccountFile(name) ? readPrivateJson(this.file(name, "state.json"), {}) : {}; }
  writeState(name, state) { writePrivateJson(this.file(name, "state.json"), state); }

  context(name, accounts) {
    return {
      root: this.root, workspace: path.join(this.root, "workspace"), timezone: config.timezone,version:VERSION,
      redact: (value) => this.redact(value),
      readState: () => this.readState(name), writeState: (state) => this.writeState(name, state),
      pending: this.pending.get(name),
      assertCurrent: (id) => {
        const snapshot = accounts.find((a) => a.id === id);
        const current = this.accounts.get(name).find((a) => a.id === id);
        if (!snapshot || !current || fingerprint(snapshot.values) !== fingerprint(current.values)) throw new ConnectorError("账号配置已变更，请重新补读");
      },
    };
  }

  managementTools() {
    const wrap = (fn) => async (args) => {
      try { return text(this.redact(await fn(args))); }
      catch (e) { return { ...text({ error: this.redact(e.message || "连接器操作失败") }), isError: true }; }
    };
    return [
      tool("list", "列出预置连接器、账号状态和配置字段；密钥不会返回。", {}, wrap(() => this.list())),
      tool("add_account", "添加并验证账号。若用户在聊天里提供授权码，成功后将 notice 提醒告诉用户。", { name: z.string(), values: VALUES }, wrap(async ({ name, values }) => ({
        ...await this.addAccount(name, values),
        notice: "下次在 App 里点「连接」填表单更安全，聊天记录里会留下授权码",
      }))),
      tool("update_account", "修改并验证账号。secret 省略或传 •••• 保持原值。", { name: z.string(), id: z.string(), values: VALUES }, wrap(({ name, id, values }) => this.updateAccount(name, id, values))),
      tool("remove_account", "删除账号；最后一个账号删除后卸载连接器。", { name: z.string(), id: z.string() }, wrap(({ name, id }) => this.removeAccount(name, id))),
    ];
  }

  // Instances belong to ONE query: sharing an SDK MCP transport across main/isolated queries is unsafe.
  // Account mutations increment revision; the harness calls this again at the next turn boundary.
  mcpServers() {
    const servers = { connectors: createSdkMcpServer({ name: "connectors", version: VERSION, tools: this.managementTools() }) };
    for (const definition of this.definitions.values()) {
      const accounts = structuredClone(this.accounts.get(definition.name));
      if (!accounts.length) continue;
      servers[definition.name] = createSdkMcpServer({ name: definition.name, version: VERSION, tools: definition.tools(accounts, this.context(definition.name, accounts)) });
    }
    return servers;
  }
}
