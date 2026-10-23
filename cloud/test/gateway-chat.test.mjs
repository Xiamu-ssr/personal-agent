import test from 'node:test';
import assert from 'node:assert/strict';
import {GatewayChat,runFailureText} from '../src/gateway-chat.mjs';

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

test('a model connection failure remains a failure without sending users to a disabled Control UI',()=>{
 const error=new Error('Lost the connection to the AI service. Check the conversation before trying again. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow`.');
 assert.equal(runFailureText(error),'模型服务连接中断，消息已保留。稍后可以继续。');assert.equal(runFailureText(new Error('Specific API error')),'Specific API error');
});

test('context maintenance failures preserve a failed outcome without asking users to reset their main session',()=>{
 for(const message of ['Context overflow: prompt too large for the model. Try /reset (or /new).','This conversation is too long, and shortening it took too long. Try /compact.','Compaction timed out',"This conversation is too long, and OpenClaw couldn't shorten it. Try again, use /compact, or use /new to start a fresh session.",'Preflight compaction required but failed: provider invalid_params']){
  const text=runFailureText(new Error(message));assert.match(text,/未完成/);assert.match(text,/历史已保留/);assert.doesNotMatch(text,/reset|new|compact|Control UI/);
 }
 assert.equal(runFailureText(new Error('The provider refused this request. Revise the request and try again.')),'模型服务拒绝了这次请求，未完成的内容已保留。');
});

test('native image and attachment blocks survive text snapshots and an empty final event',async()=>{
 const chat=new GatewayChat({request:async()=>({})}),options={sessionKey:'agent:main:main',id:'media'};
 const done=chat.respond('Render a picture',options),image={type:'input_image',image_url:'data:image/png;base64,aGVsbG8='},attachment={type:'attachment',attachment:{url:'/work/data/library/media/song.mp3',kind:'audio',label:'Song'}};
 const event=(state,content)=>chat.event({event:'chat',payload:{sessionKey:options.sessionKey,runId:options.id,state,message:content&&{content}}});
 event('delta',[{type:'text',text:'Here it is'},image]);event('delta',[{type:'text',text:'Here it is'},image,attachment]);event('final');
 assert.deepEqual(await done,{text:'Here it is',media:[image,attachment]});
});

test('native assistant mediaUrls belong to the pending run even when the terminal chat event contains only text',async()=>{
 const chat=new GatewayChat({request:async()=>({})}),options={sessionKey:'agent:main:main',id:'native-media'};
 const done=chat.respond('Send a generated image',options),url='/work/data/library/media/image.png';
 chat.event({event:'agent',payload:{...options,runId:options.id,stream:'assistant',data:{mediaUrls:[url]}}});
 chat.event({event:'agent',payload:{...options,runId:options.id,stream:'assistant',data:{mediaUrl:url}}});
 chat.event({event:'chat',payload:{...options,runId:options.id,state:'final',message:{content:[{type:'text',text:'Ready'}]}}});
 assert.deepEqual(await done,{text:'Ready',media:[{type:'attachment',attachment:{url}}]});
});

test('a queued admission and its native continuation have independent identities and deliver both answers once',async()=>{
 const events=[],sessionKey='agent:main:main',chat=new GatewayChat({request:async()=>({})},{observeSessionKey:sessionKey,onObservedRun:e=>events.push(e)});
 const first=chat.respond('First question',{id:'first-input',sessionKey}),second=chat.respond('Second question',{id:'second-input',sessionKey});
 const emit=(event,runId,fields)=>chat.event({event,payload:{sessionKey,runId,...fields}});
 emit('chat','second-input',{state:'final'});assert.deepEqual(await second,{text:''});
 emit('chat','first-input',{state:'final',message:{content:[{type:'text',text:'First answer'}]}});assert.equal((await first).text,'First answer');
 emit('agent','native-continuation',{stream:'lifecycle',data:{phase:'start'}});
 assert.equal(events.length,1);assert.equal(events[0].phase,'start');
 emit('chat','native-continuation',{state:'delta',message:{content:[{type:'text',text:'Second answer'}]}});
 emit('chat','native-continuation',{state:'final'});
 emit('chat','native-continuation',{state:'final',message:{content:[{type:'text',text:'Second answer'}]}});
 emit('agent','native-continuation',{stream:'lifecycle',data:{phase:'start'}});
 assert.deepEqual(events.map(e=>({id:e.id,phase:e.phase,text:e.response?.text})),[
  {id:'native-continuation',phase:'start',text:undefined},{id:'native-continuation',phase:'final',text:'Second answer'}]);
 assert.equal(chat.pending.size,0);assert.equal(chat.observed.size,0);
});

test('empty admission does not suppress a later execution reusing that input id; other sessions remain isolated',async()=>{
 const events=[],sessionKey='agent:main:main',chat=new GatewayChat({request:async()=>({})},{observeSessionKey:sessionKey,onObservedRun:e=>events.push(e)});
 const accepted=chat.respond('Question',{sessionKey,id:'admitted'});
 chat.event({event:'chat',payload:{sessionKey,runId:'admitted',state:'final'}});await accepted;
 chat.event({event:'chat',payload:{sessionKey:'agent:main:task:feed',runId:'background',state:'final',message:{content:'Private background result'}}});
 assert.equal(events.length,0);
 chat.event({event:'chat',payload:{sessionKey,runId:'admitted',state:'final',message:{content:'Visible answer after admission'}}});
 assert.deepEqual(events.map(e=>e.phase),['start','final']);assert.equal(events[1].response.text,'Visible answer after admission');
});

test('a continuation failure settles its lifecycle and retains media without replaying an input',()=>{
 const events=[],sessionKey='agent:main:main',chat=new GatewayChat({request:()=>assert.fail('must not submit an input')},{observeSessionKey:sessionKey,onObservedRun:e=>events.push(e)});
 chat.event({event:'agent',payload:{sessionKey,runId:'failed-continuation',stream:'lifecycle',data:{phase:'start'}}});
 chat.event({event:'chat',payload:{sessionKey,runId:'failed-continuation',state:'error',errorMessage:'Synthetic failure'}});
 assert.equal(events[1].phase,'error');assert.equal(events[1].error.message,'Synthetic failure');assert.equal(chat.observed.size,0);
 chat.event({event:'agent',payload:{sessionKey,runId:'media-continuation',stream:'lifecycle',data:{phase:'start'}}});
 chat.event({event:'agent',payload:{sessionKey,runId:'media-continuation',stream:'assistant',data:{mediaUrl:'/work/data/library/media/picture.png'}}});
 chat.event({event:'chat',payload:{sessionKey,runId:'media-continuation',state:'final'}});
 assert.equal(events[3].response.media[0].attachment.url,'/work/data/library/media/picture.png');
});

test('reconnecting a native continuation retrieves its terminal answer once, without resending either question',async()=>{
 const events=[],requests=[],sessionKey='agent:main:main',chat=new GatewayChat({request:async(method,args)=>{
  requests.push({method,...args});assert.equal(method,'agent.wait');return {status:'ok',terminalReply:{disposition:'visible',text:'Recovered continuation'}};
 }},{observeSessionKey:sessionKey,onObservedRun:e=>events.push(e)});
 chat.event({event:'agent',payload:{sessionKey,runId:'native-after-gap',stream:'lifecycle',data:{phase:'start'}}});
 chat.disconnect();chat.recover();await new Promise(r=>setImmediate(r));
 chat.event({event:'chat',payload:{sessionKey,runId:'native-after-gap',state:'final',message:{content:'Recovered continuation'}}});
 assert.deepEqual(events.map(e=>e.phase),['start','final']);assert.equal(events[1].response.text,'Recovered continuation');
 assert.equal(requests.length,1);assert.equal(requests[0].runId,'native-after-gap');assert.equal(chat.observed.size,0);
});

test('reconnection reads the accepted input and its completed native turn when wait has no terminal reply',async()=>{
 const requests=[],sessionKey='agent:main:main';
 const chat=new GatewayChat({request:async(method,args)=>{
  requests.push({method,...args});
  if(method==='chat.send')return {};
  if(method==='agent.wait')return {status:'ok',endedAt:100,stopReason:'stop'};
  assert.equal(method,'chat.history');assert.equal(args.sessionKey,sessionKey);
  return {messages:[
   {role:'assistant',stopReason:'stop',content:'Older answer',__openclaw:{runId:'older'}},
   {role:'user',idempotencyKey:'accepted:user',content:'Next question'},
   {role:'assistant',stopReason:'toolUse',__openclaw:{runId:'native-followup'}},
   {role:'assistant',stopReason:'stop',content:'Recovered exact answer',__openclaw:{runId:'native-followup'}},
   {role:'user',content:'Later question'},
   {role:'assistant',stopReason:'stop',content:'Unrelated later answer',__openclaw:{runId:'later'}}]};
 }},{observeSessionKey:sessionKey});
 const reply=chat.respond('Next question',{id:'accepted',sessionKey});chat.disconnect();chat.recover();
 assert.deepEqual(await reply,{text:'Recovered exact answer',recovered:true});
 chat.event({event:'chat',payload:{sessionKey,runId:'native-followup',state:'final',message:{content:'Recovered exact answer'}}});
 assert.equal(chat.observed.size,0);assert.equal(requests.filter(r=>r.method==='chat.send').length,1);
});

test('reconnection never treats another turn, unfinished tools or an error artifact as a recovered answer',async()=>{
 for(const messages of [
  [{role:'assistant',stopReason:'stop',content:'Unrelated',__openclaw:{runId:'other'}}],
  [{role:'user',idempotencyKey:'input:user'},{role:'assistant',stopReason:'toolUse',__openclaw:{runId:'native'}}],
  [{role:'user',idempotencyKey:'input:user'},{role:'user',idempotencyKey:'other:user'},{role:'assistant',stopReason:'stop',content:'Other turn',__openclaw:{runId:'native'}}],
  [{role:'user',idempotencyKey:'input:user'},{role:'assistant',stopReason:'error',content:'Provider error',__openclaw:{runId:'native'}}],
 ]){
  const chat=new GatewayChat({request:async method=>method==='agent.wait'?{status:'ok'}:method==='chat.history'?{messages}:{}});
  const done=chat.respond('input',{id:'input',sessionKey:'main'});chat.disconnect();chat.recover();
  await assert.rejects(done,e=>e.code==='outcome_unknown');assert.equal(chat.pending.size,0);
 }
});

test('recovered history previews are expanded through the native message endpoint',async()=>{
 const chat=new GatewayChat({request:async(method,args)=>{
  if(method==='chat.send')return {};
  if(method==='agent.wait')return {status:'ok'};
  const message={role:'assistant',stopReason:'stop',content:'Complete answer',__openclaw:{id:'native-message',runId:'input'}};
  if(method==='chat.history')return {messages:[{...message,content:'Preview',__openclaw:{...message.__openclaw,truncated:true}}]};
  assert.equal(method,'chat.message.get');assert.equal(args.messageId,'native-message');return {ok:true,message};
 }});
 const done=chat.respond('input',{id:'input',sessionKey:'main'});chat.disconnect();chat.recover();
 assert.deepEqual(await done,{text:'Complete answer',recovered:true});
});
