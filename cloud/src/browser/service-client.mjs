import fs from "node:fs";
import path from "node:path";

export function serviceState(root) {
  const file = path.join(root, "system/browser/service.json"), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid()) throw new Error("浏览器服务端点文件权限不正确");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Number.isSafeInteger(state.pid) || state.pid <= 0 || typeof state.token !== "string" || !/^[a-f0-9]{64}$/.test(state.token) ||
    typeof state.url !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(state.url) || Number(new URL(state.url).port) > 65535) throw new Error("浏览器服务端点不正确");
  return state;
}

export async function serviceRequest(root, route, { method = "POST", body, timeoutMs = 25_000, state = serviceState(root) } = {}) {
  const response = await fetch(state.url + route, { method, headers: { Authorization: `Bearer ${state.token}`, "Content-Type": "application/json" },
    redirect: "error", signal: AbortSignal.timeout(timeoutMs), ...(body !== undefined && { body: JSON.stringify(body) }) });
  const text = await response.text();
  if (text.length > 512 * 1024) throw new Error("浏览器服务响应过大");
  const value = JSON.parse(text);
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "浏览器服务请求失败");
  if (value.pid !== state.pid) throw new Error("浏览器服务端点已经失效");
  return value;
}
