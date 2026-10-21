import { testRoot } from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { PageScreenshot, screenshotTarget, browserExecutable } from "../src/page-screenshot.mjs";
import { Content } from "../src/content.mjs";
const put = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };

test("artifact screenshot rejects traversal, non-artifact paths, symlink escapes and unavailable browsers", async () => {
  const root = fs.mkdtempSync(path.join(testRoot, "screens-path-")); put(root, "data/library/sites/demo/index.html", "<html><body>本地页面</body></html>");
  assert.equal(screenshotTarget(root, "data/library/sites/demo").rel, "data/library/sites/demo/index.html");
  const outside = put(root, "system/private.html", "私人内容"); fs.symlinkSync(outside, path.join(root, "data/library/sites/demo/escape.html"));
  for (const rel of ["https://example.test", "system/private.html", "data/library/sites/demo/../../system/private.html", "data/library/sites/demo/escape.html", "data/library/sites/demo/file.js"]) assert.throws(() => screenshotTarget(root, rel));
  await assert.rejects(new PageScreenshot({ root, executablePath: "/missing-browser-for-local-test" }).screenshot({ path: "data/library/sites/demo" }), /页面截图暂不可用/);
});

test("local artifact screenshots bound JPEG size/height, serialize browser use and block external HTTP/WebSocket", { timeout: 30_000, skip: !browserExecutable() }, async (t) => {
  const root = fs.mkdtempSync(path.join(testRoot, "screens-browser-")); let requests = 0;
  const external = http.createServer((_q, r) => { requests++; r.end("external"); }); external.on("upgrade", (_req, socket) => { requests++; socket.destroy(); }); external.listen(0, "127.0.0.1"); await once(external, "listening"); t.after(() => external.close());
  const port = external.address().port;
  put(root, "data/library/sites/demo/index.html", `<!doctype html><html><head><link rel="stylesheet" href="local.css"></head><body><h1>本地页面</h1><img src="http://127.0.0.1:${port}/image"><script>fetch('http://127.0.0.1:${port}/fetch');new WebSocket('ws://127.0.0.1:${port}/socket');</script></body></html>`);
  put(root, "data/library/sites/demo/local.css", "body{margin:0;background:rgb(20,100,150);height:3000px}");
  const pages = new PageScreenshot({ root });
  const images=await Promise.all(Array.from({length:6},()=>pages.thumbnail({path:"data/library/sites/demo/index.html"})));
  assert.ok(images.every(image=>image===images[0]),"same-page requests must share one render");
  const image=images[0];assert.equal(image.width, 390); assert.equal(image.height, 844 * 3); assert.ok(image.data.length <= 300 * 1024); assert.equal((await sharp(image.data).metadata()).format, "jpeg"); assert.equal(requests, 0);
  const pixel = await sharp(image.data).extract({ left: 380, top: 100, width: 1, height: 1 }).raw().toBuffer(); assert.ok(Math.abs(pixel[0] - 20) < 12 && Math.abs(pixel[1] - 100) < 12 && Math.abs(pixel[2] - 150) < 12);
  assert.equal(await pages.thumbnail({path:"data/library/sites/demo/index.html"}),image,"a later reload uses the cached render");
  put(root,"data/library/sites/demo/local.css","body{margin:0;background:rgb(180,80,40)}");
  const changed=await pages.thumbnail({path:"data/library/sites/demo/index.html"});assert.notEqual(changed,image,"changing a page dependency invalidates the preview");
  const updated=await sharp(changed.data).extract({left:380,top:100,width:1,height:1}).raw().toBuffer();assert.ok(updated[0]>150&&updated[2]<70);
});

test("the library indexes standalone pages, documents and media; every concurrent preview succeeds",{timeout:45_000,skip:!browserExecutable()},async()=>{
  const root=fs.mkdtempSync(path.join(testRoot,"library-batch-"));
  const colors=['#296c83','#ab6838','#7b4a86','#55793c','#354fa4'];
  colors.forEach((color,i)=>put(root,`data/library/sites/page${i}/index.html`,`<!doctype html><body style="margin:0;background:${color}">Page ${i}</body>`));
  put(root,"data/library/sites/poster.html","<!doctype html><body>Standalone page</body>");
  put(root,"data/library/documents/notes.md","# Standalone notes");
  put(root,"data/library/media/cover.png",await sharp({create:{width:20,height:20,channels:3,background:'#ffcc00'}}).png().toBuffer());
  const library=new Content({root}),first=library.library();assert.equal(first.artifacts.length,7);assert.equal(first.media.length,1);
  assert.ok(first.artifacts.every(a=>a.kind!=='site'||a.thumbnail.includes('&rev=')));
  const pages=new PageScreenshot({root}),results=await Promise.all(first.artifacts.filter(a=>a.kind==='site').map(a=>pages.thumbnail({path:a.path})));
  assert.equal(results.length,6);assert.ok(results.every(x=>x.data.length>0));
  const exported=await pages.tools().find(t=>t.name==='export_image').execute({path:'data/library/sites/poster.html'});
  assert.notEqual(exported.isError,true);const receipt=JSON.parse(exported.content[0].text);assert.equal(receipt.delivered,false);assert.equal(receipt.next.cards[0].path,receipt.path);assert.ok(fs.statSync(path.join(root,receipt.path)).size>0);
});

test("screenshot timeout closes its browser and releases the single-call slot", { timeout: 40_000, skip: !browserExecutable() }, async () => {
  const root = fs.mkdtempSync(path.join(testRoot, "screens-timeout-")); put(root, "data/library/sites/hang/index.html", "<html><body><script>while(true){}</script></body></html>");
  await assert.rejects(new PageScreenshot({ root, timeoutMs: 2000 }).screenshot({ path: "data/library/sites/hang" }), /截图超时|Timeout/);
  put(root, "data/library/sites/ready/index.html", "<html><body>下一张可以截图</body></html>");
  assert.equal((await new PageScreenshot({ root }).screenshot({ path: "data/library/sites/ready" })).width, 390);
});
