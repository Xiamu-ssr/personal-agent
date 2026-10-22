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
