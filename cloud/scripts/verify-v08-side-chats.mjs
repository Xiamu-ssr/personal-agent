import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const output = "/tmp/v08-cloud-demo/side-chats";
fs.mkdirSync(output, { recursive: true });
const log = fs.createWriteStream(path.join(output, "demo.log"));
const child = spawn(process.execPath, ["--test", "--test-reporter=spec", "test/sdk-side-chats.test.mjs"], {
  cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  env: { ...process.env, AGENT_SIDE_CHAT_DEMO_DIR: output }, stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { log.write(data); process.stdout.write(data); });
child.on("error", (e) => { log.end(e.message + "\n"); process.exitCode = 1; });
child.on("close", (code) => { log.end(); process.exitCode = code ?? 1; });
