// Issue a one-time 6-digit pairing code (valid 24h). Run on the ECS:
//   sudo -u agent node /opt/personal-agent/cloud/src/pair.mjs
import crypto from "node:crypto";
import path from "node:path";
import { config } from "./config.mjs";
import { writeJson } from "./store.mjs";

const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
writeJson(path.join(config.system, "pair.json"), { code, expires: Date.now() + 24 * 3600_000, fails: 0 });
console.log(code);
