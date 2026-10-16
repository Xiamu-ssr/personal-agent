import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writePrivateJson } from "./private-json.mjs";
import { messagesRequest } from "./messages-api.mjs";

export const HAIKU_MODEL = "anthropic/claude-haiku-5.5";
export const MODELS = [
  { id: HAIKU_MODEL, label: "Claude Haiku 5.5", note: "消耗约 1×；输入超过 100K 后约 5×" },
  { id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5", note: "消耗约 40×；缓存读约 20×" },
  { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", note: "输入约 1.5×，输出约 1×；缓存读约 3×" },
  { id: "z-ai/glm-5.3-flashx", label: "GLM 5.3 FlashX", note: "输入约 3.75×，输出约 2.5×；缓存读约 7.5×" },
  { id: "xiaomi/mimo-v2.6-pro", label: "MiMo-V2.6-Pro", note: "输入约 4.35×，输出约 1.74×；缓存读约 0.36×" },
];
export const ZENMUX = { id: "zenmux", name: "ZenMux", builtin: true, protocol: "anthropic", models: MODELS.map(({ id, label, note }) => ({ id, name: label, note })) };

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function text(value, limit, label) {
  if (typeof value !== "string" || !value.trim() || [...value.trim()].length > limit || /[\r\n\0]/.test(value)) fail(label + "格式不正确");
  return value.trim();
}
export function baseUrl(value) {
  if (typeof value !== "string" || /[\r\n\0]/.test(value)) fail("Base URL 格式不正确");
  let url;
  try { url = new URL(value); } catch { fail("Base URL 必须是 HTTP 或 HTTPS 地址"); }
  if (!["http:", "https:"].includes(url.protocol) || /[?#]/.test(url.href) || url.username || url.password) fail("Base URL 必须是 HTTP 或 HTTPS 地址，不能带账号、query 或 hash");
  return url.href.replace(/\/+$/, "");
}
function fields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !allowed.includes(k))) fail("模型服务字段不正确");
}
function validate(value) {
  const name = text(value.name, 40, "名称"), url = baseUrl(value.baseUrl), apiKey = text(value.apiKey, 4096, "API Key");
  if (!Array.isArray(value.models) || value.models.length < 1 || value.models.length > 20) fail("请添加 1–20 个模型");
  const models = value.models.map((m) => { fields(m, ["id", "name"]); return { id: text(m.id, 200, "模型 ID"), name: text(m.name, 40, "模型显示名") }; });
  if (new Set(models.map((m) => m.id)).size !== models.length) fail("服务内模型 ID 不能重复");
  if ([name, url, ...models.flatMap((m) => [m.id, m.name])].some((s) => s.includes(apiKey))) fail("服务资料不能包含 API Key");
  return { name, baseUrl: url, apiKey, models };
}

export function readProviders(root) {
  const file = path.join(root, "system/providers.json"), dir = path.dirname(file);
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) fail("模型服务目录不能是符号链接");
  try { if (fs.lstatSync(file).isSymbolicLink()) fail("模型服务配置不能是符号链接"); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  if (!fs.existsSync(file)) writePrivateJson(file, { providers: [] });
  fs.chmodSync(file, 0o600);
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(value.providers)) throw new Error();
    const records = value.providers.map((p) => {
      if (!/^[a-f0-9-]{36}$/.test(p.id)) throw new Error();
      return { id: p.id, ...validate(p) };
    });
    if (new Set(records.map((p) => p.id)).size !== records.length) throw new Error();
    return records;
  } catch { fail("模型服务配置损坏，请检查 system/providers.json", 500); }
}
function mask(value, key) {
  if (typeof value === "string") return value.replaceAll(key, "••••");
  if (Array.isArray(value)) return value.map((v) => mask(v, key));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, key)]));
}
export function publicProvider(p) {
  return { id: p.id, builtin: false, protocol: "anthropic", ...mask({ name: p.name, baseUrl: p.baseUrl, models: p.models }, p.apiKey), keyHint: p.apiKey.length > 4 ? p.apiKey.slice(-4) : "••••" };
}
export function listProviders(root) { return [structuredClone(ZENMUX), ...readProviders(root).map(publicProvider)]; }
export function providerRecord(root, id) {
  if (id === "zenmux") return ZENMUX;
  return readProviders(root).find((p) => p.id === id) || fail("没有这个模型服务", 404);
}

export async function testProvider(input, { env = process.env, request = messagesRequest, remember = () => {}, redact = (s) => s, timeout = 20_000 } = {}) {
  fields(input, ["baseUrl", "apiKey", "model"]);
  const key = text(input.apiKey, 4096, "API Key"); remember(key);
  const url = baseUrl(input.baseUrl), model = text(input.model, 200, "模型 ID"), start = Date.now();
  let response;
  try {
    response = await request(url + "/v1/messages", { method: "POST", signal: AbortSignal.timeout(timeout),
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": key, authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "Hi" }] }),
    }, env);
  } catch { fail("模型服务连接失败或超时"); }
  let body; try { body = await response.json(); } catch {}
  if (!response.ok) {
    const message = typeof body?.error?.message === "string" ? redact(body.error.message.replaceAll(key, "••••")).replace(/\s+/g, " ").slice(0, 200) : "";
    fail(`HTTP ${response.status}` + (message ? "：" + message : ""));
  }
  if (!Array.isArray(body?.content)) fail(`HTTP ${response.status}：返回的不是 Messages API 响应`);
  return { ok: true, ms: Date.now() - start };
}

export class Providers {
  constructor({ root, connectors, selected, probe = testProvider }) {
    Object.assign(this, { root, connectors, selected, probe }); this.chain = Promise.resolve();
    for (const p of readProviders(root)) this.remember(p.apiKey);
  }
  remember(key) { if (typeof key === "string" && key) this.connectors.knownSecrets.add(key); }
  validatePublic(value) {
    const data = { name: value.name, baseUrl: value.baseUrl, models: value.models };
    if (JSON.stringify(this.connectors.redact(data)) !== JSON.stringify(data)) fail("服务资料不能包含 API Key");
  }
  test(input) { return this.probe(input, { remember: (key) => this.remember(key), redact: (s) => this.connectors.redact(s) }); }
  mutate(fn) { const p = this.chain.then(fn); this.chain = p.catch(() => {}); return p; }
  create(input) {
    return this.mutate(async () => {
      fields(input, ["name", "baseUrl", "apiKey", "models"]); this.remember(input.apiKey);
      const value = validate(input);
      this.validatePublic(value);
      await this.test({ baseUrl: value.baseUrl, apiKey: value.apiKey, model: value.models[0].id });
      const records = readProviders(this.root), record = { id: crypto.randomUUID(), ...value };
      records.push(record); writePrivateJson(path.join(this.root, "system/providers.json"), { providers: records });
      return publicProvider(record);
    });
  }
  patch(id, input) {
    return this.mutate(async () => {
      if (id === "zenmux") fail("内置服务不能修改或删除");
      fields(input, ["name", "baseUrl", "apiKey", "models"]); this.remember(input.apiKey);
      const old = providerRecord(this.root, id), keepKey = input.apiKey === undefined || typeof input.apiKey === "string" && !input.apiKey.trim();
      const value = validate({ ...old, ...input, apiKey: keepKey ? old.apiKey : input.apiKey });
      this.validatePublic(value);
      const checkSelected = () => { const m = this.selected(); if (m.provider === id && !value.models.some((row) => row.id === m.id)) fail("先换到别的模型", 409); };
      checkSelected();
      if (["baseUrl", "models"].some((key) => Object.hasOwn(input, key)) || !keepKey) await this.test({ baseUrl: value.baseUrl, apiKey: value.apiKey, model: value.models[0].id });
      checkSelected();
      const records = readProviders(this.root), index = records.findIndex((p) => p.id === id), record = { id, ...value };
      records[index] = record; writePrivateJson(path.join(this.root, "system/providers.json"), { providers: records });
      return publicProvider(record);
    });
  }
  remove(id) {
    return this.mutate(() => {
      if (id === "zenmux") fail("内置服务不能修改或删除");
      providerRecord(this.root, id);
      if (this.selected().provider === id) fail("先换到别的模型", 409);
      writePrivateJson(path.join(this.root, "system/providers.json"), { providers: readProviders(this.root).filter((p) => p.id !== id) });
      return { ok: true };
    });
  }
}
