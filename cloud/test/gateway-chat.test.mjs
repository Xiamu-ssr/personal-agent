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
