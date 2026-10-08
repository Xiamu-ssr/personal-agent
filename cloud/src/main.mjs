// Personal Agent cloud body: harness + scheduler + App/device gateway.
import fs from "node:fs";
import path from "node:path";
import { config, CODE } from "./config.mjs";
import { DeviceHub } from "./devices.mjs";
import { Harness } from "./agent.mjs";
import { startScheduler } from "./scheduler.mjs";
import { startServer } from "./server.mjs";

const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!config.token) {
  console.error("AGENT_TOKEN is not set");
  process.exit(1);
}

// First boot: lay out the three zones and copy seed files that don't exist yet.
function seed() {
  for (const d of ["data/memory/profile", "data/briefs", "data/sites", "data/diary", "workspace", "system/connectors", "system/sync", "system/sessions", ".claude/skills"]) {
    fs.mkdirSync(path.join(config.root, d), { recursive: true });
  }
  const seedDir = path.join(CODE, "seed");
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, e.name);
      const dst = path.join(config.root, path.relative(seedDir, src));
      if (e.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        walk(src);
      } else if (!fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        log(`seeded ${path.relative(config.root, dst)}`);
      }
    }
  };
  walk(seedDir);
}

const listeners = new Set();
const bus = { on: (fn) => listeners.add(fn), emit: (ev) => listeners.forEach((fn) => fn(ev)) };

seed();
const hub = new DeviceHub();
const harness = new Harness({ hub, bus, log });

hub.onChange = () => bus.emit({ t: "devices", devices: hub.online() });
// Device catch-up: on reconnect, at most once every 20 hours, in its own session.
hub.onReconnect = (info) => {
  const sources = (info.capabilities || []).filter((c) => c.sync).map((c) => c.source || c.name);
  if (!sources.length || Date.now() - hub.lastCatchup(info.id) < 20 * 3600_000) return;
  hub.markCatchup(info.id);
  harness.runIsolated(`补读 · ${info.name || info.id}`, `[补读] ${info.id}\n\n设备：${info.name || info.id}\n来源：${sources.join("、")}`);
};

harness.startMain();
startScheduler({ harness, log });
startServer({ harness, hub, bus, log });

process.on("unhandledRejection", (e) => log("unhandledRejection:", e?.message || e));
