import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Harness } from "../src/agent.mjs";
import { DeviceHub } from "../src/devices.mjs";
import { config } from "../src/config.mjs";
import { writeJson } from "../src/store.mjs";
import { MODELS, putAppSettings, DEFAULT_SETTINGS } from "../src/app-settings.mjs";
import { fakeAnthropic, compactRequest } from "./fake-anthropic.mjs";
import { hasInput, toolReply, textReply, isFork, resultFor } from "./native-fixture.mjs";

function fixture(t,api,release=()=>{}) {
  const events=[],wire=[],optionsUsed=[],spawned=[];
  writeJson(config.stateFile,{});
  const h=new Harness({hub:new DeviceHub(),bus:{emit:(ev)=>events.push(ev)},log(){},
    queryFactory:({prompt,options})=>{
      optionsUsed.push(options);
      return query({prompt,options:{...options,agentProgressSummaries:false,
        spawnClaudeCodeProcess:(o)=>{spawned.push({autoModel:o.env.CLAUDE_CODE_AUTO_MODE_MODEL,backgroundClassifier:o.env.CLAUDE_CODE_BG_CLASSIFIER_MODEL,subagent:o.env.CLAUDE_CODE_SUBAGENT_MODEL,window:o.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW});return options.spawnClaudeCodeProcess(o);},
        env:{...options.env,ANTHROPIC_BASE_URL:api.url,ANTHROPIC_API_KEY:"fake-local-v05-only",ANTHROPIC_AUTH_TOKEN:"",
          CLAUDE_CONFIG_DIR:config.sessions,CLAUDE_CODE_TMPDIR:path.join(config.root,"native-tmp"),
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:"0",CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",DISABLE_TELEMETRY:"1",DISABLE_ERROR_REPORTING:"1"}}});
    }});
  const receive=h.onMainMessage.bind(h);
  h.onMainMessage=(m,main)=>{wire.push(m);receive(m,main);};
  h.startMain();
  t.after(async()=>{release();clearTimeout(h.restartTimer);h.main.intentionalClose=true;h.main.inbox.close();h.main.q.close();await h.main.finished;await api.close();});
  async function until(predicate) {
    const end=Date.now()+20_000;
    while(!predicate()) {if(Date.now()>end) throw new Error("本地 SDK 未完成："+JSON.stringify(wire.slice(-8).map((m)=>({type:m.type,subtype:m.subtype,state:m.state,errors:m.errors}))));await delay(15);}
  }
  async function turn(text) {
    const count=wire.filter((m)=>m.type==="result").length;
    await h.send(text);
    await until(()=>wire.filter((m)=>m.type==="result").length>count&&!h.busy);
    return wire.findLast((m)=>m.type==="result");
  }
  return {h,wire,events,optionsUsed,spawned,until,turn};
}

test("真实 SDK 切换后四模型下一轮的 wire model 改变，原会话和内置系统提示词保留",{timeout:60_000},async(t)=>{
  putAppSettings(config.root,{...DEFAULT_SETTINGS,permissionMode:"bypassPermissions"});
  const api=await fakeAnthropic();
  const f=fixture(t,api);
  assert.equal((await f.turn("V05_FIRST_CONTEXT" )).subtype,"success");
  const session=f.h.main.sessionId;
  for(const row of MODELS.slice(1)) {
    putAppSettings(config.root,{model:row.id});f.h.settingsChanged();await f.h.inputChain;
    const result=await f.turn("V05_SWITCH "+row.id);
    assert.equal(result.subtype,"success");
    assert.equal(api.requests.at(-1).model,row.id);
    assert.equal(f.h.main.sessionId,session);
    assert.ok(hasInput(api.requests.at(-1),"V05_FIRST_CONTEXT"));
    assert.equal(result.modelUsage[row.id].contextWindow,200000);
    assert.equal(api.requests.at(-1).output_config.effort,"max");
  }
  assert.equal(f.optionsUsed.length,MODELS.length,"model changes refresh classifier env by resuming the same conversation");
  assert.equal(f.optionsUsed[0].systemPrompt.type,"preset");
  assert.equal(f.optionsUsed[0].systemPrompt.preset,"claude_code");
  assert.ok(f.optionsUsed[0].systemPrompt.append.trim());
  assert.ok(JSON.stringify(api.requests[0].system).length>f.optionsUsed[0].systemPrompt.append.length,"the CLI builtin prompt remains present");
  assert.equal(f.optionsUsed.at(-1).env.CLAUDE_CODE_AUTO_MODE_MODEL,MODELS.at(-1).id);
  assert.equal(f.optionsUsed.at(-1).env.CLAUDE_CODE_SUBAGENT_MODEL,MODELS.at(-1).id);
  assert.equal(new Set(f.optionsUsed.map((o)=>o.systemPrompt.append)).size,1);
  assert.deepEqual(f.spawned.map((s)=>s.autoModel),MODELS.map((m)=>m.id));
  assert.ok(f.spawned.every((s)=>s.subagent===s.autoModel&&s.backgroundClassifier===s.autoModel&&s.window==="200000"));
});

test("四模型真实 CLI 均为 200K，低于 167K 不压缩，超过后使用内置压缩并恢复 max",{timeout:120_000},async(t)=>{
  for(const row of MODELS) await t.test(row.id,{timeout:40_000},async(t)=>{
    putAppSettings(config.root,{model:row.id,permissionMode:"bypassPermissions"});
    let normal=0;
    const api=await fakeAnthropic((body)=>compactRequest(body)?{}:{usage:{input_tokens:1000,cache_creation_input_tokens:2000,cache_read_input_tokens:++normal===1?162000:164001}});
    const f=fixture(t,api);
    const first=await f.turn("V05_WINDOW_FIRST");
    assert.equal(first.subtype,"success");assert.equal(first.modelUsage[row.id].contextWindow,200000);
    assert.equal(first.modelUsage[row.id].maxOutputTokens,128000);
    assert.equal(api.requests[0].thinking.type,"adaptive");
    if(row.id==="anthropic/claude-opus-5.5")assert.ok(Math.abs(first.modelUsage[row.id].costUSD-.04656)<1e-10,"CLI uses the Opus 5.5 profile's pricing");
    assert.equal((await f.turn("V05_WINDOW_SECOND")).subtype,"success");
    assert.equal(api.requests.filter(compactRequest).length,0);
    assert.equal((await f.turn("V05_WINDOW_THIRD")).subtype,"success");
    const compact=api.requests.find(compactRequest);
    assert.ok(compact,JSON.stringify(api.requests.map((r)=>({effort:r.output_config,tail:JSON.stringify(r.messages.findLast((m)=>m.role==="user")).slice(0,700)}))));
    assert.equal(compact.output_config.effort,"low");
    assert.doesNotMatch(JSON.stringify(compact.messages),/1500 tokens|目标不超过/);
    assert.ok(f.wire.some((m)=>m.subtype==="compact_boundary"));
    assert.equal(api.requests.at(-1).output_config.effort,"max");
    assert.equal(api.requests.at(-1).model,row.id);
    assert.ok(api.requests.every((r)=>r.max_tokens===128000&&r.thinking.type==="adaptive"));
  });
});

test("真实 SendMessage 恢复已完成 fork：同一任务 id、原始上下文、新结果和 transcript history",{timeout:45_000},async(t)=>{
  putAppSettings(config.root,{...DEFAULT_SETTINGS,permissionMode:"bypassPermissions"});
  let id,continued=false;
  const api=await fakeAnthropic((body)=>{
    if(isFork(body)) {
      if(hasInput(body,"V05_FOLLOW_DONE")) {
        continued=true;
        assert.ok(hasInput(body,"V05_TASK_MEMORY_42"));
        assert.match(JSON.stringify(body.messages),/V05_ORIGINAL_RESULT/);
        return textReply("V05_CONTINUED_RESULT");
      }
      return textReply("V05_ORIGINAL_RESULT");
    }
    if(hasInput(body,"V05_FOLLOW_DONE")&&!resultFor(body,"v05_resume")) return toolReply("v05_resume","SendMessage",{to:id,message:"V05_FOLLOW_DONE"});
    if(!resultFor(body,"v05_spawn")&&!hasInput(body,"task-notification")) return toolReply("v05_spawn","Agent",{subagent_type:"fork",run_in_background:true,description:"本地任务续聊",prompt:"V05_TASK_MEMORY_42: complete this fixture."});
    return textReply("已安排。");
  });
  const f=fixture(t,api);
  await f.turn("V05_START_TASK");
  await f.until(()=>f.wire.some((m)=>m.subtype==="task_notification"&&m.status==="completed")&&!f.h.busy);
  id=f.wire.find((m)=>m.subtype==="task_started"&&m.subagent_type==="fork").task_id;
  const before=f.h.taskHistory(id);
  assert.equal(before.status,"done");assert.ok(before.items.some((i)=>i.kind==="prompt"&&i.text.includes("V05_TASK_MEMORY_42")));
  assert.ok(before.items.some((i)=>i.kind==="result"&&i.text.includes("V05_ORIGINAL_RESULT")));
  putAppSettings(config.root,{model:MODELS[2].id});f.h.settingsChanged();await f.h.inputChain;
  assert.equal(await f.h.sendTask(id,"V05_FOLLOW_DONE"),id);
  await f.until(()=>continued&&f.wire.filter((m)=>m.subtype==="task_notification"&&m.task_id===id&&m.status==="completed").length===2&&!f.h.busy);
  const after=f.h.taskHistory(id);
  assert.ok(api.requests.some((r)=>isFork(r)&&hasInput(r,"V05_FOLLOW_DONE")&&r.model===MODELS[2].id));
  assert.equal(after.id,id);assert.equal(after.status,"done");
  assert.equal(after.items.filter((i)=>i.kind==="prompt"&&i.text==="V05_FOLLOW_DONE").length,1);
  assert.ok(after.items.some((i)=>i.kind==="result"&&i.text.includes("V05_CONTINUED_RESULT")));
  const runs=f.wire.filter((m)=>m.subtype==="task_started"&&m.task_id===id);
  assert.equal(runs.length,2);assert.notEqual(runs[0].run_id,runs[1].run_id);
});

test("真实 SDK 权限切换在下一轮生效，保留主会话且不发 App 授权请求",{timeout:45_000},async(t)=>{
  putAppSettings(config.root,{...DEFAULT_SETTINGS,permissionMode:"bypassPermissions"});
  const api=await fakeAnthropic();const f=fixture(t,api);
  await f.turn("V05_PERMISSIONS_FIRST");const session=f.h.main.sessionId;
  for(const mode of ["auto","bypassPermissions"]) {
    putAppSettings(config.root,{permissionMode:mode});f.h.settingsChanged();await f.h.inputChain;
    assert.equal((await f.turn("V05_PERMISSIONS "+mode)).subtype,"success");
    assert.equal(f.wire.findLast((m)=>m.subtype==="init").permissionMode,mode);
    assert.equal(f.h.main.sessionId,session);
  }
  assert.equal(f.optionsUsed.length,1,"permissions use setPermissionMode without restarting the query");
  assert.equal(f.events.some((e)=>e.t==="permission"),false);
});

test("隔离任务用选中的模型和 preset+append，续聊 resume 原会话而且原结果仍在上下文",{timeout:45_000},async(t)=>{
  putAppSettings(config.root,{model:MODELS[1].id,permissionMode:"bypassPermissions"});
  let continued=false;
  const api=await fakeAnthropic((body)=>{
    if(hasInput(body,"V05_ISOLATED_FOLLOW")) {
      assert.ok(hasInput(body,"V05_ISOLATED_MEMORY"));assert.match(JSON.stringify(body.messages),/V05_ISOLATED_ORIGINAL/);
      assert.equal(body.model,MODELS[2].id);continued=true;return textReply("V05_ISOLATED_CONTINUED");
    }
    return textReply("V05_ISOLATED_ORIGINAL");
  });
  const f=fixture(t,api);
  const job=await f.h.runIsolated("本地夜间整理","V05_ISOLATED_MEMORY");assert.equal(job.ok,true);
  const task=f.h.recentJobs().find((r)=>r.label==="本地夜间整理"), originalSession=f.h.history.get(task.id).sessionId;
  assert.equal(api.requests.at(-1).model,MODELS[1].id);
  assert.equal(f.h.taskHistory(task.id).status,"done");
  putAppSettings(config.root,{model:MODELS[2].id});
  await f.h.sendTask(task.id,"V05_ISOLATED_FOLLOW");await f.h.jobChain;
  assert.equal(continued,true);assert.equal(f.h.history.get(task.id).sessionId,originalSession);
  assert.equal(f.h.taskHistory(task.id).items.findLast((i)=>i.kind==="result").text,"V05_ISOLATED_CONTINUED");
  assert.ok(f.optionsUsed.every((o)=>o.systemPrompt.preset==="claude_code"));
});

test("切模型时运行中的 fork 以原 id 恢复，新模型请求仍包含任务上下文",{timeout:60_000},async(t)=>{
  putAppSettings(config.root,{...DEFAULT_SETTINGS,permissionMode:"bypassPermissions"});
  let release,id,blocked=false,restored=false;
  const gate=new Promise((r)=>{release=r;});
  const api=await fakeAnthropic(async(body)=>{
    if(isFork(body)) {
      if(body.model===MODELS[0].id) {blocked=true;await gate;return textReply("OLD_MODEL_DONE");}
      assert.equal(body.model,MODELS[1].id);assert.ok(hasInput(body,"V05_SWITCH_RUNNING_MEMORY"));restored=true;
      return textReply("NEW_MODEL_DONE");
    }
    if(hasInput(body,"继续原任务，从已经完成的步骤接着做。")&&!resultFor(body,"v05_switch_send")) return toolReply("v05_switch_send","SendMessage",{to:id,message:"继续原任务，从已经完成的步骤接着做。"});
    if(!resultFor(body,"v05_switch_spawn")&&!hasInput(body,"task-notification")) return toolReply("v05_switch_spawn","Agent",{subagent_type:"fork",run_in_background:true,description:"换模型的任务",prompt:"V05_SWITCH_RUNNING_MEMORY"});
    return textReply("已安排。");
  });
  const f=fixture(t,api,release);await f.turn("V05_SWITCH_RUNNING_START");
  await f.until(()=>blocked&&f.h.backgroundTasks().length===1&&!f.h.busy);id=f.h.backgroundTasks()[0].id;
  const session=f.h.main.sessionId;
  putAppSettings(config.root,{model:MODELS[1].id});f.h.settingsChanged();await f.h.inputChain;
  await f.until(()=>restored&&f.wire.some((m)=>m.subtype==="task_notification"&&m.task_id===id&&m.status==="completed")&&!f.h.busy);
  assert.equal(f.h.main.sessionId,session);assert.equal(f.h.taskHistory(id).status,"done");release();
});

test("运行中的 fork 接收续聊，在后续请求中保留原 prompt 和用户新消息",{timeout:45_000},async(t)=>{
  putAppSettings(config.root,{...DEFAULT_SETTINGS,permissionMode:"bypassPermissions"});
  let release,id,childStarted=false,continued=false;
  const gate=new Promise((r)=>{release=r;});
  const file=path.join(config.root,"v05-context-fixture.txt");fs.writeFileSync(file,"local context");
  const api=await fakeAnthropic(async(body)=>{
    if(isFork(body)) {
      if(!resultFor(body,"v05_running_read")) {childStarted=true;await gate;return toolReply("v05_running_read","Read",{file_path:file});}
      assert.ok(hasInput(body,"V05_RUNNING_MEMORY"));
      if(!JSON.stringify(body.messages).includes("V05_RUNNING_FOLLOW")) return textReply("V05_RUNNING_ORIGINAL_RESULT");
      continued=true;
      return textReply("V05_RUNNING_RESULT");
    }
    if(hasInput(body,"V05_RUNNING_FOLLOW")&&!resultFor(body,"v05_running_send")) return toolReply("v05_running_send","SendMessage",{to:id,message:"V05_RUNNING_FOLLOW"});
    if(!resultFor(body,"v05_running_spawn")&&!hasInput(body,"task-notification")) return toolReply("v05_running_spawn","Agent",{subagent_type:"fork",run_in_background:true,description:"运行中续聊",prompt:"V05_RUNNING_MEMORY: read fixture then finish."});
    return textReply("已安排。");
  });
  const f=fixture(t,api,release);
  await f.turn("V05_RUNNING_START");await f.until(()=>childStarted&&f.h.backgroundTasks().length===1&&!f.h.busy);
  id=f.h.backgroundTasks()[0].id;assert.equal(f.h.taskHistory(id).status,"running");
  await f.h.sendTask(id,"V05_RUNNING_FOLLOW");
  await f.until(()=>api.requests.some((r)=>resultFor(r,"v05_running_send"))&&!f.h.busy);
  const sent=api.requests.map((r)=>resultFor(r,"v05_running_send")).find(Boolean);
  assert.notEqual(sent.is_error,true,JSON.stringify(sent));
  release();
  try { await f.until(()=>continued&&f.wire.some((m)=>m.subtype==="task_notification"&&m.task_id===id&&m.status==="completed")&&!f.h.busy); }
  catch(e) { throw new Error(e.message+" "+JSON.stringify(api.requests.map((r)=>({fork:isFork(r),markers:JSON.stringify(r.messages).match(/V05_[A-Z_]+/g),sent:resultFor(r,"v05_running_send")})))); }
  assert.equal(f.h.taskHistory(id).status,"done");
  assert.equal(f.h.taskHistory(id).items.filter((i)=>i.kind==="prompt"&&i.text==="V05_RUNNING_FOLLOW").length,1);
});
