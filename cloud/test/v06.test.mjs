import {testRoot} from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import {once} from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import {parseDocument} from "htmlparser2";
import chineseDays from "chinese-days";
import {validateBrief,estimateCardHeight,briefItem} from "../src/briefs.mjs";
import {TaskHistory,paginateJobs} from "../src/task-history.mjs";
import {Harness} from "../src/agent.mjs";
import {DeviceHub} from "../src/devices.mjs";
import {HealthSync,mergeHealthDays} from "../src/health.mjs";
import {migrateV06} from "../src/migrate-v06.mjs";
import {checkDataAccess,MANAGED_SKILL_MARKER} from "../src/data-guard.mjs";
import {calendarContext} from "../src/calendar-context.mjs";
import {DEFAULT_SETTINGS,readAppSettings} from "../src/app-settings.mjs";
import {MODEL_PRICES,estimateUsageCost} from "../src/usage-pricing.mjs";
import {validateMessage} from "../src/attachments.mjs";
import {startServer} from "../src/server.mjs";
import {runScheduledTask} from "../src/scheduler.mjs";
import {config,CODE} from "../src/config.mjs";
import {compareCard,stepsCard} from "./v06-fixtures.mjs";

const rootFor=(name)=>fs.mkdtempSync(path.join(testRoot,name+"-"));
const put=(root,rel,body)=>{const f=path.join(root,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,typeof body==="string"||Buffer.isBuffer(body)?body:JSON.stringify(body));return f;};
const row=(type,time,content,rest={})=>({type,timestamp:time,message:{content},...rest});
const guide=fs.readFileSync(path.join(CODE,"../spec/prompts/brief-guide.md"),"utf8");
export const guideExample=guide.match(/```html\n([\s\S]*?)```/)[1];

test("v0.6 guide, three-column six-row comparison and steps pass; horizontal groups share height; >960px and >240 elements fail",()=> {
  for(const html of [guideExample,compareCard,stepsCard])assert.equal(validateBrief(html).error,undefined);
  for(const cls of ["dates","tiles","metrics"]) {
    const child=cls==="dates"?"day":cls==="tiles"?"tile":"metric";
    const one=estimateCardHeight(parseDocument(`<div class="${cls}"><div class="${child}">数据</div></div>`).children[0]);
    const three=estimateCardHeight(parseDocument(`<div class="${cls}">${`<div class="${child}">数据</div>`.repeat(3)}</div>`).children[0]);
    assert.ok(three<one*2,`${cls} should not multiply height by children`);
  }
  assert.equal(validateBrief('<section class="card" style="height:800px">一张中等高度的卡片</section>').error,undefined);
  assert.match(validateBrief('<section class="card" style="height:1000px">超高</section>').error,/上限约 960px/);
  assert.match(validateBrief(`<section class="card">${"<p>步骤文字</p>".repeat(50)}</section>`).error,/上限约 960px/);
  assert.match(validateBrief(`<section class="card">${"<span>字</span>".repeat(241)}</section>`).error,/元素/);
  assert.equal(validateBrief('<section class="card" style="height:1200px">历史卡片</section>',{height:false}).error,undefined);
});

test("startup backfills subagents only once, infers result status and paginates all history beyond 50 with stable timestamp ties",()=> {
  const root=rootFor("backfill"),sessions=path.join(root,"system/sessions"),rel="system/sessions/projects/fixture/session-old/subagents/agent-old.jsonl";
  const title="整理耳机对比\n保留参数、佩戴和价格来源";
  put(root,rel,[row("user","2026-10-01T01:00:00Z",title),row("assistant","2026-10-01T01:00:02Z",[{type:"text",text:"结果"}]),{type:"result",subtype:"success",timestamp:"2026-10-01T01:00:03Z"}].map((r)=>JSON.stringify(r)).join("\n"));
  put(root,rel.replace('agent-old','agent-failed'),JSON.stringify(row("user","2026-10-01T02:00:00Z","失败任务"))+"\n"+JSON.stringify({type:"result",subtype:"error_during_execution",timestamp:"2026-10-01T02:01:00Z"}));
  const h=new TaskHistory({root,sessions,redact:(s)=>s});assert.equal(h.get("old").title,title.replace("\n"," "));assert.equal(h.get("old").sessionId,"session-old");assert.equal(h.get("old").startedAt,Date.parse("2026-10-01T01:00:00Z"));assert.equal(h.get("failed").status,"error");
  h.put("old",{title:"用户自定标题"});const reloaded=new TaskHistory({root,sessions,redact:(s)=>s});assert.equal(reloaded.get("old").title,"用户自定标题");
  for(let i=0;i<80;i++)h.put("task"+i,{status:"done",startedAt:1000+i,endedAt:2000+i});
  assert.equal(h.recent().length,82);const ids=[];let before;
  do{const page=paginateJobs(h.recent(),{before,limit:13});ids.push(...page.recent.map((i)=>i.id));before=page.next??undefined;if(page.next===null)break;}while(before);
  assert.equal(ids.length,82);assert.equal(new Set(ids).size,82);
  const tied=paginateJobs([{id:"a",ts:10},{id:"b",ts:10},{id:"c",ts:9}],{limit:1});assert.deepEqual(tied.recent.map((i)=>i.id),["a","b"]);assert.equal(tied.next,10);
  const history=h.history("old");assert.equal(history.items[0].from,"agent");
});

test("restart continuation runs in an isolated background query with old instructions, steps/result and real image blocks under the original id",async()=> {
  const events=[],inputs=[],calls=[];
  const h=new Harness({hub:new DeviceHub(),bus:{emit:(e)=>events.push(e)},log(){},queryFactory:({prompt,options})=> {
    calls.push(options);
    return {close(){for(const s of Object.values(options.mcpServers))s.instance.close().catch(()=>{});},async *[Symbol.asyncIterator]() {
      inputs.push((await prompt[Symbol.asyncIterator]().next()).value);
      yield {type:"system",subtype:"init",session_id:"continued-local-session"};
      yield {type:"assistant",message:{content:[{type:"text",text:"续聊已经完成"}]}};
      yield {type:"result",subtype:"success"};
    }};
  }});
  const id="old-native",rel="system/sessions/projects/fixture/original-session/subagents/agent-old-native.jsonl";
  put(config.root,rel,[row("user","2026-10-01T01:00:00Z","原任务交代：对比耳机"),row("assistant","2026-10-01T01:01:00Z",[{type:"tool_use",id:"read",name:"Read",input:{file_path:"data/memory/preferences/耳机.md"}},{type:"text",text:"原结果：轻量款更合适"}])].map((r)=>JSON.stringify(r)).join("\n"));
  h.history.put(id,{title:"耳机对比",kind:"subagent",sessionId:"original-session",status:"done",startedAt:Date.parse("2026-10-01T01:00:00Z")});
  const image="data/uploads/2026-10-12/fixture.png",file="data/uploads/2026-10-12/fixture.txt";
  put(config.root,image,Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv1cAAAAASUVORK5CYII=","base64"));
  put(config.root,file,"耳机资料");const attachments=[{path:image,name:"耳机.png",kind:"image"},{path:file,name:"参数.txt",kind:"file"}];
  assert.equal(await h.sendTask(id,"再看这张图",attachments),id);await h.jobChain;
  assert.equal(calls.length,1);assert.equal(calls[0].resume,undefined);assert.equal(inputs[0].message.content[1].type,"image");
  assert.match(inputs[0].message.content[0].text,/原任务交代：对比耳机/);assert.match(inputs[0].message.content[0].text,/读取 data\/memory\/preferences\/耳机.md/);assert.match(inputs[0].message.content[0].text,/原结果：轻量款更合适/);
  assert.equal(h.history.get(id).status,"done");assert.equal(events.find((e)=>e.phase==="done").id,id);
  const history=h.taskHistory(id);assert.equal(history.items[0].from,"agent");const user=history.items.find((i)=>i.from==="user");assert.equal(user.text,"再看这张图");assert.deepEqual(user.attachments,attachments.map((a)=>({...a,size:fs.statSync(path.join(config.root,a.path)).size})));assert.ok(history.items.some((i)=>i.text==="续聊已经完成"));
  assert.ok(!history.items.some((i)=>i.text.startsWith("[任务续聊上下文]")));
  await h.sendTask(id,"",[{path:file,name:"参数.txt",kind:"file"}]);await h.jobChain;assert.equal(h.taskHistory(id).items.filter((i)=>i.from==="user").length,2);
  await assert.rejects(h.sendTask(id,"",[]),(e)=>e.status===400);
});

test("message attachment validation is shared, rejects traversal/symlinks/kinds and allows empty text with uploads",()=> {
  const root=rootFor("attachments"),rel="data/uploads/2026-10-12/a.txt";put(root,rel,"file");
  assert.equal(validateMessage(root,"",[{path:rel,name:"文件",kind:"file"}]).attachments.length,1);
  assert.throws(()=>validateMessage(root,"",[]),/同时为空/);
  for(const a of [{path:"data/uploads/../../system/a",kind:"file"},{path:rel,kind:"bad"},{path:rel,kind:"image"}])assert.throws(()=>validateMessage(root,"文本",[a]));
  const secret=put(root,"system/private.txt","PRIVATE");fs.symlinkSync(secret,path.join(root,"data/uploads/link.txt"));assert.throws(()=>validateMessage(root,"文本",[{path:"data/uploads/link.txt",kind:"file"}]),/附件必须/);
});

test("health merges partial readings, rounds numeric values, keeps 90 days, fills seven API days and reads all weekly briefs/records",async()=> {
  const root=rootFor("health"),clock=()=>new Date("2026-10-12T10:00:00Z"),calls=[];
  const hub={online:()=>[{id:"phone",name:"假手机",capabilities:["health"]}],call:async(_id,_cap,args)=>{calls.push(args);return {items:args.from==="2026-10-12"?[{date:"2026-10-12",steps:1200.7}]:[{date:"2026-10-11",sleep_minutes:425.8,resting_heart_rate_bpm:62.4,hrv_ms:43.5,steps:7654.2}]};}};
  const sync=new HealthSync({root,hub,clock});put(root,"data/health/days.json",{syncedAt:null,device:null,days:[{date:"2026-10-11",hrv:40,steps:1},{date:"2026-06-01",steps:2000}]});
  const report=`<section class="card"><h1 class="title">睡眠比上周更稳定</h1></section>`;
  put(root,"data/briefs/2026-09-20/健康周报.html",report);put(root,"data/briefs/2026-10-12/健康周报.html",report);
  put(root,"data/memory/health/睡眠.md","更新：2026-10-10\n\n# 睡眠记录\n- **昨晚睡了 7 小时**\n- [步行](data) 5000 步\n- 不显示第三条\n");
  const view=await sync.sync();assert.deepEqual(calls,[{from:"2026-10-05",days:7},{from:"2026-10-12",days:1}]);assert.equal(view.days.length,7);assert.equal(view.days.at(-1).date,"2026-10-12");assert.equal(view.days.at(-1).steps,1201);assert.equal(view.days.at(-2).sleepMinutes,426);assert.equal(view.days.at(-2).hrv,44);
  assert.equal(view.weekly.length,2);assert.equal(view.weekly[0].range,"10月6日–10月12日");assert.equal(view.weekly[0].summary,"睡眠比上周更稳定");assert.equal(view.records[0].preview,"昨晚睡了 7 小时\n步行 5000 步");
  const store=JSON.parse(fs.readFileSync(sync.file));assert.equal(store.days.length,2);
  assert.equal(mergeHealthDays(store.days,[{date:"2026-10-11",steps:8000}],"2026-10-12")[0].sleepMinutes,426);
  hub.online=()=>[];const offline=await sync.sync();assert.match(offline.note,/不在线/);assert.equal(offline.syncedAt,view.syncedAt);assert.deepEqual(offline.days,view.days);
  let usedModel=false;assert.equal(await runScheduledTask({send(){usedModel=true;},runIsolated(){usedModel=true;}},{kind:"health-sync"},{health:sync}),"health-sync");assert.equal(usedModel,false);
});

test("health sync uses a shared 20-second budget, deduplicates concurrent sync and explains disabled capability",async()=> {
  const root=rootFor("health-timeout");let count=0;
  const sync=new HealthSync({root,timeoutMs:25,hub:{online:()=>[{id:"phone",capabilities:["health"]}],call:()=>{count++;return new Promise(()=>{});}}});
  const [a,b]=await Promise.all([sync.sync(),sync.sync()]);assert.equal(count,1);assert.match(a.note,/超时/);assert.deepEqual(a,b);
  const disabled=new HealthSync({root,hub:{online:()=>[{id:"phone",capabilities:[]}]}});assert.match((await disabled.sync()).note,/没有开启/);
});

test("health and managed skills are read-only through hooks, including symlink and Bash mutations",()=> {
  const root=rootFor("protected");put(root,"data/health/days.json",{});put(root,".claude/skills/wind-mcp-skill/"+MANAGED_SKILL_MARKER,{connector:"wind"});
  fs.symlinkSync(path.join(root,"data/health"),path.join(root,"alias"));
  for(const file of ["data/health/days.json","alias/days.json",".claude/skills/wind-mcp-skill/SKILL.md"])for(const name of ["Write","Edit"])assert.equal(checkDataAccess({tool_name:name,tool_input:{file_path:file}},{root}).hookSpecificOutput.permissionDecision,"deny");
  for(const cmd of ["rm data/health/days.json","echo 1 > data/health/days.json","python3 -c \"open('data/health/days.json','w')\"","rm -rf data","sed -i '' s/a/b/ data/health/days.json","rm .claude/skills/wind-mcp-skill/SKILL.md"])assert.equal(checkDataAccess({tool_name:"Bash",tool_input:{command:cmd}},{root}).hookSpecificOutput.permissionDecision,"deny");
  for(const input of [{tool_name:"Read",tool_input:{file_path:"data/health/days.json"}},{tool_name:"Bash",tool_input:{command:"cat data/health/days.json"}},{tool_name:"Write",tool_input:{file_path:"data/memory/health/睡眠.md"}},{tool_name:"Edit",tool_input:{file_path:".claude/skills/wind-own/SKILL.md"}}])assert.deepEqual(checkDataAccess(input,{root}),{});
});

test("startup migrations delete obsolete health metrics, append only speaking habits, migrate unknown models and add missing sync without changing other schedules",()=> {
  const root=rootFor("migration"),original="更新：2026-01-01\n\n# 角色\n- 现有习惯一个字不改。\n";
  put(root,"data/memory/role/角色.md",original);put(root,"data/memory/health/latest.json",{});
  const custom={id:"custom",cron:"0 5 * * *",prompt:"自定内容",extra:42};put(root,"system/schedule.json",[custom]);put(root,"system/app-settings.json",{model:"xiaomi/mimo-v2.6-pro",permissionMode:"bypassPermissions"});
  const opts={root,seedDir:path.join(CODE,"seed"),now:new Date("2026-10-12T01:00:00Z")};migrateV06(opts);
  const role=fs.readFileSync(path.join(root,"data/memory/role/角色.md"),"utf8");assert.ok(role.startsWith(original.replace("2026-01-01","2026-10-12")));assert.match(role,/## 说话习惯\n- 结论先行/);assert.equal(fs.existsSync(path.join(root,"data/memory/health/latest.json")),false);
  const jobs=JSON.parse(fs.readFileSync(path.join(root,"system/schedule.json")));assert.deepEqual(jobs[0],custom);assert.equal(jobs[1].kind,"health-sync");assert.equal(readAppSettings(root).model,DEFAULT_SETTINGS.model);assert.equal(readAppSettings(root).permissionMode,"bypassPermissions");
  migrateV06({...opts,now:new Date("2026-10-13T01:00:00Z")});assert.equal(fs.readFileSync(path.join(root,"data/memory/role/角色.md"),"utf8"),role);assert.equal(JSON.parse(fs.readFileSync(path.join(root,"system/schedule.json"))).length,2);
  assert.deepEqual(MODEL_PRICES["z-ai/glm-5.3-flash"],{input:.15,cacheRead:.03,output:.5});assert.equal(estimateUsageCost("z-ai/glm-5.3-flash",{input_tokens:1_000_000,cache_read_input_tokens:1_000_000,output_tokens:1_000_000}),.68);assert.throws(()=>estimateUsageCost("xiaomi/mimo-v2.6-pro",{}));
});

test("calendar uses package lunar/holiday/shift dates and only mentions the day's solar term",()=> {
  const context=(date)=>calendarContext({now:new Date(date+"T04:00:00Z")});
  const national=context("2026-10-01");assert.match(national,/农历八月廿一/);assert.match(national,/法定节假日（国庆节）/);assert.equal(national.split("\n").length,2);
  const shifted=context("2026-10-10");assert.equal(chineseDays.getDayDetail("2026-10-10").work,true);assert.match(shifted,/调休上班（国庆节）/);assert.match(context("2026-10-09"),/10月10日 调休上班/);
  const term=chineseDays.getSolarTerms("2026-10-01","2026-10-31")[0];assert.match(context(term.date),new RegExp(term.name));assert.ok(!context("2026-10-01").includes(term.name));assert.match(context("2026-10-11"),/周末/);assert.match(context("2026-10-12"),/工作日/);
});

test("upcoming calendar merges consecutive same-kind holidays, keeps shifted workdays separate and formats single days and cross-month ranges",()=> {
  const future=(date)=>calendarContext({now:new Date(date+"T04:00:00Z")}).split("\n")[1];
  assert.equal(future("2026-09-30"),"未来7天：10月1日–7日 国庆节放假");
  assert.equal(future("2026-10-05"),"未来7天：10月6日–7日 国庆节放假、10月10日 调休上班（国庆节）");
  assert.equal(future("2026-10-06"),"未来7天：10月7日 国庆节放假、10月10日 调休上班（国庆节）");
  assert.equal(future("2026-10-09"),"未来7天：10月10日 调休上班（国庆节）");
  assert.equal(future("2022-01-30"),"未来7天：1月31日–2月6日 春节放假");
  assert.equal(future("2026-10-12"),"未来7天：无节假日或调休");
});

test("authenticated brief item, paginated jobs, attachments and health HTTP contracts use local files and mocks",async(t)=> {
  const old="data/briefs/2026-01-01/旧周报.html";put(config.root,old,compareCard);
  const records=Array.from({length:81},(_,i)=>({id:"job"+i,title:"任务",label:"任务",status:"done",ok:true,ts:1000+i,outputs:[]}));
  const sent=[],health=new HealthSync({root:config.root,hub:{online:()=>[]}}),harness={connectors:new (await import("../src/connectors.mjs")).ConnectorManager(),recentJobs:()=>records,runningJobs:()=>[{id:"running",label:"进行中"}],sendTask:async(...args)=>sent.push(args),send:async(...args)=>{sent.push(args);return "msg";}};
  const server=startServer({harness,hub:new DeviceHub(),health,bus:{on(){}},log(){},listen:{host:"127.0.0.1",port:0}});await once(server,"listening");t.after(async()=>{server.closeAllConnections();await new Promise((r)=>server.close(r));});
  const req=async(route,method="GET",body,auth=true)=>{const r=await fetch("http://127.0.0.1:"+server.address().port+route,{method,headers:{...(auth&&{Authorization:"Bearer "+config.token}),"Content-Type":"application/json"},...(body!==undefined&&{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
  const item=await req("/api/briefs/item?path="+encodeURIComponent(old));assert.equal(item.status,200);assert.equal(item.body.date,"2026-01-01");assert.ok(item.body.cards[0].html.startsWith("<!doctype"));assert.equal(briefItem(config.root,old).name,"旧周报");
  for(const p of ["data/sites/site/index.html","data/briefs/2026-01-01/../missing.html","data/briefs/2026-01-01/no.html"])assert.equal((await req("/api/briefs/item?path="+encodeURIComponent(p))).status,404);
  assert.equal((await req("/api/health","GET",undefined,false)).status,401);
  assert.equal((await req("/api/health")).body.days.length,7);assert.match((await req("/api/health/sync","POST")).body.note,/不在线/);
  const first=(await req("/api/jobs")).body;assert.equal(first.recent.length,30);assert.equal(first.next,1051);assert.equal(first.running.length,1);
  const second=(await req("/api/jobs?before="+first.next+"&limit=40")).body;assert.equal(second.recent.length,40);assert.equal(second.running.length,0);const last=(await req("/api/jobs?before="+second.next)).body;assert.equal(last.recent.length,11);assert.equal(last.next,null);
  for(const q of ["limit=0","limit=101","before=bad","before=0","limit=1.5"])assert.equal((await req("/api/jobs?"+q)).status,400);
  const upload="data/uploads/2026-10-12/http.txt";put(config.root,upload,"file");const att={path:upload,name:"http.txt",kind:"file"};
  assert.deepEqual((await req("/api/tasks/job1/send","POST",{attachments:[att]})).body,{ok:true,id:"job1"});assert.deepEqual(sent.at(-1),["job1","",[{...att,size:fs.statSync(path.join(config.root,upload)).size}]]);
  assert.equal((await req("/api/send","POST",{attachments:[att]})).status,200);
  for(const route of ["/api/tasks/job1/send","/api/send"])assert.equal((await req(route,"POST",{text:"bad",attachments:[{path:"system/private",kind:"file"}]})).status,400);
});

test("health startup migration fails closed for a damaged schedule and readonly programmatic health reads remain available",()=> {
  const root=rootFor("migration-damaged"),file=put(root,"system/schedule.json","bad JSON");
  assert.throws(()=>migrateV06({root,seedDir:path.join(CODE,"seed")}),/未覆盖原配置/);assert.equal(fs.readFileSync(file,"utf8"),"bad JSON");
  assert.deepEqual(checkDataAccess({tool_name:"Bash",tool_input:{command:'python3 -c "import json; print(json.load(open(\'data/health/days.json\')))"'}},{root}),{});
});

test("running jobs include native tasks, and attachment continuation stops the original worker before the isolated query writes",async()=> {
  let stopped=false,started=false;const id="v06-active-attachment";
  const h=new Harness({hub:new DeviceHub(),bus:{emit(){}},log(){},queryFactory:({prompt,options})=>({
    close(){for(const s of Object.values(options.mcpServers))s.instance.close().catch(()=>{});},async *[Symbol.asyncIterator](){assert.equal(stopped,true);started=true;await prompt[Symbol.asyncIterator]().next();yield {type:"system",subtype:"init",session_id:"isolated-after-stop"};yield {type:"assistant",message:{content:[{type:"text",text:"续聊完成"}]}};yield {type:"result",subtype:"success"};}})});
  h.main={sessionId:"native-active",tasks:{list:()=>stopped?[]:[{id,description:"原任务",startedAt:1}],running:()=>({id})},q:{stopTask:async(taskId)=>{assert.equal(taskId,id);stopped=true;}}};
  h.history.put(id,{kind:"subagent",sessionId:"native-active",title:"原任务",status:"running"});assert.equal(h.runningJobs()[0].id,id);
  const rel="data/uploads/2026-10-12/v06-active.txt";put(config.root,rel,"附件");await h.sendTask(id,"继续",[{path:rel,name:"附件",kind:"file"}]);await h.jobChain;
  assert.equal(started,true);assert.equal(h.history.get(id).status,"done");assert.equal(h.history.get(id).kind,"isolated");
});

test("history keeps the original agent prompt when a user repeats it, and does not label followups as agent after an archived transcript disappears",()=> {
  const root=rootFor("history-from"),sessions=path.join(root,"system/sessions"),h=new TaskHistory({root,sessions,redact:(s)=>s});
  const rel="system/sessions/projects/fixture/original/subagents/agent-repeat.jsonl";put(root,rel,[row("user","2026-10-01T01:00:00Z","再查一遍"),row("user","2026-10-02T01:00:00Z","再查一遍")].map((r)=>JSON.stringify(r)).join("\n"));
  h.put("repeat",{kind:"subagent",sessionId:"original",status:"done"});h.rememberPrompt("repeat","再查一遍");assert.deepEqual(h.history("repeat").items.filter((i)=>i.kind==="prompt").map((i)=>i.from),["agent","user"]);
  put(root,"system/sessions/projects/fixture/continued.jsonl",JSON.stringify(row("user","2026-10-02T01:00:00Z","继续查")));
  h.put("missing",{kind:"isolated",sessionId:"continued",continuation:true,instruction:"原任务真实交代",status:"done",startedAt:Date.parse("2026-10-01T01:00:00Z")});h.rememberPrompt("missing","继续查");
  const prompts=h.history("missing").items.filter((i)=>i.kind==="prompt");assert.equal(prompts[0].from,"agent");assert.equal(prompts[0].text,"原任务真实交代");assert.equal(prompts[1].from,"user");
});
