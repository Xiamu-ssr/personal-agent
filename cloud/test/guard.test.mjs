import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { checkConnectorAccess } from "../src/connector-guard.mjs";
import { config } from "../src/config.mjs";

const check = (tool_name, tool_input) => checkConnectorAccess({ tool_name, tool_input });
const denied = (result) => assert.equal(result.hookSpecificOutput?.permissionDecision, "deny");
test("connector guard rejects config paths for every specified file tool; data remains accessible", () => {
  for (const name of ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    denied(check(name, { file_path: "system/connectors/x/accounts.json", notebook_path: "system/connectors/x/state.json" }));
    assert.deepEqual(check(name, { file_path: "data/memory/work/test.md" }), {});
  }
  denied(check("Read", { file_path: path.join(config.root, "system/connectors/x/accounts.json") }));
  denied(check("Read", { file_path: "data/../system/connectors/x/accounts.json" }));
  denied(check("Glob", { pattern: "system/connectors/**/*.json" }));
  denied(check("Glob", { pattern: "**/*.json" }));
  denied(check("Glob", { path: "system/connectors", pattern: "**/*" }));
  denied(check("Grep", { path: "system", pattern: "x" }));
  denied(check("Grep", { pattern: "x" }));
  assert.deepEqual(check("Glob", { pattern: "data/**/*.md" }), {});
  assert.deepEqual(check("Grep", { path: "data/", pattern: "secret" }), {});
  assert.deepEqual(check("Read", { file_path: "system/custom-connectors/test/.env" }), {});
  assert.deepEqual(check("Read", { file_path: "system/connectors-other/test.txt" }), {});
});

test("Bash rejects literal configuration access, including accounts.json outside the usual path", () => {
  for (const command of ["cat system/connectors/x/accounts.json", "python3 -c 'open(\"accounts.json\")'", "ls /tmp/root/system/connectors"]) denied(check("Bash", { command }));
  assert.deepEqual(check("Bash", { command: "cat data/test.md" }), {});
});

test("existing symlink aliases and newly created files beneath them are guarded", () => {
  fs.mkdirSync(config.connectors, { recursive: true });
  const alias = path.join(config.root, "alias");
  fs.symlinkSync(config.connectors, alias);
  denied(check("Read", { file_path: "alias/x/accounts.json" }));
  denied(check("Write", { file_path: "alias/x/new.json" }));
});
