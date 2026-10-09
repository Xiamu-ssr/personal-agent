import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";

export const CONNECTOR_GUARD_TOOLS = "Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep|Bash";
const REASON = "连接器配置只能用 connectors 工具改（包括读取）；请用 connectors.list 查看账号状态。";
const BROAD = "搜索范围包含 system/connectors（连接器配置不能直接读）；请把 path 限定到 data/、workspace/ 等具体目录再搜。";
const inside = (file, dir) => file === dir || file.startsWith(dir + path.sep);

// Resolve existing parent symlinks too, including a new file beneath a symlinked directory.
function resolved(file) {
  let parent = file;
  const tail = [];
  while (!fs.existsSync(parent) && parent !== path.dirname(parent)) {
    tail.unshift(path.basename(parent));
    parent = path.dirname(parent);
  }
  try { return path.join(fs.realpathSync(parent), ...tail); } catch { return file; }
}

export function checkConnectorAccess(input, { root = config.root, connectors = path.join(root, "system", "connectors") } = {}) {
  const name = input.tool_name;
  const args = input.tool_input || {};
  let blocked = false;
  let broad = false;
  if (name === "Bash") {
    // Deliberately best effort: this is not a shell interpreter or an OS sandbox.
    blocked = /system[\\/]connectors\b|accounts\.json/i.test(String(args.command || ""));
  } else {
    const protectedDir = path.resolve(connectors);
    const realDir = resolved(protectedDir);
    const paths = [args.file_path, args.notebook_path, args.path, ...(args.edits || []).map((e) => e.file_path)].filter((p) => typeof p === "string");
    if (name === "Glob") {
      // A literal prefix lets data/**/*.md through, but a repository-wide wildcard could read secrets.
      const prefix = String(args.pattern || "").split(/[?*[{]/, 1)[0];
      paths.push(path.resolve(root, args.path || ".", prefix));
    } else if (name === "Grep") paths.push(args.path || root);
    for (const p of paths) {
      const abs = path.resolve(root, p);
      const real = resolved(abs);
      if (inside(abs, protectedDir) || inside(real, realDir)) blocked = true;
    }
    if (name === "Grep") {
      const base = resolved(path.resolve(root, args.path || "."));
      if (inside(realDir, base)) blocked = broad = true;
    }
    if (name === "Glob") {
      const prefix = String(args.pattern || "").split(/[?*[{]/, 1)[0];
      const base = resolved(path.resolve(root, args.path || ".", prefix));
      if (inside(realDir, base)) blocked = broad = true;
    }
  }
  return blocked ? {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: broad ? BROAD : REASON },
  } : {};
}
