import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = process.env.AGENT_ROOT || "/srv/agent";
export const CODE = path.resolve(here, "..");
export const VERSION = JSON.parse(fs.readFileSync(path.join(CODE,"package.json"),"utf8")).version;
export const PROTOCOL = "1";
export const config = {
 root: ROOT, port: Number(process.env.AGENT_PORT || 4400), host: process.env.AGENT_HOST || "127.0.0.1",
 token: process.env.AGENT_TOKEN || "", timezone: process.env.AGENT_TZ || "Asia/Shanghai",
 prompts: path.join(CODE,"..","spec","prompts"), agentName: process.env.AGENT_NAME || "豆豆", userCall: process.env.AGENT_USER_CALL || "用户",
 data: path.join(ROOT,"data"), workspace: path.join(ROOT,"workspace"), system: path.join(ROOT,"system"),
 connectors: path.join(ROOT,"system/connectors"), sync: path.join(ROOT,"system/sync"),
 stateFile: path.join(ROOT,"system/state.json"), chatLog: path.join(ROOT,"system/chat.jsonl"), scheduleFile: path.join(ROOT,"system/schedule.json"),
 openclaw: path.join(ROOT,".openclaw"), gatewayPort: Number(process.env.OPENCLAW_PORT || 18789),
};
