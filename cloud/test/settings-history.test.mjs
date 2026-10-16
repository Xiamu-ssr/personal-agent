import {testRoot} from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {once} from "node:events";
import {getAppSettings,putAppSettings,readAppSettings,DEFAULT_SETTINGS,MODELS} from "../src/app-settings.mjs";
import {TaskHistory} from "../src/task-history.mjs";
import {ConnectorManager} from "../src/connectors.mjs";
import {DeviceHub} from "../src/devices.mjs";
import {startServer} from "../src/server.mjs";
import {config} from "../src/config.mjs";

test("settings defaults, partial updates, persisted private file and strict validation ignore obsolete env choices",()=>{
  const root=fs.mkdtempSync(path.join(testRoot,"settings-"));
  const value=getAppSettings(root);assert.deepEqual(value.model,DEFAULT_SETTINGS.model);assert.equal(value.permissionMode,"auto");
  assert.deepEqual(value.model,{provider:"zenmux",id:"anthropic/claude-haiku-5.5"});
  const models=value.providers[0].models;
  assert.deepEqual(models.map((m)=>m.id),["anthropic/claude-haiku-5.5","anthropic/claude-opus-5.5","z-ai/glm-5.3-flash","z-ai/glm-5.3-flashx","xiaomi/mimo-v2.6-pro"]);
  assert.deepEqual(models[1],{id:"anthropic/claude-opus-5.5",name:"Claude Opus 5.5",note:"消耗约 40×；缓存读约 20×"});
  assert.deepEqual(models.map((m)=>m.id),MODELS.map((m)=>m.id));assert.ok(models.every((m)=>m.name&&m.note&&!m.note.includes("\n")));
  putAppSettings(root,{model:{ provider: "zenmux", id: MODELS[1].id }});assert.deepEqual(readAppSettings(root),{model:{provider:"zenmux",id:MODELS[1].id},permissionMode:"auto"});
  putAppSettings(root,{permissionMode:"bypassPermissions"});assert.equal(getAppSettings(root).permissionMode,"bypassPermissions");
  const file=path.join(root,"system/app-settings.json"), before=fs.readFileSync(file);
  for(const patch of [{model:"unknown"},{permissionMode:"default"},{effort:"low"},{model:null},[],null]) assert.throws(()=>putAppSettings(root,patch));
  assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.statSync(file).mode&0o777,0o600);
  process.env.AGENT_MODEL="obsolete";process.env.AGENT_PERMISSION_MODE="default";process.env.AGENT_EFFORT="low";
  assert.equal(config.model,DEFAULT_SETTINGS.model.id);assert.equal(config.permissionMode,"auto");assert.equal(config.effort,"max");
  delete process.env.AGENT_MODEL;delete process.env.AGENT_PERMISSION_MODE;delete process.env.AGENT_EFFORT;
});

test("history reads only task transcript text, one-line tool summaries and final result; thinking, outputs and secrets never leave",()=>{
  const root=fs.mkdtempSync(path.join(testRoot,"history-")), sessions=path.join(root,"system/sessions");
  const connectors=new ConnectorManager({root});connectors.knownSecrets.add("fictional-old-password");
  const h=new TaskHistory({root,sessions,redact:(s)=>connectors.redact(s)}), id="agent-local";
  h.put(id,{kind:"subagent",sessionId:"session-local",title:"任务",status:"running"});
  const file=path.join(sessions,"projects","fixture","session-local/subagents/agent-agent-local.jsonl");fs.mkdirSync(path.dirname(file),{recursive:true});
  const row=(type,uuid,content)=>({type,uuid,timestamp:"2026-10-11T10:00:00Z",message:{content}});
  const rows=[row("user","1","原任务说明"),row("assistant","2",[{type:"thinking",thinking:"PRIVATE_THINKING"},{type:"text",text:"先读记录 fictional-old-password"},
    {type:"tool_use",id:"read",name:"Read",input:{file_path:path.join(root,"data/memory/profile/总档.md")}}]),
    row("user","3",[{type:"tool_result",tool_use_id:"read",content:"PRIVATE_RAW_OUTPUT TOKEN=fictional-raw-token",is_error:false}]),
    row("assistant","4",[{type:"text",text:"结果：TOKEN=fictional-secret sk-fictional-secret-key Bearer fictional-key"}])];
  fs.writeFileSync(file,rows.map((r)=>JSON.stringify(r)).join("\n")+"\n");
  h.put(id,{status:"done",endedAt:Date.now()});const value=h.history(id);
  assert.deepEqual(value.items.map((i)=>i.kind),["prompt","text","tool","result"]);
  assert.equal(value.items[2].text,"读取 data/memory/profile/总档.md");assert.equal(value.items[2].tool,"Read");
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE_THINKING|PRIVATE_RAW_OUTPUT|fictional-old-password|fictional-secret|fictional-key/);
  assert.ok(new TaskHistory({root,sessions,redact:(s)=>s}).records.has(id));
  assert.throws(()=>h.history("../agent-local"),(e)=>e.status===400);assert.throws(()=>h.history("unknown"),(e)=>e.status===404);
});

test("authenticated settings/history/send APIs validate bodies, preserve task id, and expose ids on job lists",async(t)=>{
  let changed=0;const sent=[];
  const harness={busy:false,connectors:new ConnectorManager(),settingsChanged:()=>{changed++;},log(){},
    backgroundTasks:()=>[{id:"native-id",description:"任务",startedAt:1}],
    taskHistory:(id)=>({id,title:"任务",status:"running",items:[{kind:"prompt",text:"原任务",time:"2026-10-11T10:00:00Z"}]}),
    sendTask:async(id,text)=>{if(typeof text!=="string"||!text.trim()) {const e=new Error("续聊消息不能为空");e.status=400;throw e;}sent.push({id,text});},
    runningJobs:()=>[{id:"isolated-id",label:"夜间整理",started:1}],recentJobs:()=>[{id:"native-done",label:"已完成",status:"done",ts:1}]};
  const server=startServer({harness,hub:new DeviceHub(),bus:{on(){}},log(){},listen:{host:"127.0.0.1",port:0}});await once(server,"listening");
  t.after(async()=>{server.closeAllConnections();await new Promise((r)=>server.close(r));});
  const base="http://127.0.0.1:"+server.address().port;
  const req=async(route,method="GET",body,auth=true)=>{const r=await fetch(base+route,{method,headers:{...(auth&&{Authorization:"Bearer "+config.token}),"Content-Type":"application/json"},...(body!==undefined&&{body:typeof body==="string"?body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
  assert.equal((await req("/api/settings","GET",undefined,false)).status,401);
  assert.deepEqual((await req("/api/settings")).body.model,DEFAULT_SETTINGS.model);
  const glm={provider:"zenmux",id:MODELS[2].id};
  assert.deepEqual((await req("/api/settings","PUT",{model:glm})).body.model,glm);assert.equal(changed,1);
  const opus={provider:"zenmux",id:"anthropic/claude-opus-5.5"},saved=await req("/api/settings","PUT",{model:opus});
  assert.equal(saved.status,200);assert.deepEqual(saved.body.model,opus);assert.equal(changed,2);
  assert.deepEqual((await req("/api/settings")).body.model,opus);assert.deepEqual(readAppSettings(config.root).model,opus);
  assert.deepEqual(saved.body.providers[0].models[1],{id:opus.id,name:"Claude Opus 5.5",note:"消耗约 40×；缓存读约 20×"});
  assert.equal((await req("/api/settings","PUT","bad")).status,400);assert.equal((await req("/api/settings","PUT",{permissionMode:"default"})).status,400);
  assert.deepEqual((await req("/api/settings")).body.model,opus);assert.equal(changed,2);
  assert.equal((await req("/api/activities/native-id/history")).body.status,"running");
  assert.deepEqual((await req("/api/activities/native-id/send","POST",{text:"继续"})).body,{ok:true,id:"native-id"});assert.deepEqual(sent,[{id:"native-id",text:"继续"}]);
  assert.equal((await req("/api/activities/native-id/send","POST",{text:""})).status,400);assert.equal((await req("/api/activities/%E0/history")).status,400);
  assert.equal((await req("/api/activities/native-id/send","POST",{text:"继续"},false)).status,401);
  const jobs=(await req("/api/activities")).body;assert.ok([...jobs.running,...jobs.recent].every((j)=>j.id));
});
