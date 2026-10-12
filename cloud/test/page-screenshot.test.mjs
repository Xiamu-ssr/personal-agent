import {testRoot} from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import {once} from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {PageScreenshot,screenshotTarget,browserExecutable} from "../src/page-screenshot.mjs";
import {compareCard,stepsCard} from "./v06-fixtures.mjs";

const put=(root,rel,body)=>{const f=path.join(root,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,body);return f;};
test("page screenshot path limits are enforced before browser launch, including traversal and symlink escape; no browser gives Chinese reason",async()=> {
  const root=fs.mkdtempSync(path.join(testRoot,"screens-path-"));put(root,"data/briefs/2026-10-12/a.html",compareCard);put(root,"data/sites/demo/index.html","<html><body>本地站点</body></html>");
  assert.equal(screenshotTarget(root,"data/sites/demo").rel,"data/sites/demo/index.html");assert.equal(screenshotTarget(root,"data/briefs/2026-10-12/a.html").brief,true);
  const outside=put(root,"system/private.html","私人内容");fs.symlinkSync(outside,path.join(root,"data/sites/demo/escape.html"));
  for(const rel of ["https://example.test","system/private.html","data/briefs/2026-10-12/../../system/private.html","data/sites/demo/escape.html","data/sites/demo/file.js","/data/sites/demo/index.html"])assert.throws(()=>screenshotTarget(root,rel));
  const pages=new PageScreenshot({root,executablePath:"/missing-browser-for-local-test"});await assert.rejects(pages.screenshot({path:"data/briefs/2026-10-12/a.html"}),/页面截图暂不可用/);
});

test("local Chrome screenshots have bounded JPEG size, skin colors, no card blank screens, block external HTTP/WebSocket and only serve local site assets",{timeout:30_000,skip:!browserExecutable()},async(t)=> {
  const root=fs.mkdtempSync(path.join(testRoot,"screens-browser-"));put(root,"data/briefs/2026-10-12/a.html",compareCard+stepsCard);
  const pages=new PageScreenshot({root});const first=pages.screenshot({path:"data/briefs/2026-10-12/a.html",skin:"night"});await assert.rejects(pages.screenshot({path:"data/briefs/2026-10-12/a.html"}),/正在截图/);const image=await first;
  assert.equal(image.width,390);assert.ok(image.height<1400);assert.ok(image.data.length<=300*1024);assert.equal((await sharp(image.data).metadata()).format,"jpeg");
  const color=await sharp(image.data).extract({left:180,top:0,width:1,height:1}).raw().toBuffer();assert.ok(color[0]<70&&color[1]<70&&color[2]<70);
  let requests=0;const external=http.createServer((_q,r)=>{requests++;r.end("外部内容");});external.on("upgrade",(_req,socket)=>{requests++;socket.destroy();});external.listen(0,"127.0.0.1");await once(external,"listening");t.after(()=>external.close());
  const port=external.address().port;
  put(root,"data/sites/demo/index.html",`<!doctype html><html><head><link rel="stylesheet" href="local.css"></head><body><h1>本地站点</h1><img src="http://127.0.0.1:${port}/image"><script>fetch('http://127.0.0.1:${port}/fetch');new WebSocket('ws://127.0.0.1:${port}/socket');fetch('file://${root}/system/private.html');</script></body></html>`);
  put(root,"data/sites/demo/local.css","body{margin:0;background:rgb(20,100,150);height:3000px}");put(root,"system/private.html","绝不能读取");
  const site=await pages.screenshot({path:"data/sites/demo"});assert.equal(requests,0);assert.equal(site.height,844*3);const pixel=await sharp(site.data).extract({left:380,top:100,width:1,height:1}).raw().toBuffer();assert.ok(Math.abs(pixel[0]-20)<12&&Math.abs(pixel[1]-100)<12&&Math.abs(pixel[2]-150)<12,`local CSS loaded: ${pixel}`);
});

test("screenshot timeout closes its browser and releases the single-call slot",{timeout:40_000,skip:!browserExecutable()},async()=> {
  const root=fs.mkdtempSync(path.join(testRoot,"screens-timeout-"));put(root,"data/sites/hang/index.html","<html><body>等待重绘<script>while(true){}</script></body></html>");
  const pages=new PageScreenshot({root,timeoutMs:2000});await assert.rejects(pages.screenshot({path:"data/sites/hang"}),/截图超时|Timeout/);
  put(root,"data/briefs/2026-10-12/ready.html",'<section class="card"><h1 class="title">下一张可以截图</h1></section>');
  const after=await new PageScreenshot({root}).screenshot({path:"data/briefs/2026-10-12/ready.html"});assert.equal(after.width,390);assert.ok(after.height<300);
});

test("all twelve skin/palette combinations have readable variables, paper title font and picked table column, without horizontal overflow at 320px",{timeout:15_000,skip:!browserExecutable()},async()=> {
  const {chromium}=await import("playwright-core"),{cardDocument}=await import("../src/briefs.mjs");
  const browser=await chromium.launch({executablePath:browserExecutable(),headless:true});
  try {
    const page=await browser.newPage({viewport:{width:320,height:700}});
    for(const skin of ["silver","paper","night"])for(const palette of ["silver","mist","mint","dusk"]) {
      const html=cardDocument(compareCard.replace('data-palette="mist"',`data-palette="${palette}"`)).replace('<html lang="zh-CN">',`<html lang="zh-CN" data-skin="${skin}">`);
      await page.setContent(html);const style=await page.evaluate(()=> {
        const card=document.querySelector(".card"),css=getComputedStyle(card);
        return {vars:Object.fromEntries(["ink","muted","surface","tile","line","accent","accent-soft","gold","ok","warn","info","button-ink"].map((v)=>[v,css.getPropertyValue("--"+v).trim()])),
          surface:css.backgroundColor,titleFont:getComputedStyle(document.querySelector(".title")).fontFamily,numeric:getComputedStyle(document.body).fontVariantNumeric,
          picked:getComputedStyle(document.querySelector(".compare tr:nth-child(2) td:nth-child(2)")).backgroundColor,other:getComputedStyle(document.querySelector(".compare tr:nth-child(2) td:nth-child(3)")).backgroundColor,overflow:document.documentElement.scrollWidth>innerWidth};
      });
      assert.ok(Object.values(style.vars).every(Boolean));assert.equal(style.numeric,"tabular-nums");assert.equal(style.overflow,false);assert.notEqual(style.picked,style.other);
      if(skin==="night")assert.ok(style.surface.match(/\d+/g).slice(0,3).every((n)=>Number(n)<60));
      if(skin==="paper")assert.match(style.titleFont,/Songti SC/);
    }
  } finally{await browser.close();}
});
