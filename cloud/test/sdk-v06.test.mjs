import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {query} from "@anthropic-ai/claude-agent-sdk";
import {Harness} from "../src/agent.mjs";
import {DeviceHub} from "../src/devices.mjs";
import {config} from "../src/config.mjs";
import {fakeAnthropic} from "./fake-anthropic.mjs";
import {hasInput,toolReply,textReply,resultFor,blocks} from "./native-fixture.mjs";

// Exercise the real CLI and message wire after reconstructing the harness, with only a loopback model.
test("real SDK restart continuation carries original context and uploaded image, denies health write, stores a new transcript under the original task and notifies",{timeout:30_000},async(t)=> {
  const id="v06-old-native",oldSession="v06-original-parent",title="原耳机任务",events=[];
  const transcript=path.join(config.sessions,"projects/fixture",oldSession,"subagents/agent-"+id+".jsonl");fs.mkdirSync(path.dirname(transcript),{recursive:true});
  fs.writeFileSync(transcript,[{type:"user",timestamp:"2026-10-01T01:00:00Z",message:{content:"V06_OLD_ASSIGNMENT：对比耳机，先看佩戴"}},
    {type:"assistant",timestamp:"2026-10-01T01:01:00Z",message:{content:[{type:"tool_use",name:"Read",id:"old-read",input:{file_path:"data/memory/preferences/耳机.md"}},{type:"text",text:"V06_OLD_RESULT：轻量款更合适"}]}}].map((r)=>JSON.stringify(r)).join("\n"));
  const image="data/uploads/2026-10-12/v06-native-image.png";fs.mkdirSync(path.dirname(path.join(config.root,image)),{recursive:true});fs.writeFileSync(path.join(config.root,image),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv1cAAAAASUVORK5CYII=","base64"));
  const healthFile=path.join(config.root,"data/health/days.json");fs.mkdirSync(path.dirname(healthFile),{recursive:true});fs.writeFileSync(healthFile,'{"days":[]}');
  let requests=0,sawImage=false;
  const api=await fakeAnthropic((body)=> {
    requests++;assert.equal(hasInput(body,"V06_OLD_ASSIGNMENT"),true);assert.equal(hasInput(body,"V06_OLD_RESULT"),true);assert.equal(hasInput(body,"读取 data/memory/preferences/耳机.md"),true);
    sawImage||=body.messages.flatMap(blocks).some((b)=>b.type==="image"&&b.source.media_type==="image/png");
    if(!resultFor(body,"deny-health"))return toolReply("deny-health","Write",{file_path:healthFile,content:'{"days":[{"steps":999999}]}'});
    assert.match(JSON.stringify(resultFor(body,"deny-health")),/系统从手机同步|只能读取/);
    return textReply("V06_NATIVE_CONTINUED：图片已收到，原任务继续完成");
  });t.after(()=>api.close());
  const queryFactory=({prompt,options})=>query({prompt,options:{...options,agentProgressSummaries:false,settingSources:[],permissionMode:"bypassPermissions",allowDangerouslySkipPermissions:true,
    env:{...options.env,ANTHROPIC_BASE_URL:api.url,ANTHROPIC_API_KEY:"fake-local-v06-only",ANTHROPIC_AUTH_TOKEN:"",CLAUDE_CONFIG_DIR:config.sessions,CLAUDE_CODE_TMPDIR:path.join(config.root,"native-tmp"),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1",DISABLE_TELEMETRY:"1",DISABLE_ERROR_REPORTING:"1"}}});
  const make=()=>new Harness({hub:new DeviceHub(),bus:{emit:(e)=>events.push(e)},log(){},queryFactory});
  const old=make();old.history.put(id,{kind:"subagent",sessionId:oldSession,title,status:"done",startedAt:Date.parse("2026-10-01T01:00:00Z")});
  const restarted=make();assert.equal(restarted.main,null);await restarted.sendTask(id,"V06_CONTINUE：按图片接着比较",[{path:image,name:"耳机.png",kind:"image"}]);await restarted.jobChain;
  assert.ok(requests>=2);assert.equal(sawImage,true);assert.equal(fs.readFileSync(healthFile,"utf8"),'{"days":[]}');assert.equal(restarted.history.get(id).status,"done");
  assert.ok(restarted.history.get(id).sessionId&&restarted.history.get(id).sessionId!==oldSession);
  const history=restarted.taskHistory(id);assert.equal(history.items[0].from,"agent");assert.equal(history.items.find((i)=>i.from==="user").attachments[0].path,image);assert.ok(history.items.some((i)=>i.kind==="result"&&i.text.startsWith("V06_NATIVE_CONTINUED")));assert.ok(!history.items.some((i)=>i.text.startsWith("[任务续聊上下文]")));
  assert.ok(events.some((e)=>e.t==="job"&&e.phase==="done"&&e.id===id&&e.taskContinuation));
});
