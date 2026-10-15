// Infrastructure comes from the service environment; model/permissions come from app-settings.json.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { contextPolicy } from "./context-policy.mjs";
import { readAppSettings } from "./app-settings.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = process.env.AGENT_ROOT || "/srv/agent";
export const CODE = path.resolve(here, "..");
export const VERSION = JSON.parse(fs.readFileSync(path.join(CODE,"package.json"),"utf8")).version;
const compactEffort = process.env.AGENT_COMPACT_EFFORT || "low";
if (!["low", "medium", "high"].includes(compactEffort)) throw new Error("AGENT_COMPACT_EFFORT 只能是 low、medium 或 high");

export const config = {
  root: ROOT,
  port: Number(process.env.AGENT_PORT || 4400),
  host: process.env.AGENT_HOST || "127.0.0.1",
  token: process.env.AGENT_TOKEN || "",
  get model() { return readAppSettings(ROOT).model; },
  get context() { return contextPolicy(this.model); },
  compactEffort,
  get permissionMode() { return readAppSettings(ROOT).permissionMode; },
  timezone: process.env.AGENT_TZ || "Asia/Shanghai",
  // Normal turns use max; compaction temporarily uses compactEffort.
  effort: "max",
  promptFile: path.join(CODE, "..", "spec", "prompts", "system-prompt.md"),
  prompts: path.join(CODE, "..", "spec", "prompts"),
  agentName: process.env.AGENT_NAME || "豆豆",
  userCall: process.env.AGENT_USER_CALL || "用户",
  // The agent's three zones
  data: path.join(ROOT, "data"),
  workspace: path.join(ROOT, "workspace"),
  system: path.join(ROOT, "system"),
  connectors: path.join(ROOT, "system", "connectors"),
  sync: path.join(ROOT, "system", "sync"),
  sessions: path.join(ROOT, "system", "sessions"),
  stateFile: path.join(ROOT, "system", "state.json"),
  chatLog: path.join(ROOT, "system", "chat.jsonl"),
  scheduleFile: path.join(ROOT, "system", "schedule.json"),
};

export const MEMORY_CATEGORIES = [
  "profile", "people", "preferences", "life", "work", "project", "interests",
  "history", "health", "finance", "feedback", "automation-prefs", "voice-notes",
];
