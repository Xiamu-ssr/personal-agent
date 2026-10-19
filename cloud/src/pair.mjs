// One-time 6-digit pairing codes (valid 24h). Issue one on the ECS:
//   sudo -u agent node /opt/personal-agent/cloud/src/pair.mjs
// or from an already-paired device via POST /api/pair/new.
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "./config.mjs";
import { writeJson } from "./store.mjs";

export function issuePairCode() {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  writeJson(path.join(config.system, "pair.json"), { code, expires: Date.now() + 24 * 3600_000, fails: 0 });
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(issuePairCode());
