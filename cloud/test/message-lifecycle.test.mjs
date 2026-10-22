import { testRoot } from './environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Harness } from '../src/agent.mjs';
import { config } from '../src/config.mjs';
import { initialize } from '../src/initialize.mjs';
import { DeviceHub } from '../src/devices.mjs';
import { ConnectorManager } from '../src/connectors.mjs';
import { MessageInbox } from '../src/message-inbox.mjs';
import { TaskHistory } from '../src/task-history.mjs';
import { recordActivity } from '../openclaw-plugin/activity-events.mjs';

test('a slow native admission cannot hold the HTTP receipt; retry and recovery retain one user message',async()=>{
 initialize(config.root);
 let accept,finish;const response=new Promise(r=>finish=r),events=[],calls=[];
 const runtime={start:async()=>{},close:async()=>{},respond:async(input,options)=>{calls.push({input,options});accept=()=>options.onAccepted({});return response;}};
 const h=new Harness({runtime,hub:new DeviceHub(),connectors:new ConnectorManager({root:config.root,definitions:[]}),bus:{emit:e=>events.push(e)}});
 const sent=h.send('Synthetic receipt test','http',[],{clientId:'durable-client'});
 const id=await Promise.race([sent,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Receipt waited for model admission')),1000))]);
 assert.equal(calls.length,1);assert.equal(h.inbox.records.size,1);
 assert.equal(new MessageInbox(config.root).records.get(id).promptText,'Synthetic receipt test');
 assert.equal(await h.send('Synthetic receipt test','http',[],{clientId:'durable-client'}),id);
 assert.equal(calls.length,1);assert.equal(events.filter(e=>e.t==='user').length,1);
 assert.equal(events.find(e=>e.t==='user').clientId,'durable-client');
 accept();assert.equal(new MessageInbox(config.root).records.size,0);
 finish({text:'Received'});await h.waitForMain();await h.close();
 const next=new Harness({runtime,hub:new DeviceHub(),connectors:new ConnectorManager({root:config.root,definitions:[]}),bus:{emit(){}}});
 assert.equal(await next.send('Synthetic receipt test','http',[],{clientId:'durable-client'}),id);
 assert.equal(calls.length,1,'HTTP retry after a cloud restart must not execute twice');await next.close();
});

test('a committed but undispatched input is recovered using its original native idempotency key',async()=>{
 initialize(config.root);const inbox=new MessageInbox(config.root),id='pending-before-crash';
 inbox.put({entry:{id,role:'user',text:'Synthetic recovered input',ts:Date.now(),source:'http',clientId:'recover-client'},promptText:'Synthetic recovered input'});
 const calls=[],h=new Harness({runtime:{start:async()=>{},close:async()=>{},respond:async(input,opts)=>{calls.push(opts.id);opts.onAccepted?.({});return {text:'Recovered'};}},hub:new DeviceHub(),connectors:new ConnectorManager({root:config.root,definitions:[]}),bus:{emit(){}}});
 await h.startMain();await h.waitForMain();assert.deepEqual(calls,[id]);assert.equal(h.speech.history(1000).filter(m=>m.id===id).length,1);assert.equal(h.inbox.records.size,0);await h.close();
});

test('activity telemetry returns immediately even when its HTTP bridge stalls or rejects',async()=>{
 let fail;const bridge=()=>new Promise((_,reject)=>fail=reject);
 assert.equal(recordActivity(bridge,'before',{toolName:'read'},{sessionKey:'main'}),undefined);
 await Promise.resolve();fail(new Error('Body unavailable'));await new Promise(r=>setImmediate(r));
 let calls=0;recordActivity(()=>calls++,'before',{toolName:'doudou_call'},{sessionKey:'main'});await Promise.resolve();assert.equal(calls,0);
});

test('activity details migrate once; recording a new step does not rewrite unrelated histories',()=>{
 const root=fs.mkdtempSync(path.join(testRoot,'activity-layout-'));fs.mkdirSync(path.join(root,'system'),{recursive:true});
 const old={first:{id:'first',kind:'chat',status:'done',steps:[{kind:'tool',text:'read'},{kind:'result',text:'Synthetic result'}],latestResult:'Synthetic result'}};
 fs.writeFileSync(path.join(root,'system/activity-index.json'),JSON.stringify(old));
 const history=new TaskHistory({root});assert.equal(history.get('first').steps.length,2);assert.equal(history.get('first').latestResult,'Synthetic result');
 const index=fs.readFileSync(history.file,'utf8');assert.ok(!index.includes('Synthetic result'));
 history.appendStep('first',{kind:'tool_result',text:'Finished'});assert.equal(fs.readFileSync(history.file,'utf8'),index);
 const reopened=new TaskHistory({root});assert.equal(reopened.get('first').steps.length,3);assert.equal(reopened.get('first').latestResult,'Synthetic result');
});

test('the preceding input can settle without deleting a native continuation tool context or clearing busy',async()=>{
 initialize(config.root);let finish;
 const response=new Promise(resolve=>finish=resolve),runtime={close:async()=>{},respond:async(_input,opts)=>{opts.onAccepted?.({});return response;}};
 const h=new Harness({runtime,hub:new DeviceHub(),connectors:new ConnectorManager({root:config.root,definitions:[]}),bus:{emit(){}}});
 try{
  await h.send('Synthetic preceding question');const previous=h.mainTask;
  h.observeMainRun({id:'native-owner-race',sessionKey:'agent:main:main',phase:'start'});
  finish({text:'Synthetic preceding answer'});await previous;
  assert.equal(h.busy,true);assert.equal(h.sessionRuns.get('agent:main:main').id,'native-owner-race');
  const catalog=await h.productTool('catalog',{sessionKey:'agent:main:main'});assert.ok(catalog.content.length);
  let settled=false;const waiting=h.waitForMain().then(()=>settled=true);await new Promise(r=>setImmediate(r));assert.equal(settled,false);
  h.observeMainRun({id:'native-owner-race',sessionKey:'agent:main:main',phase:'final',response:{text:'Synthetic native answer'}});await waiting;
  assert.equal(h.busy,false);assert.equal(h.running.size,0);assert.equal(h.history.get('native-owner-race').status,'done');
 }finally{finish({text:'Synthetic preceding answer'});await h.close();}
});

test('native replies remain unique after restarting presentation, and quiet checks do not enter chat',async()=>{
 initialize(config.root);
 const create=()=>new Harness({runtime:{close:async()=>{}},hub:new DeviceHub(),connectors:new ConnectorManager({root:config.root,definitions:[]}),bus:{emit(){}}});
 let h=create();
 const final={id:'native-durable-reply',sessionKey:'agent:main:main',phase:'final',response:{text:'Synthetic durable native answer'}};
 try{h.observeMainRun(final);await h.waitForMain();}finally{await h.close();}
 h=create();
 try{
  h.observeMainRun(final);
  h.observeMainRun({id:'native-quiet-check',sessionKey:'agent:main:main',phase:'start'});
  h.observeMainRun({id:'native-quiet-check',sessionKey:'agent:main:main',phase:'final',response:{text:'HEARTBEAT_OK'}});await h.waitForMain();
  assert.equal(h.speech.history().filter(m=>m.text==='Synthetic durable native answer').length,1);
  assert.ok(!h.speech.history().some(m=>m.text==='HEARTBEAT_OK'));assert.equal(h.history.get('native-quiet-check').status,'done');
 }finally{await h.close();}
});
