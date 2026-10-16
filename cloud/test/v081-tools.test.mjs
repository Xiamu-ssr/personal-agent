import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { checkDataAccess } from "../src/data-guard.mjs";
import { config, CODE } from "../src/config.mjs";
import { fakeAnthropic } from "./fake-anthropic.mjs";
import { nativeHarness, toolReply, textReply, resultFor } from "./native-fixture.mjs";

test("Bash permits reading protected originals, conversions and outward copies while rejecting actual write destinations", () => {
  for (const dir of ["health", "uploads"]) fs.mkdirSync(path.join(config.data, dir), { recursive: true });
  fs.symlinkSync(path.join(config.data, "uploads"), path.join(config.root, "uploaded"));
  const allow = [
    "cat data/uploads/a.pdf", "ls -la data/health", "pdftotext data/uploads/a.pdf /tmp/a.txt", "pdftotext data/uploads/a.pdf -",
    "python3 -c \"print(open('data/uploads/a.txt').read())\"", "python3 -c \"print(open('data/health/days.json', 'r').read())\"",
    "python3 -c \"from pathlib import Path; print(Path('data/uploads/a.txt').read_text())\"",
    "cp data/uploads/a.pdf workspace/", "rsync -a data/uploads/ workspace/copy/", "tar -czf /tmp/uploads.tgz data/uploads",
    "tar -xf data/uploads/a.tar -C workspace/", "unzip data/uploads/a.zip -d workspace/", "cat data/health/days.json | head -n 5",
    "find data/uploads -type f -exec cat {} \\;", "find data/uploads -type f -exec cp {} /tmp/ \\;", "sed 's/a/b/' data/uploads/a.txt", "python3 -c \"import shutil; shutil.copy('data/uploads/a.txt', '/tmp/a.txt')\"",
  ];
  for (const command of allow) assert.deepEqual(checkDataAccess({ tool_name: "Bash", tool_input: { command } }), {}, command);
  const deny = [
    "rm data/uploads/a.pdf", "rm -rf data", "mv data/uploads/a.txt workspace/", "mv workspace/x data/health/x",
    "echo changed > data/uploads/a.txt", "echo changed >> data/health/days.json", "echo changed | tee data/uploads/a.txt",
    "cp workspace/x data/uploads/", "cp -t data/uploads workspace/x", "cp -tdata/uploads workspace/x", "rsync -a workspace/ data/health/",
    "sed -i '' s/a/b/ data/uploads/a.txt", "sed --in-place=.bak s/a/b/ data/health/days.json", "truncate -s 0 data/uploads/a.txt",
    "chmod 777 data/uploads/a.txt", "chown agent data/health", "touch data/uploads/new.txt", "ln -s /tmp/x data/uploads/link",
    "tar -xf workspace/a.tar -C data/uploads", "unzip workspace/a.zip -d data/uploads", "tar -czf data/uploads/a.tgz workspace/",
    "python3 -c \"open('data/uploads/a.txt', 'w').write('x')\"", "python3 -c \"from pathlib import Path; Path('data/health/days.json').write_text('x')\"",
    "node -e \"require('fs').writeFileSync('data/uploads/a.txt','x')\"", "pdftotext workspace/a.pdf data/uploads/a.txt",
    "cd data/uploads && rm a.txt", "f=data/uploads/a.txt; rm \"$f\"", "touch uploaded/new.txt", "rm data/*",
    "bash -c 'rm data/health/days.json'", "rm \"$AGENT_ROOT/data/uploads/a.txt\"", "find data/uploads -type f -exec rm {} \\;",
    "awk '{print 1 > \"data/uploads/a.txt\"}' workspace/a.txt",
  ];
  for (const command of deny) {
    const result = checkDataAccess({ tool_name: "Bash", tool_input: { command } });
    assert.equal(result.hookSpecificOutput?.permissionDecision, "deny", command);
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /读取.*不能/);
  }
  for (const tool_name of ["Write", "Edit"]) assert.equal(checkDataAccess({ tool_name, tool_input: { file_path: "data/uploads/a.txt" } }).hookSpecificOutput.permissionDecision, "deny");
});

test("deployment pins both Python names and pip to 3.11 and sets a reproducible service PATH", () => {
  const deploy = path.join(CODE, "deploy"), unit = fs.readFileSync(path.join(deploy, "personal-agent.service"), "utf8"), installer = fs.readFileSync(path.join(deploy, "install.sh"), "utf8");
  assert.match(unit, /Environment=PATH=\/opt\/personal-agent\/cloud\/deploy\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin/);
  for (const name of ["python", "python3"]) { assert.ok(fs.lstatSync(path.join(deploy, "bin", name)).isSymbolicLink()); assert.equal(fs.readlinkSync(path.join(deploy, "bin", name)), "/usr/bin/python3.11"); }
  for (const name of ["pip", "pip3"]) { assert.match(fs.readFileSync(path.join(deploy, "bin", name), "utf8"), /exec \/usr\/bin\/python3\.11 -m pip "\$@"/); assert.equal(fs.statSync(path.join(deploy, "bin", name)).mode & 0o111, 0o111); }
  for (const pkg of ["poppler-utils", "python3.11", "pypdf", "pdfplumber", "python-docx", "openpyxl"]) assert.ok(installer.includes(pkg));
});

test("the native SDK Bash tool inherits the service-style PATH from the harness environment", { timeout: 25_000 }, async (t) => {
  const bin = path.join(config.root, "fixture-bin"); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "python3"), "#!/bin/sh\nprintf 'Python 3.11.fixture\\n'\n", { mode: 0o755 });
  const previous = process.env.PATH; process.env.PATH = bin + path.delimiter + previous; t.after(() => { process.env.PATH = previous; });
  let observed;
  const api = await fakeAnthropic((body) => {
    const result = resultFor(body, "python_path");
    if (!result) return toolReply("python_path", "Bash", { command: "python3 --version", description: "检查 Python 入口" });
    observed = JSON.stringify(result); return textReply("工具环境检查完成。");
  });
  const { harness, until } = nativeHarness(t, api); await harness.send("VERIFY_TOOL_PATH"); await until(() => !harness.busy);
  assert.match(observed, /Python 3\.11\.fixture/);
});
