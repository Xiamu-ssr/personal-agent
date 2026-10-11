import {testRoot} from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
import {validateBrief,readBrief,listBriefs,isOutputPath} from "../src/briefs.mjs";
import {Harness} from "../src/agent.mjs";
import {DeviceHub} from "../src/devices.mjs";
import {config} from "../src/config.mjs";

const minimal=(title="今天先交周报",time="2026-10-11T07:30:00+08:00")=>`<meta name="brief-name" content="晨报"><meta name="brief-time" content="${time}"><section class="card"><span class="chip">10月11日</span><h1 class="title">${title}</h1><button data-prompt="帮我排今天的事">排顺序</button></section>`;

test("1–6 HTML cards become complete independent offline documents with shared and custom styles",()=>{
  const result=validateBrief('<style>.custom {color:var(--accent)} @keyframes pulse {to {opacity:.8}}</style>'+minimal()+'<section class="card" data-palette="mint"><p class="custom">第二张</p></section>');
  assert.equal(result.error,undefined);assert.equal(result.brief.cards.length,2);
  for(const {html} of result.brief.cards) {
    assert.match(html,/^<!doctype html>/);assert.match(html,/--accent/);assert.match(html,/\.custom/);
    assert.equal((html.match(/<section /g)||[]).length,1);assert.match(html,/Content-Security-Policy/);
    assert.match(html,/doudou:\/\/prompt\?text=/);assert.match(html,/script-src 'sha256-/);
  }
  assert.equal(validateBrief('<section class="card">一张</section>'.repeat(6)).error,undefined);
  assert.match(validateBrief('<section class="card">一张</section>'.repeat(7)).error,/1–6/);
  assert.match(validateBrief('<div><section class="card">卡片</section></div>').error,/顶层/);
  assert.match(validateBrief('<section class="card"><section class="card">嵌套</section></section>').error,/不能嵌套/);
});

test("validation rejects resources, scripts, oversize files and clearly tall content in Chinese",()=>{
  for(const source of ['<img src="https://example.test/x">','<a href="http&#58;//example.test">外链</a>',
    '<svg><image href="//example.test/x"/></svg>','<style>.x{background:url(https://example.test/x)}</style>',
    '<style>@import "x.css";</style>','<style>.x{background:u\\72l(https://example.test/x)}</style>',
    '<script>fetch("https://example.test")</script>','<button onclick="fetch(1)">按</button>']) {
    assert.match(validateBrief(`<section class="card">${source}</section>`).error,/外部|脚本|事件/);
  }
  assert.equal(validateBrief('<section class="card"><img src="data:image/png;base64,AA=="><svg><use href="#shape"/></svg></section>').error,undefined);
  assert.match(validateBrief(minimal("文".repeat(600))).error,/内容过高.*560px/);
  assert.match(validateBrief('<section class="card">'+"文".repeat(30_000)+'</section>').error,/80KB/);
  assert.match(validateBrief('<section class="card" style="min-height:900px">长</section>').error,/内容过高/);
});

test("button bridge URL-encodes the user's original text and ignores unrelated clicks",()=>{
  const source=fs.readFileSync(new URL("../src/brief-button.js",import.meta.url),"utf8");
  let click;const window={location:{href:""}};
  vm.runInNewContext(source,{window,document:{addEventListener:(_,fn)=>{click=fn;}}});
  click({target:{closest:()=>null}});assert.equal(window.location.href,"");
  const prompt="把 A&B 安排到明天？\n再提醒我";let prevented=false;
  click({preventDefault:()=>{prevented=true;},target:{closest:()=>({getAttribute:()=>prompt})}});
  assert.equal(prevented,true);assert.equal(window.location.href,"doudou://prompt?text="+encodeURIComponent(prompt));
});

test("listing reads only valid HTML, sorts timestamps, respects local days, ignores JSON and symlinks",()=>{
  const root=fs.mkdtempSync(path.join(testRoot,"brief-list-"));
  const put=(rel,body)=>{const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);return file;};
  put("data/briefs/2026-10-11/morning.html",minimal());
  put("data/briefs/2026-10-11/evening.html",minimal("收尾","2026-10-11T21:30:00+08:00"));
  put("data/briefs/2026-10-05/boundary.html",minimal("边界","2026-10-05T07:30:00+08:00"));
  put("data/briefs/2026-10-04/old.html",minimal());
  put("data/briefs/2026-10-11/old.json",'{}');put("data/briefs/2026-10-11/bad.html","bad");
  const outside=put("outside.html",minimal());fs.symlinkSync(outside,path.join(root,"data/briefs/2026-10-11/symlink.html"));
  const result=listBriefs(root,{now:new Date("2026-10-11T12:00:00Z")});
  assert.deepEqual(result.map((i)=>path.basename(i.path)),["evening.html","morning.html","boundary.html"]);
  assert.ok(result.every((i)=>i.cards[0].html&&!("brief"in i)));
  assert.ok(readBrief(root,"data/briefs/2026-10-11/symlink.html").error);
  assert.ok(readBrief(root,"data/briefs/2026-10-11/old.json").error);
  assert.equal(isOutputPath("data/briefs/2026-10-11/morning.html"),true);
  assert.equal(isOutputPath("data/briefs/2026-10-11/old.json"),false);
});

test("PostToolUse validates main/fork/isolated HTML writes, removes invalid outputs, and rejects JSON writes",async()=>{
  const events=[];const h=new Harness({hub:new DeviceHub(),bus:{emit:(e)=>events.push(e)},log(){}});
  for(const isolated of [false,true]) {
    const outputs=new Set(), rel=`data/briefs/2026-10-11/hook-${isolated}.html`, file=path.join(config.root,rel);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const options=h.options({isolated,onWrite:(r,input,valid)=>valid?outputs.add(r):outputs.delete(r)});
    const hook=options.hooks.PostToolUse[0].hooks[0];
    try {
      for(const agent_id of [undefined,"local-child"]) {
        fs.writeFileSync(file,minimal("文".repeat(600)));
        assert.match((await hook({tool_input:{file_path:file},agent_id})).reason,/简报校验失败.*内容过高/);
        assert.equal(outputs.size,0);fs.writeFileSync(file,minimal());
        assert.deepEqual(await hook({tool_input:{file_path:file},agent_id}),{});assert.ok(outputs.has(rel));
      }
      assert.equal(h.checkWrite({tool_input:{file_path:"data/briefs/2026-10-11/old.json"}}).hookSpecificOutput.permissionDecision,"deny");
    } finally {for(const server of Object.values(options.mcpServers)) await server.instance.close();}
  }
});
