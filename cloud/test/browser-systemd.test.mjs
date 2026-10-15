import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { SystemdBrowserProcess } from "../src/browser/systemd-process.mjs";
import { screenshotService } from "../src/screenshot-service.mjs";

const endpoint = "ws://127.0.0.1:9222/devtools/browser/fixture";
function setup(t, { stale = false, unavailable = false } = {}) {
  const root = fs.mkdtempSync(path.join(testRoot, "browser-systemd-")), calls = [];
  let pid = 0;
  const executeCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, "systemctl"); assert.equal(args[0], "--user"); assert.equal(args.at(-1), "personal-agent-browser.service");
    if (unavailable) throw new Error("fixture user bus unavailable");
    if (args[1] === "start") {
      pid++;
      fs.mkdirSync(path.join(root, "system/browser"), { recursive: true });
      fs.writeFileSync(path.join(root, "system/browser/service.json"), JSON.stringify({ pid: stale ? 99 : pid, endpoint }));
    }
    if (args[1] === "stop") pid = 0;
    return { stdout: args[1] === "show" ? String(pid) : "" };
  };
  const manager = new SystemdBrowserProcess({ root, env: {}, service: "personal-agent-browser.service", executeCommand, startupMs: 20, pollMs: 10_000 });
  t.after(() => manager.stop().catch(() => {}));
  return { manager, calls, crash: () => { pid = 0; } };
}

test("systemd backend is lazy and starts only a fixed user unit; reuses its endpoint and stops the unit", async (t) => {
  const { manager, calls } = setup(t); assert.equal(calls.length, 0);
  assert.equal(await manager.ensure(), endpoint); assert.equal(await manager.ensure(), endpoint);
  assert.equal(calls.filter((c) => c.args[1] === "start").length, 1);
  assert.match(calls[0].options.env.DBUS_SESSION_BUS_ADDRESS, /^unix:path=\/run\/user\/\d+\/bus$/);
  assert.equal(calls.some((c) => c.command.includes("chrome")), false);
  await manager.stop(); assert.equal(manager.endpoint, null); assert.equal(calls.at(-1).args[1], "stop");
});

test("browser unit loss emits exit and the next request starts a fresh service without touching the main unit", async (t) => {
  const { manager, calls, crash } = setup(t), exits = [];
  manager.on("exit", () => exits.push(true)); await manager.ensure(); crash(); await manager.check();
  assert.equal(manager.endpoint, null); assert.equal(exits.length, 1);
  await manager.ensure(); assert.equal(calls.filter((c) => c.args[1] === "start").length, 2);
  assert.ok(calls.every((c) => !c.args.includes("personal-agent.service")));
});

test("missing user manager and stale service state fail closed with no direct Chrome fallback", async (t) => {
  for (const options of [{ stale: true }, { unavailable: true }]) {
    const { manager, calls } = setup(t, options);
    await assert.rejects(manager.ensure(), /没有退回主服务/);
    assert.equal(manager.endpoint, null);
    assert.ok(calls.every((c) => c.command === "systemctl"));
  }
});

test("deploy units put browser and main in separate managers with independent limits and no eager browser start", () => {
  const deploy = new URL("../deploy/", import.meta.url), read = (name) => fs.readFileSync(new URL(name, deploy), "utf8");
  const main = read("personal-agent.service"), browser = read("personal-agent-browser.service"), installer = read("browser-service-install.sh"), slice = read("personal-agent-browser.slice"), thumbnail = read("personal-agent-thumbnail@.service");
  assert.match(main, /MemoryMax=900M/); assert.match(main, /AGENT_BROWSER_SERVICE=personal-agent-browser.service/);
  assert.match(browser, /MemoryMax=450M/); assert.match(browser, /MemoryHigh=320M/); assert.match(browser, /OOMPolicy=kill/);
  assert.match(browser, /KillMode=control-group/); assert.match(browser, /Restart=no/);
  assert.doesNotMatch(browser, /PartOf=personal-agent.service|EnvironmentFile=|\[Install\]/);
  assert.match(installer, /loginctl enable-linger agent/); assert.match(installer, /cgroup.controllers/);
  assert.doesNotMatch(installer, /systemctl --user (?:start|enable) personal-agent-browser/);
  assert.match(slice, /MemoryMax=450M/); assert.match(slice, /MemoryHigh=320M/);
  for (const service of [browser, thumbnail]) assert.match(service, /Slice=personal-agent-browser.slice/);
});

test("artifact screenshots use an independent user unit, preserve the response bytes and clean their private job directory", async () => {
  const root = fs.mkdtempSync(path.join(testRoot, "screenshot-service-")), calls = [];
  const executeCommand = async (command, args) => {
    assert.equal(command, "systemctl"); assert.equal(args[0], "--user"); calls.push(args[1]);
    const id = args.at(-1).match(/^personal-agent-thumbnail@([a-f0-9-]+)\.service$/)[1], dir = path.join(root, "system/browser/screenshots", id);
    if (args[1] === "start") {
      const request = JSON.parse(fs.readFileSync(path.join(dir, "request.json"), "utf8"));
      assert.equal(request.path, "data/library/artifacts/page/index.html"); assert.equal(request.timeoutMs, 7000);
      fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ width: 390, height: 844, path: request.path }));
      fs.writeFileSync(path.join(dir, "image.jpg"), "fixture JPEG bytes");
    }
  };
  const result = await screenshotService({ root, path: "data/library/artifacts/page/index.html", timeoutMs: 10_000, executeCommand });
  assert.equal(result.width, 390); assert.equal(result.data.toString(), "fixture JPEG bytes");
  assert.deepEqual(calls, ["start", "stop"]); assert.equal(fs.readdirSync(path.join(root, "system/browser/screenshots")).length, 0);
  await assert.rejects(screenshotService({ root, path: "data/library/artifacts/page/index.html", timeoutMs: 10_000, executeCommand: async () => { throw new Error("unit unavailable"); } }), /独立截图服务/);
});
