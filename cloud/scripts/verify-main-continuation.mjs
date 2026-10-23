import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fakeAnthropic} from '../test/fake-anthropic.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'doudou-main-continuation-'));
Object.assign(process.env,{AGENT_ROOT:root,AGENT_TOKEN:'local-continuation-test',AGENT_PORT:'14467',OPENCLAW_PORT:'18804'});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const firstModel=deferred(),firstGate=deferred(),toolEntered=deferred(),toolGate=deferred(),beforeStopModel=deferred(),beforeStopGate=deferred(),stopModel=deferred(),stopGate=deferred();
const fake=await fakeAnthropic(async(body,index)=>{
 if(index===0){firstModel.resolve();await firstGate.promise;return {content:[{type:'text',text:'SYNTHETIC_SEARCH_ANSWER'}]};}
 if(index===1)return {stop_reason:'tool_use',content:[{type:'tool_use',id:'continuation_tool',name:'doudou_call',input:{name:'probe.wait',args_json:'{}'}}]};
 if(index===2){assert.ok(JSON.stringify(body.messages).includes('Synthetic tool finished'));return {content:[{type:'text',text:'SYNTHETIC_GLASSES_ANSWER'}]};}
 if(index===3){beforeStopModel.resolve();await beforeStopGate.promise;return {content:[{type:'text',text:'SYNTHETIC_BEFORE_STOP_ANSWER'}]};}
 if(index===4){stopModel.resolve();await stopGate.promise;return {content:[{type:'text',text:'SYNTHETIC_STOPPED_SHOULD_NOT_APPEAR'}]};}
 throw new Error(`Unexpected model request ${index}`);
});
Object.assign(process.env,{MODEL_BASE_URL:fake.url,MODEL_API_KEY:'local-continuation-model-key'});
const [{initialize},{Harness},{DeviceHub},{ConnectorManager},{startServer},{defineTool}]=await Promise.all([
 import('../src/initialize.mjs'),import('../src/agent.mjs'),import('../src/devices.mjs'),import('../src/connectors.mjs'),import('../src/server.mjs'),import('../src/product-tools.mjs')]);
initialize(root);const events=[],bus={emit:e=>events.push(e),on(){}};
const h=new Harness({hub:new DeviceHub(),bus,connectors:new ConnectorManager({root,definitions:[]})});
const groups=h.groups.bind(h);
h.groups=()=>({...groups(),probe:[defineTool('wait','Synthetic slow tool',{},async()=>{
 toolEntered.resolve();await toolGate.promise;return {content:[{type:'text',text:'Synthetic tool finished'}]};
})]});
const server=startServer({harness:h,hub:h.hub,bus,connectors:h.connectors,log(){}});
const until=async predicate=>{for(let i=0;i<600;i++){if(predicate())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Native continuation fixture timed out');};
const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Native continuation fixture timed out')),45000);timer.unref();})]);}finally{clearTimeout(timer);}};
try{
 await h.startMain();const nativeEvents=[],event=h.runtime.chat.event.bind(h.runtime.chat),request=h.runtime.client.request.bind(h.runtime.client);let reconciliations=0;
 h.runtime.chat.event=e=>{if(['agent','chat'].includes(e.event))nativeEvents.push(e);event(e);};
 // Deterministically exercise the gateway's native queued follow-up path. Normal
 // production input still uses steer; the gateway may fall back to this path.
 h.runtime.client.request=(method,args,...rest)=>{
  if(method==='agent.wait')reconciliations++;
  return request(method,method==='chat.send'&&args.message.includes('QUEUED_')?{...args,queueMode:'followup'}:args,...rest);
 };
 const original=await h.send('SYNTHETIC_SEARCH_QUESTION');await bounded(firstModel.promise);
 const second=await h.send('QUEUED_GLASSES_QUESTION');await until(()=>h.inbox.records.size===0);firstGate.resolve();
 await bounded(toolEntered.promise);
 // Native admission may bind the queued execution back to its accepted id.
 // Both forms must deliver the second answer and retain its tool/run context.
 const continuation=h.sessionRuns.get('agent:main:main')?.id;assert.ok(continuation);
 const executionId=[...nativeEvents].reverse().find(e=>e.event==='agent'&&e.payload.stream==='item')?.payload.runId;
 assert.ok(executionId&&executionId!==original,'queued input never received its own native execution');
 assert.equal(h.busy,true);
 assert.equal(h.history.get(continuation).status,'running');
 let settled=false;const finished=h.waitForMain().then(()=>settled=true);await new Promise(r=>setImmediate(r));assert.equal(settled,false);
 h.runtime.client.protocol.closeSocket(1012,'synthetic continuation disconnect');
 await until(()=>!h.runtime.rpcReady);toolGate.resolve();await bounded(finished);await until(()=>h.runtime.rpcReady);
 const answers=h.speech.history().filter(m=>m.role==='assistant');
 assert.deepEqual(answers.map(m=>m.text),['SYNTHETIC_SEARCH_ANSWER','SYNTHETIC_GLASSES_ANSWER']);
 assert.equal(h.history.get(continuation).status,'done');assert.equal(h.busy,false);assert.ok(reconciliations>0);
 assert.ok(h.taskHistory(continuation).items.some(i=>i.tool==='probe.wait'&&i.kind==='tool_result'&&!i.isError));
 // Repeated terminal events must not append the answer twice.
 const final=nativeEvents.find(e=>e.event==='chat'&&e.payload.runId===executionId&&e.payload.state==='final');
 h.runtime.chat.event(final||{event:'chat',payload:{sessionKey:'agent:main:main',runId:executionId,state:'final',message:{content:[{type:'text',text:'SYNTHETIC_GLASSES_ANSWER'}]}}});
 assert.equal(h.speech.history().filter(m=>m.text==='SYNTHETIC_GLASSES_ANSWER').length,1);
 await h.send('SYNTHETIC_BEFORE_STOP_QUESTION');await bounded(beforeStopModel.promise);
 // Hold its first response until the following input has been admitted.
 await h.send('QUEUED_STOP_QUESTION');await until(()=>h.inbox.records.size===0);beforeStopGate.resolve();await bounded(stopModel.promise);
 const stopped=h.sessionRuns.get('agent:main:main')?.id;assert.ok(stopped);await h.interrupt();stopGate.resolve();
 await bounded(h.waitForMain());assert.equal(h.history.get(stopped).status,'stopped');assert.equal(h.running.size,0);assert.equal(h.busy,false);
 assert.ok(!h.speech.history().some(m=>m.text==='SYNTHETIC_STOPPED_SHOULD_NOT_APPEAR'||m.error));
 console.log(JSON.stringify({ok:true,kernel:'openclaw',version:JSON.parse(fs.readFileSync(new URL('../node_modules/openclaw/package.json',import.meta.url),'utf8')).version,nativeQueuedFollowup:true,differentNativeRunId:executionId!==second,bothAnswersVisibleOnce:true,continuationToolsHaveContext:true,waitingIncludesContinuation:true,reconnectRecoversContinuation:true,stopCancelsContinuation:true,sameMainSession:true,modelRequests:fake.requests.length}));
}finally{
 firstGate.resolve();toolGate.resolve();beforeStopGate.resolve();stopGate.resolve();await h.close();server.closeSockets();server.closeAllConnections();await new Promise(r=>server.close(r));await fake.close();fs.rmSync(root,{recursive:true,force:true});
}
