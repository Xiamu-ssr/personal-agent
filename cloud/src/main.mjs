// Personal Agent cloud body: harness + scheduler + App/device gateway.
import path from "node:path";
import { config, CODE } from "./config.mjs";
import { DeviceHub } from "./devices.mjs";
import { Harness } from "./agent.mjs";
import { ConnectorManager } from "./connectors.mjs";
import { startScheduler } from "./scheduler.mjs";
import { startServer } from "./server.mjs";
import { HealthSync } from "./health.mjs";
import { initialize } from "./initialize.mjs";

import { Content } from "./content.mjs";

const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!config.token) {
  console.error("AGENT_TOKEN is not set");
  process.exit(1);
}

const listeners = new Set();
const bus = { on: (fn) => listeners.add(fn), emit: (ev) => listeners.forEach((fn) => fn(ev)) };

initialize(config.root);
const hub = new DeviceHub();
const connectors = new ConnectorManager();
for(const failure of await connectors.initialize())log(`connector skills unavailable: ${failure.name} ${failure.error}`);
const health=new HealthSync({root:config.root,hub,timezone:config.timezone});
const harness = new Harness({ hub, bus, log, connectors });

hub.onChange = () => bus.emit({ t: "devices", devices: hub.online() });
// Device catch-up: on reconnect, at most once every 20 hours, in its own session.
hub.onReconnect = (info) => {
  const sources = (info.capabilities || []).filter((c) => c.sync && c.enabled !== false).map((c) => c.source || c.name);
  if (!sources.length || Date.now() - hub.lastCatchup(info.id) < 20 * 3600_000) return;
  hub.markCatchup(info.id);
  harness.runIsolated(`补读 · ${info.name || info.id}`, `[补读] ${info.id}\n\n设备：${info.name || info.id}\n来源：${sources.join("、")}`);
};

harness.runtime.onCrash=()=>process.kill(process.pid,"SIGTERM");
await harness.startMain();
const content = new Content({ root: config.root, bus, timezone: config.timezone });
const schedules = startScheduler({ harness, log, health, content });
const server = startServer({ harness, hub, bus, log, connectors, health, content, schedules });

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  schedules.stop();
  try { await harness.close(); } catch { log("shutdown: OpenClaw cleanup did not finish"); }
  server.closeSockets();
  server.closeAllConnections();
  server.close(() => process.exit(0));
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

process.on("unhandledRejection", (e) => log("unhandledRejection:", e?.message || e));
