import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writePrivateJson } from "./private-json.mjs";
import { userSystemdEnv } from "./browser/systemd-process.mjs";

const execute = promisify(execFile);
export async function screenshotService({ root, path: rel, timeoutMs, executeCommand = execute }) {
  const id = crypto.randomUUID(), unit = `personal-agent-thumbnail@${id}.service`, dir = path.join(root, "system/browser/screenshots", id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivateJson(path.join(dir, "request.json"), { path: rel, timeoutMs: Math.max(100, Math.min(25_000, timeoutMs - 3000)) });
  const command = (...args) => executeCommand("systemctl", ["--user", ...args, unit], { env: userSystemdEnv(), timeout: timeoutMs, maxBuffer: 16 * 1024 });
  try {
    await command("start");
    const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
    if (result.error) throw new Error(result.error);
    return { ...result, data: fs.readFileSync(path.join(dir, "image.jpg")) };
  } catch {
    throw new Error("页面截图暂不可用：请检查独立截图服务、浏览器安装和内存上限");
  } finally {
    try { await command("stop"); fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
