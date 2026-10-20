import test from 'node:test';
import assert from 'node:assert/strict';
import {GatewayChat} from '../src/gateway-chat.mjs';

test('gateway admits busy input immediately and correlates a steered receipt independently from the active answer',async()=>{
 const requests=[],chat=new GatewayChat({request:async(method,args)=>{requests.push({method,...args});return {runId:args.idempotencyKey,status:'started'};}});
 const options={sessionKey:'agent:main:main'};
 const first=chat.respond('Search',{...options,id:'original'}),second=chat.respond('Status?',{...options,id:'followup'});
 assert.equal(requests.length,2);assert.ok(requests.every(r=>r.queueMode==='steer'&&r.sessionKey===options.sessionKey));
 chat.event({event:'chat',payload:{...options,runId:'followup',state:'final'}});
 assert.deepEqual(await second,{text:''});assert.equal(chat.pending.size,1);
 chat.event({event:'chat',payload:{...options,runId:'original',state:'final',message:{content:[{type:'text',text:'Current progress'}]}}});
 assert.deepEqual(await first,{text:'Current progress'});assert.equal(chat.pending.size,0);
});

test('a run that finishes during admission can return the new native followup without losing its reply',async()=>{
 const chat=new GatewayChat({request:async()=>({status:'started'})}),options={sessionKey:'agent:main:main',id:'next'};
 const done=chat.respond('Next question',options);
 chat.event({event:'chat',payload:{sessionKey:'agent:main:other',runId:'next',state:'final'}});assert.equal(chat.pending.size,1);
 chat.event({event:'chat',payload:{sessionKey:options.sessionKey,runId:'next',state:'delta',message:{content:[{type:'text',text:'New answer'}]}}});
 chat.event({event:'chat',payload:{sessionKey:options.sessionKey,runId:'next',state:'final'}});
 assert.deepEqual(await done,{text:'New answer'});
});

test('rejected and interrupted inputs are explicit errors and are never silently replayed',async()=>{
 const rejected=new GatewayChat({request:async()=>{throw new Error('Not accepted');}});
 await assert.rejects(rejected.respond('input',{sessionKey:'main'}),/Not accepted/);assert.equal(rejected.pending.size,0);
 let submissions=0;const chat=new GatewayChat({request:async()=>{submissions++;return {};}});
 const done=chat.respond('input',{id:'input',sessionKey:'main'});chat.close();await assert.rejects(done,/不会自动重发/);assert.equal(submissions,1);assert.equal(chat.pending.size,0);
 const controller=new AbortController(),stopped=chat.respond('stop',{id:'stop',sessionKey:'main',signal:controller.signal});
 controller.abort(new Error('Stopped'));await assert.rejects(stopped,/Stopped/);assert.equal(chat.pending.size,0);
});
