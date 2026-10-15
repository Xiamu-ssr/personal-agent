import fs from "node:fs";
import path from "node:path";
import { BrowserProcess } from "./process.mjs";
import { writePrivateJson } from "../private-json.mjs";

const root = process.env.AGENT_ROOT || "/srv/agent";
const stateFile = path.join(root, "system/browser/service.json");
const manager = new BrowserProcess({ root });
let finish;
const finished = new Promise((resolve) => { finish = resolve; });
manager.once("exit", finish);
process.once("SIGTERM", finish);
process.once("SIGINT", finish);
try {
  const endpoint = await manager.ensure();
  writePrivateJson(stateFile, { pid: process.pid, endpoint });
  await finished;
} catch {
  console.error("独立浏览器启动失败，请检查 Chrome/Xvfb、沙箱和目录权限");
  process.exitCode = 1;
} finally {
  await manager.stop();
  try { if (JSON.parse(fs.readFileSync(stateFile, "utf8")).pid === process.pid) fs.rmSync(stateFile); } catch {}
}
