import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function check(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) check(file);
    else if (file.endsWith(".mjs")) {
      const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
for (const dir of ["src", "connectors", "openclaw-plugin", "scripts", "test"]) if (fs.existsSync(dir)) check(dir);
