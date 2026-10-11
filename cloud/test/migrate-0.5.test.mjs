import {testRoot} from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {migrate,convertBrief} from "../scripts/migrate-0.5.mjs";
import {validateBrief,listBriefs} from "../src/briefs.mjs";

const old=()=>({v:1,name:"晨报",time:"2026-10-11T07:30:00+08:00",cards:[{chip:"今天",title:"先做 A&B",summary:"保留 <所有> 内容",blocks:[
  {type:"timeline",items:[{when:"15:00",label:"交周报",text:"记得检查"}]},
  {type:"tiles",items:[{title:"天气",text:"有雨",tag:"带伞",tone:"warn"},{title:"路程",text:"地铁"}]},
  {type:"metrics",items:[{label:"睡眠",value:"6.5",unit:"小时",delta:"-0.8"}]},
  {type:"list",items:[{text:"取件",meta:"楼下"}]}],action:{label:"安排",prompt:"排 A&B"}},
  {chip:"状态",title:"连接情况",blocks:[{type:"note",text:"日历暂不可读"}]}]});

test("migration converts every JSON component, dry run is read only, apply backs up originals and reruns do nothing",()=>{
  const root=fs.mkdtempSync(path.join(testRoot,"migration-")), file=path.join(root,"data/briefs/2026-10-11/晨报.json");
  fs.mkdirSync(path.dirname(file),{recursive:true});const raw=JSON.stringify(old());fs.writeFileSync(file,raw);
  const schedule=path.join(root,"system/schedule.json");fs.mkdirSync(path.dirname(schedule));
  const jobs=[{id:"morning",prompt:"按简报格式写 JSON 到 data/briefs/<日期>/<任务名>.json。",cron:"30 7 * * *"},{id:"custom",prompt:"我的任务"}];
  fs.writeFileSync(schedule,JSON.stringify(jobs));
  const dry=migrate(root);assert.equal(dry.errors.length,0);assert.equal(dry.items.length,1);
  assert.equal(fs.readFileSync(file,"utf8"),raw);assert.equal(fs.existsSync(file.replace(/json$/,"html")),false);assert.equal(fs.existsSync(path.join(root,"backup")),false);
  const result=migrate(root,{apply:true,now:new Date("2026-10-11T09:00:00Z")});assert.equal(result.errors.length,0);
  assert.equal(fs.existsSync(file),false);assert.equal(fs.readFileSync(path.join(root,result.items[0].backup),"utf8"),raw);
  const html=fs.readFileSync(file.replace(/json$/,"html"),"utf8");assert.equal(validateBrief(html).error,undefined);
  for(const c of ["chip","title","summary","timeline","tile","tag","metric","list","note","button"]) assert.ok(html.includes(`class="${c}"`));
  assert.match(html,/A&amp;B/);assert.match(html,/&lt;所有&gt;/);assert.match(html,/data-prompt="排 A&amp;B"/);
  assert.equal(listBriefs(root,{now:new Date("2026-10-11T12:00:00Z")})[0].time,old().time);
  assert.equal(JSON.parse(fs.readFileSync(schedule))[1].prompt,"我的任务");assert.doesNotMatch(fs.readFileSync(schedule,"utf8"),/JSON|\.json/);
  const rerun=migrate(root,{apply:true});assert.deepEqual(rerun.items,[]);assert.equal(rerun.schedule,null);
});

test("migration preserves invalid JSON and conflicting HTML; exact generated HTML lets an interrupted migration finish",()=>{
  const root=fs.mkdtempSync(path.join(testRoot,"migration-conflict-")), dir=path.join(root,"data/briefs/2026-10-11");fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"bad.json"),"bad");fs.writeFileSync(path.join(dir,"conflict.json"),JSON.stringify(old()));fs.writeFileSync(path.join(dir,"conflict.html"),"keep");
  fs.writeFileSync(path.join(dir,"retry.json"),JSON.stringify(old()));fs.writeFileSync(path.join(dir,"retry.html"),convertBrief(old()));
  fs.symlinkSync(path.join(dir,"retry.html"),path.join(dir,"linked.json"));
  const report=migrate(root,{apply:true});assert.equal(report.errors.length,2);assert.equal(report.items.length,1);
  assert.equal(fs.readFileSync(path.join(dir,"conflict.html"),"utf8"),"keep");assert.equal(fs.existsSync(path.join(dir,"bad.json")),true);assert.equal(fs.existsSync(path.join(dir,"retry.json")),false);
});
