// Real OpenClaw and HTTP model protocol; synthetic usage exercises the 272K boundary.
// --summary-timeout stalls only the local summary endpoint to verify native recovery.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import { fakeAnthropic } from '../test/fake-anthropic.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'doudou-context-policy-'));
process.env.AGENT_ROOT=root;process.env.AGENT_TOKEN='context-policy-fixture';
process.env.AGENT_PORT='14442';process.env.OPENCLAW_PORT='18792';
delete process.env.MODEL_BASE_URL;delete process.env.MODEL_API_KEY;
const timeoutRecovery=process.argv.includes('--summary-timeout');
let stage='warmup',summaries=0,flushes=0,continued=false,maxSummaryInputChars=0;
const marker='cedarpebblecontextmarker';
const fake=await fakeAnthropic(async body=>{
 const last=JSON.stringify(body.messages?.findLast(m=>m.role==='user')?.content||'');
 if(/You are a context summarization assistant/.test(JSON.stringify(body.system))){
  summaries++;
  maxSummaryInputChars=Math.max(maxSummaryInputChars,JSON.stringify(body.messages).length);
  if(timeoutRecovery)await new Promise(r=>setTimeout(r,3000));
  if(last.includes('This is the PREFIX of a turn'))return {content:[{type:'text',text:'## Original Request\nCONTEXT_POLICY_HIGH continue the fixture.\n## Early Progress\nThe previous fixture request completed.\n## Context for Suffix\nContinue the context policy fixture in the same Session.'}]};
  return {content:[{type:'text',text:`## Decisions\nUse the same main session and native memory. Earlier fixture requests completed.\n## Open TODOs\nContinue the current conversation and report the remembered marker.\n## Constraints/Rules\nPreserve the 272K compaction policy. No external actions are authorized.\n## Pending user asks\nNone.\n## Exact identifiers\nThe marker from CONTEXT_POLICY_WARMUP is ${marker}.`}]};
 }
 if(!last.includes('CONTEXT_POLICY_')){flushes++;return {content:[{type:'text',text:'NO_REPLY'}],usage:{input_tokens:['high','continue'].includes(stage)?273000:270000}};}
 if(stage==='continue'){
  continued=timeoutRecovery?last.includes('CONTEXT_POLICY_CONTINUE'):JSON.stringify(body.messages).includes(marker);
  return {content:[{type:'text',text:timeoutRecovery?'Current pending request completed after native recovery.':`Continued: ${marker}`}],usage:{input_tokens:3000}};
 }
 return {content:[{type:'text',text:`Completed ${stage}.`}],usage:{input_tokens:stage==='warmup'?50000:stage==='low'?270000:273000}};
});
const [{PROVIDER_PRESETS},{initialize},{Harness},{DeviceHub},{ConnectorManager},{startServer},{Content},{Schedules},{writePrivateJson}]=await Promise.all([
 import('../src/provider-presets.mjs'),import('../src/initialize.mjs'),import('../src/agent.mjs'),import('../src/devices.mjs'),import('../src/connectors.mjs'),import('../src/server.mjs'),import('../src/content.mjs'),import('../src/scheduler.mjs'),import('../src/private-json.mjs')]);
const provider='11111111-1111-4111-8111-111111111111',model='fixture-context-1m';
// A process-local provider fixture uses the production catalog/configuration path.
PROVIDER_PRESETS.push({id:'context-fixture',protocol:'anthropic',baseUrl:fake.url,models:[{id:model,name:'Context fixture',input:['text'],reasoning:false,contextWindow:1048576,maxTokens:8192}]});
initialize(root);
writePrivateJson(root+'/system/providers.json',{providers:[{id:provider,name:'Local context fixture',protocol:'anthropic',baseUrl:fake.url,apiKey:'context-fixture-only-key',models:[{id:model,name:'Context fixture'}]}]});
writePrivateJson(root+'/system/app-settings.json',{model:{provider,id:model}});
fs.writeFileSync(root+'/MEMORY.md','# Memory\nSynthetic context policy fixture.\n');
const logs=[],log=(...args)=>{const line=args.join(' ');logs.push(line);console.log(line);};
const bus={emit(){},on(){}},hub=new DeviceHub(),connectors=new ConnectorManager({root,definitions:[]});
const h=new Harness({hub,bus,connectors,log}),content=new Content({root}),schedules=new Schedules({harness:h,content,log});
if(timeoutRecovery){
 const configure=h.runtime.configure.bind(h.runtime);
 h.runtime.configure=()=>{configure();const cfg=JSON.parse(fs.readFileSync(h.runtime.file,'utf8'));cfg.agents.defaults.compaction.timeoutSeconds=1;writePrivateJson(h.runtime.file,cfg);};
}
const server=startServer({harness:h,hub,bus,connectors,content,schedules,log});
function compactEvents(){
 const db=new DatabaseSync(root+'/.openclaw/agents/main/agent/openclaw-agent.sqlite',{readOnly:true});
 try{
  const session=db.prepare('select current_session_id from session_nodes where session_key=?').get('agent:main:main');
  const windows=db.prepare('select session_id from session_windows where session_key=?').all('agent:main:main');
  const events=windows.flatMap(w=>db.prepare('select event_json,event_zstd from transcript_events where session_id=?').all(w.session_id)).map(r=>JSON.parse(r.event_json??zstdDecompressSync(r.event_zstd).toString('utf8')));
  return {sessionId:session?.current_session_id,events:events.filter(e=>e.type==='compaction'),originalTranscriptRetained:events.some(e=>e.type==='message'&&JSON.stringify(e).includes(marker))};
 }finally{db.close();}
}
try{
 await h.startMain();
 const cfg=JSON.parse(fs.readFileSync(root+'/system/openclaw.json','utf8')),native=cfg.models.providers[provider].models[0];
 assert.equal(native.contextWindow,1048576);assert.equal(native.contextTokens,292000);
 assert.equal(cfg.agents.defaults.compaction.thinkingLevel,'off');
 assert.equal(cfg.session.reset.mode,'none');assert.equal(cfg.agents.defaults.compaction.midTurnPrecheck.enabled,true);
 for(let i=0;i<4;i++){
  // Spread history across turns: one enormous first message cannot be cut away
  // while OpenClaw still preserves the most recent 20K tokens as whole turns.
  const warmup=await h.runMain(`CONTEXT_POLICY_WARMUP ${i}\n`+(i===0?`Remember ${marker}.\n`:'')+'Earlier synthetic transcript line. '.repeat(5000));
  assert.equal(warmup.ok,true,warmup.error);
 }
 const originalSessionId=compactEvents().sessionId;assert.ok(originalSessionId);
 stage='low';const low=await h.runMain('CONTEXT_POLICY_LOW continue the fixture.');assert.equal(low.ok,true,low.error);
 assert.equal(compactEvents().events.length,0,'compacted below the 272K boundary');assert.equal(summaries,0);
 stage='high';const high=await h.runMain('CONTEXT_POLICY_HIGH continue the fixture.');assert.equal(high.ok,true,high.error);
 // Let post-turn state settle; the following turn runs native preflight compaction.
 await new Promise(r=>setTimeout(r,1000));
 stage='continue';const next=await h.runMain('CONTEXT_POLICY_CONTINUE what is the marker?');assert.equal(next.ok,true,next.error);
 let persisted=compactEvents();
 for(let i=0;i<60&&persisted.events.length===0;i++){await new Promise(r=>setTimeout(r,250));persisted=compactEvents();}
 assert.ok(summaries>0,'native compaction did not request a summary');
 assert.ok(persisted.events.length>0,'native compaction was not persisted');
 if(timeoutRecovery){
  assert.ok(persisted.events.some(event=>event.summary?.includes('removed without a summary')),'native timeout did not commit a fallback boundary');
  assert.ok(persisted.originalTranscriptRetained,'timeout recovery deleted durable history');
  const completedSummaries=summaries;
  const later=await h.runMain('CONTEXT_POLICY_CONTINUE another normal turn.');assert.equal(later.ok,true,later.error);
  assert.equal(summaries,completedSummaries,'the next turn repeated the same failed summary');
 }else assert.ok(persisted.events.some(event=>JSON.stringify(event).includes(marker)),'native compaction did not preserve the transcript marker');
 assert.ok(continued);assert.equal(persisted.sessionId,originalSessionId,'compaction reset the main Session');
 assert.ok(maxSummaryInputChars>0&&maxSummaryInputChars<180000,'long transcript was sent to the summarizer without an input bound');
 console.log(JSON.stringify({ok:true,kernel:'openclaw',version:JSON.parse(fs.readFileSync(new URL('../node_modules/openclaw/package.json',import.meta.url),'utf8')).version,nativeModelWindow:native.contextWindow,activeContextBudget:native.contextTokens,compactAtTokens:272000,syntheticUsage:true,belowThresholdInputTokens:270000,aboveThresholdInputTokens:273000,belowThresholdNoCompaction:true,nativeCompaction:true,persistedCompactions:persisted.events.length,continuityAfterCompaction:continued,sameSessionId:true,sessionResetDisabled:true,midTurnPrecheck:true,maxSummaryInputChars,memoryFlushes:flushes,modelRequests:fake.requests.length,...(timeoutRecovery&&{nativeTimeoutRecovery:true,originalTranscriptRetained:persisted.originalTranscriptRetained,noRepeatedCompaction:true})}));
}finally{await h.close();server.closeSockets();server.closeAllConnections();await new Promise(r=>server.close(r));await fake.close();fs.rmSync(root,{recursive:true,force:true});}
