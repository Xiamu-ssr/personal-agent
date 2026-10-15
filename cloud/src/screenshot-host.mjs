import fs from "node:fs";
import path from "node:path";
import { PageScreenshot } from "./page-screenshot.mjs";
import { writePrivateJson } from "./private-json.mjs";

const root = process.env.AGENT_ROOT || "/srv/agent", id = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(id || "")) throw new Error("截图任务 id 不正确");
const dir = path.join(root, "system/browser/screenshots", id);
try {
  const request = JSON.parse(fs.readFileSync(path.join(dir, "request.json"), "utf8"));
  const screenshot = new PageScreenshot({ root, service: false, timeoutMs: Math.max(100, Math.min(25_000, request.timeoutMs)) });
  const { data, ...metadata } = await screenshot.screenshot({ path: request.path });
  fs.writeFileSync(path.join(dir, "image.jpg"), data, { mode: 0o600 });
  writePrivateJson(path.join(dir, "result.json"), metadata);
} catch {
  writePrivateJson(path.join(dir, "result.json"), { error: "截图未完成" });
  process.exitCode = 1;
}
