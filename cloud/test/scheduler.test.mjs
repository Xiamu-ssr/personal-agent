import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { startScheduler, runScheduledTask } from "../src/scheduler.mjs";
import { config } from "../src/config.mjs";
import { writeJson } from "../src/store.mjs";

test("cron is an alarm for briefs; compact, cleanup, catch-up and night tidy keep their routing", async (t) => {
  const sent = [], isolated = [], compact = [];
  const harness = { send: async (...args) => sent.push(args), runIsolated: async (...args) => isolated.push(args),
    compactMain: () => { compact.push(true); return true; }, log() {}, connectors: { redact: (s) => s } };
  fs.mkdirSync(config.workspace, { recursive: true });
  const old = path.join(config.workspace, "old-scratch"), recent = path.join(config.workspace, "recent-scratch");
  fs.mkdirSync(old); fs.mkdirSync(recent);
  fs.utimesSync(old, new Date(0), new Date(0));
  writeJson(config.scheduleFile, [
    { id: "brief", name: "晨间简报", cron: "* * * * *", kind: "brief", prompt: "总结报价" },
    { id: "compact", kind: "compact", cron: "* * * * *" },
    { id: "cleanup", kind: "cleanup", cron: "* * * * *" },
    { id: "night", name: "夜间整理", cron: "* * * * *", prompt: "[夜间整理]" },
    { id: "catchup", name: "补读", cron: "* * * * *", prompt: "[补读] fixture" },
    { id: "disabled", cron: "* * * * *", enabled: false },
  ]);
  let now = new Date("2026-10-10T00:00:00Z");
  const scheduler = startScheduler({ harness, log() {}, clock: () => now });
  t.after(scheduler.stop);
  await tick();
  assert.deepEqual(sent, [["[定时] 该出「晨间简报」了\n\n总结报价", "schedule"]]);
  assert.deepEqual(isolated, [["夜间整理", "[夜间整理]"], ["补读", "[补读] fixture"]]);
  assert.equal(compact.length, 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(recent), true);
  scheduler.tick(); await tick();
  assert.equal(sent.length, 1, "only one alarm per matching minute");
  now = new Date("2026-10-10T00:01:00Z");
  scheduler.tick(); await tick();
  assert.equal(sent.length, 2);
  assert.equal(await runScheduledTask(harness, { id: "manual", prompt: "手动简报" }), "alarm");
  assert.deepEqual(sent.at(-1), ["[定时] 该出「manual」了\n\n手动简报", "schedule"]);
});
