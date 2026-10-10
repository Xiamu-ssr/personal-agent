// Opt-in, one tiny normal Messages call. Never prints credentials or response thinking.
// Production: supply the same env as the service. Local: --local-settings reads only ~/.claude/settings.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contextPolicy } from "../src/context-policy.mjs";

const local = process.argv.includes("--local-settings")
  ? JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude/settings.json"), "utf8")).env || {} : {};
const env = { ...local, ...process.env };
const model = env.AGENT_MODEL || "anthropic/claude-haiku-5.5";
const policy = contextPolicy(model, env);
const base = new URL(env.ANTHROPIC_BASE_URL || "http://missing.invalid");
if (base.hostname !== "zenmux.ai" || base.protocol !== "https:" || !(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY)) {
  throw new Error("需要本地可用的 ZenMux 地址和凭据；不会回退到其他服务");
}
const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
if (env.ANTHROPIC_AUTH_TOKEN) headers.authorization = "Bearer " + env.ANTHROPIC_AUTH_TOKEN;
else headers["x-api-key"] = env.ANTHROPIC_API_KEY;
const response = await fetch(base.href.replace(/\/$/, "") + "/v1/messages", {
  method: "POST", headers, signal: AbortSignal.timeout(30_000),
  body: JSON.stringify({ model, max_tokens: policy.maxOutputTokens, thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    messages: [{ role: "user", content: "Reply with just OK." }] }),
});
let body;
try { body = await response.json(); } catch {}
let errorMessage = body?.error?.message || body?.message;
if (errorMessage) {
  errorMessage = String(errorMessage);
  for (const secret of [env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_API_KEY]) if (secret) errorMessage = errorMessage.replaceAll(secret, "[已隐藏]");
  errorMessage = errorMessage.replace(/sk-[A-Za-z0-9_-]+/g, "[已隐藏]").slice(0, 400);
}
console.log(JSON.stringify({ gateway: base.origin, model, max_tokens: policy.maxOutputTokens,
  status: response.status, accepted: response.ok, usage: body?.usage,
  stop_reason: body?.stop_reason, errorType: body?.error?.type, errorMessage,
  textCharacters: (body?.content || []).filter((b) => b.type === "text").reduce((n, b) => n + b.text.length, 0) }));
if (!response.ok) process.exitCode = 1;
