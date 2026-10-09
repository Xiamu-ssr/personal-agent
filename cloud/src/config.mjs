// Paths and settings. Everything comes from /etc/personal-agent.env (loaded by systemd).
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = process.env.AGENT_ROOT || "/srv/agent";
export const CODE = path.resolve(here, "..");

export const config = {
  root: ROOT,
  port: Number(process.env.AGENT_PORT || 4400),
  host: process.env.AGENT_HOST || "127.0.0.1",
  token: process.env.AGENT_TOKEN || "",
  model: process.env.AGENT_MODEL || "anthropic/claude-haiku-5.5",
  permissionMode: process.env.AGENT_PERMISSION_MODE || "auto",
  timezone: process.env.AGENT_TZ || "Asia/Shanghai",
  // Haiku without deep thinking takes long detours; max is still cheap on it.
  effort: process.env.AGENT_EFFORT || "max",
  promptFile: path.join(CODE, "..", "spec", "prompts", "system-prompt.md"),
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
  "history", "health", "finance", "feedback", "automation-prefs", "role", "voice-notes",
];
