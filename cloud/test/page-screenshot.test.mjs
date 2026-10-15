import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { PageScreenshot, screenshotTarget, browserExecutable } from "../src/page-screenshot.mjs";
const put = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };

test("artifact screenshot rejects traversal, non-artifact paths, symlink escapes and unavailable browsers", async () => {
  const root = fs.mkdtempSync(path.join(testRoot, "screens-path-")); put(root, "data/library/artifacts/demo/index.html", "<html><body>本地页面</body></html>");
  assert.equal(screenshotTarget(root, "data/library/artifacts/demo").rel, "data/library/artifacts/demo/index.html");
  const outside = put(root, "system/private.html", "私人内容"); fs.symlinkSync(outside, path.join(root, "data/library/artifacts/demo/escape.html"));
  for (const rel of ["https://example.test", "system/private.html", "data/library/artifacts/demo/../../system/private.html", "data/library/artifacts/demo/escape.html", "data/library/artifacts/demo/file.js"]) assert.throws(() => screenshotTarget(root, rel));
  await assert.rejects(new PageScreenshot({ root, executablePath: "/missing-browser-for-local-test" }).screenshot({ path: "data/library/artifacts/demo" }), /页面截图暂不可用/);
});

test("local artifact screenshots bound JPEG size/height, serialize browser use and block external HTTP/WebSocket", { timeout: 30_000, skip: !browserExecutable() }, async (t) => {
  const root = fs.mkdtempSync(path.join(testRoot, "screens-browser-")); let requests = 0;
  const external = http.createServer((_q, r) => { requests++; r.end("external"); }); external.on("upgrade", (_req, socket) => { requests++; socket.destroy(); }); external.listen(0, "127.0.0.1"); await once(external, "listening"); t.after(() => external.close());
  const port = external.address().port;
  put(root, "data/library/artifacts/demo/index.html", `<!doctype html><html><head><link rel="stylesheet" href="local.css"></head><body><h1>本地页面</h1><img src="http://127.0.0.1:${port}/image"><script>fetch('http://127.0.0.1:${port}/fetch');new WebSocket('ws://127.0.0.1:${port}/socket');</script></body></html>`);
  put(root, "data/library/artifacts/demo/local.css", "body{margin:0;background:rgb(20,100,150);height:3000px}");
  const pages = new PageScreenshot({ root }), first = pages.screenshot({ path: "data/library/artifacts/demo" });
  await assert.rejects(pages.screenshot({ path: "data/library/artifacts/demo" }), /正在截图/);
  const image = await first; assert.equal(image.width, 390); assert.equal(image.height, 844 * 3); assert.ok(image.data.length <= 300 * 1024); assert.equal((await sharp(image.data).metadata()).format, "jpeg"); assert.equal(requests, 0);
  const pixel = await sharp(image.data).extract({ left: 380, top: 100, width: 1, height: 1 }).raw().toBuffer(); assert.ok(Math.abs(pixel[0] - 20) < 12 && Math.abs(pixel[1] - 100) < 12 && Math.abs(pixel[2] - 150) < 12);
});

test("screenshot timeout closes its browser and releases the single-call slot", { timeout: 40_000, skip: !browserExecutable() }, async () => {
  const root = fs.mkdtempSync(path.join(testRoot, "screens-timeout-")); put(root, "data/library/artifacts/hang/index.html", "<html><body><script>while(true){}</script></body></html>");
  await assert.rejects(new PageScreenshot({ root, timeoutMs: 2000 }).screenshot({ path: "data/library/artifacts/hang" }), /截图超时|Timeout/);
  put(root, "data/library/artifacts/ready/index.html", "<html><body>下一张可以截图</body></html>");
  assert.equal((await new PageScreenshot({ root }).screenshot({ path: "data/library/artifacts/ready" })).width, 390);
});
