import {testRoot} from './environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {once,EventEmitter} from 'node:events';
import {execFileSync} from 'node:child_process';
import {migrateV1} from '../scripts/migrate-v1.mjs';
import {initialize} from '../src/initialize.mjs';
import {Content} from '../src/content.mjs';
import {Harness} from '../src/agent.mjs';
import {DeviceHub} from '../src/devices.mjs';
import {ConnectorManager} from '../src/connectors.mjs';
import {startServer} from '../src/server.mjs';
import {config} from '../src/config.mjs';
import {testProvider} from '../src/providers.mjs';
import {readJson} from '../src/store.mjs';
import {createTavilyConnector} from '../connectors/tavily/index.mjs';
import {fakeConnectorApi} from './fake-connector-api.mjs';
const put=(r,f,s)=>{fs.mkdirSync(path.dirname(path.join(r,f)),{recursive:true});fs.writeFileSync(path.join(r,f),s);};
test('offline migration verifies full backup, preserves private config and content, flattens native memory, never imports sessions',()=>{
 const root=fs.mkdtempSync(path.join(testRoot,'migration-')),backup=path.join(testRoot,'full-v1-backup.tar.gz');
 put(root,'data/memory/profile/总档.md','用户偏好 · 原件');put(root,'data/memory/life/住房.md','事实 · 来源时间');put(root,'data/soul/角色.md','名字：豆豆');
 put(root,'.claude/skills/example/SKILL.md','原有方法');put(root,'data/library/sites/result/index.html','已交付');
 put(root,'system/browser/profile/Cookies','旧浏览器身份');put(root,'system/sessions/history.jsonl','旧会话');put(root,'system/chat.jsonl','旧聊天');put(root,'system/connectors/private/accounts.json','{"accounts":[]}');
 put(root,'system/app-settings.json',JSON.stringify({model:{provider:'zenmux',id:'anthropic/claude-haiku-5.5'},permissionMode:'auto'}));
 put(root,'data/goals/运动.md','---\ntitle: 运动\nstatus: 追踪中\nprogress: 40\ncadence: "0 8 * * *"\n---\n下一步');
 const result=migrateV1({root,backup});assert.equal(fs.existsSync(path.join(root,'system/browser')),false);assert.ok(execFileSync('tar',['-tzf',backup]).toString().includes('./system/browser/profile/Cookies'));assert.equal(result.sessionsImported,0);assert.equal(result.memoryFiles,2);assert.equal(result.goals,1);assert.equal(result.skills,1);
 assert.ok(fs.readFileSync(path.join(root,'USER.md'),'utf8').includes('用户偏好 · 原件'));
 assert.ok(fs.readFileSync(path.join(root,'memory/memory-life-住房.md'),'utf8').includes('事实 · 来源时间'));
 assert.equal(new Content({root}).goal('运动').status,'进行中');
 assert.equal(fs.readFileSync(path.join(root,'skills/example/SKILL.md'),'utf8'),'原有方法');
 assert.equal(fs.readFileSync(path.join(root,'data/library/sites/result/index.html'),'utf8'),'已交付');
 assert.equal(fs.existsSync(path.join(root,'system/sessions')),false);assert.equal(fs.existsSync(path.join(root,'system/chat.jsonl')),false);assert.equal(fs.existsSync(path.join(root,'data/memory')),false);
 assert.ok(execFileSync('tar',['-tzf',backup]).toString().includes('./system/sessions/history.jsonl'));
 assert.equal(readJson(path.join(root,'system/app-settings.json')).permissionMode,undefined);
 assert.equal(fs.statSync(backup).mode&0o777,0o600);assert.throws(()=>migrateV1({root,backup:path.join(testRoot,'again.tgz')}),/已迁移/);
});
test('initialization refuses an unmigrated legacy root',()=>{
 const r=fs.mkdtempSync(path.join(testRoot,'legacy-'));fs.mkdirSync(path.join(r,'data/memory'),{recursive:true});assert.throws(()=>initialize(r),/先停服/);
});
test('native memory API has no predefined categories, updates current files and rejects escaped paths',()=>{
 const r=fs.mkdtempSync(path.join(testRoot,'memory-'));initialize(r);const c=new Content({root:r});
 c.write('memory/2026-10-19.md','现状与来源');assert.equal(c.memory().categories,undefined);assert.ok(c.memory().items.some(i=>i.path==='memory/2026-10-19.md'));
 c.write('USER.md','当前偏好');assert.equal(c.read('USER.md'),'当前偏好');for(const p of ['../outside','system/openclaw.json','memory/../system/token'])assert.throws(()=>c.write(p,'x'));
 fs.symlinkSync('/tmp',path.join(r,'memory/escape'));assert.throws(()=>c.write('memory/escape/secret.md','x'));
});
test('goal delivery and acceptance remain separate states',()=>{
 const r=fs.mkdtempSync(path.join(testRoot,'goals-'));initialize(r);const c=new Content({root:r});
 for(const status of ['未开始','进行中','等待条件','待用户反馈','已完成','暂停','取消'])assert.equal(c.putGoal({name:'测试',title:'测试',status,progress:30,body:'进展与下一步'}).status,status);
 assert.throws(()=>c.putGoal({name:'../escape',title:'x'}));assert.throws(()=>c.putGoal({name:'测试',title:'x',status:'完成'}));
});
function product(t,runtime,definitions=[]){initialize(config.root);fs.rmSync(config.chatLog,{force:true});const events=[],bus={emit:e=>events.push(e),on(){}};const connectors=new ConnectorManager({root:config.root,definitions}),h=new Harness({hub:new DeviceHub(),bus,connectors,runtime});t.after(()=>h.close());return {h,events,bus,connectors};}
test('one main session forwards busy input, suppresses quiet heartbeat and keeps isolated output out of the prompt',async t=>{
 const calls=[],runtime={ready:true,respond:async(input,opts)=>{calls.push({input,...opts});await new Promise(r=>setTimeout(r,5));return {text:input.includes('静默')?'HEARTBEAT_OK':'执行完成'};},close:async()=>{},reload:async()=>{}};
 const {h}=product(t,runtime);await h.send('第一条');await h.send('补充一条');await h.waitForMain();
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.sessionKey==='agent:main:main'));assert.equal(h.busy,false);
 const count=h.speech.history().length;await h.runMain('静默');assert.equal(h.speech.history().length,count);
 await h.runIsolated('独立检索','检索结果',{mainContext:true});assert.notEqual(calls.at(-1).sessionKey,'agent:main:main');assert.match(calls.at(-1).input,/近期主聊天快照/);assert.match(calls.at(-1).input,/第一条/);await h.runMain('继续');assert.equal(calls.at(-1).input,'继续');assert.equal(h.pending,undefined);
});
test('a user followup reaches the running session before its tool work finishes and appears in that activity',async t=>{
 let finish;const calls=[],first=new Promise(resolve=>finish=resolve);
 const {h,events}=product(t,{respond:async(input,opts)=>{calls.push({input,...opts});opts.onAccepted?.({});return calls.length===1?first:{text:''};},close:async()=>{}});
 const original=await h.send('Investigate a synthetic topic'),followup=await h.send('Reply with progress first');
 assert.equal(calls.length,2,'busy user input must not wait for the original response');
 assert.equal(calls[0].sessionKey,calls[1].sessionKey);assert.equal(h.running.size,1);
 assert.equal(h.speech.history().find(m=>m.id===followup).activityId,original);
 assert.ok(h.taskHistory(original).items.some(s=>s.kind==='prompt'&&s.messageId===followup));
 assert.ok(events.some(e=>e.t==='activity_step'&&e.item.messageId===followup));
 finish({text:'Progress including the followup'});await h.waitForMain();assert.equal(h.busy,false);
 assert.equal(h.speech.history().filter(m=>m.role==='assistant').length,1);
});
test('a native followup starting as the first response ends retains tool context and its eventual answer',async t=>{
 let finishOriginal,finishNext;const first=new Promise(r=>finishOriginal=r),next=new Promise(r=>finishNext=r);let count=0;
 const {h}=product(t,{respond:async(input,opts)=>{opts.onAccepted?.({});return ++count===1?first:next;},close:async()=>{}});
 const original=await h.send('First'),followup=await h.send('Next');
 finishOriginal({text:'First answer'});await new Promise(r=>setImmediate(r));
 assert.equal(h.busy,true);assert.equal(h.sessionRuns.get('agent:main:main').id,original);
 finishNext({text:'Next answer'});await h.waitForMain();
 assert.equal(h.busy,false);assert.equal(h.history.get(original).latestResult,'Next answer');
 assert.equal(h.speech.history().find(m=>m.id===followup).activityId,original);
 assert.ok(h.speech.history().some(m=>m.text==='Next answer'));
});
test('dynamic Tavily arguments survive JSON routing; malformed calls show the real error and make no paid request',async t=>{
 const api=await fakeConnectorApi(req=>({data:req.path==='/usage'?{}:{results:[{title:'Synthetic result'}]}}));t.after(()=>api.close());
 const definition=createTavilyConnector({baseUrl:api.url}),{h}=product(t,{close:async()=>{}},[definition]);
 await h.connectors.addAccount('tavily',{apiKey:'tvly-local-synthetic-key'});
 h.history.put('routing',{status:'running'});h.sessionRuns.set('agent:main:main',{id:'routing'});
 const call=args_json=>h.productTool('call',{sessionKey:'agent:main:main',name:'tavily.search',args_json});
 for(const input of ['{}','[]','{broken',null]){
  const failure=await call(input);assert.equal(failure.isError,true);assert.ok(JSON.parse(failure.content[0].text).parameters.properties.query);
 }
 assert.equal(api.requests.filter(r=>r.path==='/search').length,0);
 const success=await call(JSON.stringify({query:'synthetic query',depth:'basic'}));assert.notEqual(success.isError,true);
 assert.equal(api.requests.find(r=>r.path==='/search').body.query,'synthetic query');
 assert.ok(h.taskHistory('routing').items.some(i=>i.isError&&i.text.includes('query')));
});
test('device ownership stays a role; task GUI capability is not blocked by a hard read/write classifier',async t=>{
 const {h}=product(t,{close:async()=>{}});const ws=new EventEmitter();ws.close=()=>{};ws.send=()=>{};
 h.hub.register(ws,{id:'fixture-phone',name:'测试手机',kind:'android',role:'owner',capabilities:[{name:'phone_use',enabled:true}]});
 assert.equal(h.hub.known()[0].role,'owner');assert.ok(h.hub.tools().some(t=>t.name==='call_device'));
 const id='owned-run';h.sessionRuns.set('agent:main:main',{id});h.history.put(id,{status:'running'});
 const catalog=await h.productTool('catalog',{sessionKey:'agent:main:main',group:'devices'});assert.ok(catalog.content[0].text.includes('call_device'));
});

test('device catalog distinguishes offline, missing implementation and revoked permission; registration updates preserve pending calls',async()=>{
 const hub=new DeviceHub(),ws=new EventEmitter();ws.close=()=>{};
 let call;ws.send=value=>{call=JSON.parse(value);};
 const device={id:'fixture-device-status',name:'测试设备',kind:'android',role:'agent',capabilities:[{name:'phone_use',title:'手机操作',description:'真实手机操作',args:'{"op":"snapshot"}',enabled:false,status:'permission_required',unavailableReason:'手机操作尚未获得无障碍授权'}]};
 hub.register(ws,device);
 const catalog=JSON.parse((await hub.tools().find(t=>t.name==='list_devices').execute({})).content[0].text).find(d=>d.id===device.id);
 assert.equal(catalog.online,true);assert.equal(catalog.role,'agent');assert.equal(catalog.capabilities[0].enabled,false);assert.match(catalog.capabilities[0].unavailableReason,/无障碍授权/);
 await assert.rejects(hub.call(device.id,'phone_use',{}),/无障碍授权/);
 await assert.rejects(hub.call(device.id,'not_implemented',{}),/当前版本没有提供/);
 const enabled={...device,capabilities:device.capabilities.map(c=>({...c,enabled:true,status:'ready',unavailableReason:undefined}))};
 hub.register(ws,enabled);const pending=hub.call(device.id,'phone_use',{op:'snapshot'});
 hub.register(ws,enabled);hub.handleResult({id:call.id,ok:true,data:{nodes:[]}});
 assert.deepEqual(await pending,{nodes:[]});assert.equal(ws.listenerCount('close'),1);
 const interrupted=hub.call(device.id,'phone_use',{op:'snapshot'});
 const rejected=assert.rejects(interrupted,/连接已替换/);
 const replacement=new EventEmitter();replacement.close=()=>{};replacement.send=()=>{};
 hub.register(replacement,enabled);await rejected;assert.equal(hub.devices.get(device.id).pending.size,0);
 ws.emit('close');assert.equal(hub.known().find(d=>d.id===device.id).online,true);
 replacement.emit('close');assert.equal(hub.known().find(d=>d.id===device.id).online,false);
 await assert.rejects(hub.call(device.id,'phone_use',{}),/设备离线/);
});
test('failed scheduled checks stay in activities while a failed user request reports the failure in chat',async t=>{
 const {h}=product(t,{respond:async()=>{throw new Error('HTTP 402');},close:async()=>{}});
 const checked=await h.runMain('定时检查',{id:'scheduled-error',reportError:false});assert.equal(checked.ok,false);assert.equal(h.history.get('scheduled-error').status,'error');assert.equal(h.speech.history().length,0);
 const id=await h.send('用户发来的请求');assert.ok(id);await h.waitForMain();assert.equal(h.speech.history().filter(m=>m.error).length,1);
});
test('new HTTP protocol is mandatory and internal tools cannot be reached through proxy headers',async t=>{
 const {h,bus,connectors}=product(t,{ready:true,close:async()=>{}});
 const server=startServer({harness:h,hub:h.hub,bus,connectors,log(){},listen:{host:'127.0.0.1',port:0}});await once(server,'listening');t.after(async()=>{server.closeSockets();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base='http://127.0.0.1:'+server.address().port,headers={authorization:`Bearer ${config.token}`,'X-Doudou-Protocol':'2'};
 assert.equal((await fetch(base+'/api/state',{headers:{authorization:headers.authorization}})).status,426);
 assert.equal((await fetch(base+'/api/state',{headers:{...headers,'X-Doudou-Protocol':'1'}})).status,426);
 const state=await fetch(base+'/api/state',{headers});assert.equal(state.status,200);
 assert.equal((await fetch(base+'/health')).status,200);
 assert.equal((await fetch(base+'/internal/call',{method:'POST',headers:{...headers,'X-Real-IP':'203.0.113.9'},body:'{}'})).status,403);
 const memory=await (await fetch(base+'/api/memory',{headers})).json();assert.equal(memory.kernel,'openclaw');assert.equal(memory.categories,undefined);
 const library=await fetch(base+'/api/library',{headers}),etag=library.headers.get('etag');assert.ok(etag);assert.match(library.headers.get('vary'),/Authorization/);
 assert.equal((await fetch(base+'/api/library',{headers:{...headers,'if-none-match':etag}})).status,304);
 assert.equal((await fetch(base+'/api/library',{headers:{'X-Doudou-Protocol':'2','if-none-match':etag}})).status,401);
 const rel='data/library/media/revalidation.txt';h.content.write(rel,'first');const resource=await fetch(base+'/files/'+rel,{headers}),fileTag=resource.headers.get('etag');assert.equal(await resource.text(),'first');
 assert.equal((await fetch(base+'/files/'+rel,{headers:{...headers,'if-none-match':fileTag}})).status,304);
 h.content.write(rel,'second');const updated=await fetch(base+'/files/'+rel,{headers:{...headers,'if-none-match':fileTag}});assert.equal(updated.status,200);assert.equal(await updated.text(),'second');assert.notEqual(updated.headers.get('etag'),fileTag);
});
test('live running activities keep the started timestamp required by both native apps',async t=>{
 let finish;
 const {h,bus,connectors}=product(t,{ready:true,respond:()=>new Promise(resolve=>{finish=()=>resolve({text:'已完成检查'});}),close:async()=>{}});
 const done=h.runIsolated('检查运行中的活动','检查活动列表',{id:'running-list-contract',chatType:'side'});
 t.after(async()=>{finish?.();await done;});
 const server=startServer({harness:h,hub:h.hub,bus,connectors,log(){},listen:{host:'127.0.0.1',port:0}});
 await once(server,'listening');t.after(async()=>{server.closeSockets();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base='http://127.0.0.1:'+server.address().port,headers={authorization:`Bearer ${config.token}`,'X-Doudou-Protocol':'2'};
 const page=await (await fetch(base+'/api/activities',{headers})).json();
 const state=await (await fetch(base+'/api/state',{headers})).json();
 for(const row of [page.running.find(r=>r.id==='running-list-contract'),state.activities.find(r=>r.id==='running-list-contract')]){
  assert.equal(row.id,'running-list-contract');assert.equal(row.chatType,'side');
  assert.ok(Number.isSafeInteger(row.started)&&row.started>0,'running rows need started, not the completed-row ts field');
  assert.equal(row.summary,'');
 }
 finish();await done;
 const completed=await (await fetch(base+'/api/activities',{headers})).json();
 assert.equal(completed.running.length,0);assert.ok(completed.recent.find(r=>r.id==='running-list-contract').ts>0);
});
test('both provider protocols probe their own endpoints without exposing the submitted credential',async()=>{
 for(const protocol of ['anthropic','openai']){
  let endpoint;const value=await testProvider({protocol,baseUrl:'https://example.test/v1',apiKey:'fixture-test-key',model:'fixture-model'},{request:async(url)=>{endpoint=url;return Response.json(protocol==='openai'?{choices:[]}:{content:[]});}});
  assert.equal(value.ok,true);assert.ok(endpoint.endsWith(protocol==='openai'?'/v1/chat/completions':'/v1/messages'));
 }
});

test('activity history serializes native and product tool results as first-class steps',async t=>{
 let finish;const {h,bus,connectors}=product(t,{ready:true,respond:()=>new Promise(resolve=>{finish=()=>resolve({text:'已读完目标'});}),close:async()=>{}});
 const done=h.runMain('检查目标',{id:'tool-history-contract'});
 await new Promise(r=>setImmediate(r));t.after(async()=>{finish?.();await done;});
 await h.productTool('event',{sessionKey:'agent:main:main',phase:'before',tool:'read'});
 await h.productTool('event',{sessionKey:'agent:main:main',phase:'after',tool:'read'});
 await h.productTool('call',{sessionKey:'agent:main:main',name:'goals.list',args_json:'{}'});
 const server=startServer({harness:h,hub:h.hub,bus,connectors,log(){},listen:{host:'127.0.0.1',port:0}});await once(server,'listening');t.after(async()=>{server.closeSockets();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const headers={authorization:`Bearer ${config.token}`,'X-Doudou-Protocol':'2'};
 const history=await(await fetch('http://127.0.0.1:'+server.address().port+'/api/activities/tool-history-contract/history',{headers})).json();
 assert.deepEqual(history.items.map(i=>i.kind),['prompt','tool','tool_result','tool','tool_result']);
 for(const step of history.items){assert.equal(typeof step.text,'string');assert.ok(Number.isFinite(Date.parse(step.time)));}
 assert.equal(history.items[2].tool,'read');assert.equal(history.items[4].tool,'goals.list');
 finish();await done;
});

test('feed and personalized Idea references send through one main-chat API, with optional comments and immutable history snapshots',async t=>{
 const calls=[];const {h,bus,connectors}=product(t,{ready:true,respond:async(input,options)=>{calls.push({input,...options});return{text:'收到引用'};},close:async()=>{}});
 const content=new Content({root:config.root});content.write('data/ideas/点子.md','## 最近可以试试\n- 🌱 **晚饭后散步**：从十分钟开始\n  > 帮我安排一次饭后散步\n');
 content.write('data/feed/2026-10-19/1000-news.md','---\ntitle: 演示动态\nsource: 示例来源\n---\n有来源的正文');
 const server=startServer({harness:h,hub:h.hub,bus,connectors,content,log(){},listen:{host:'127.0.0.1',port:0}});await once(server,'listening');t.after(async()=>{server.closeSockets();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base='http://127.0.0.1:'+server.address().port,headers={authorization:`Bearer ${config.token}`,'X-Doudou-Protocol':'2','Content-Type':'application/json'};
 const post=(route,body)=>fetch(base+route,{method:'POST',headers,body:JSON.stringify(body)});
 const ideas=await(await fetch(base+'/api/ideas',{headers})).json(),idea=ideas.groups[0].items[0];
 assert.equal(calls.length,0,'browsing/selecting Ideas must not start a run');
 const quote={kind:'idea',id:idea.id,revision:ideas.revision,title:'untrusted title'};
 for(const [n,text]of ['', '只走十分钟'].entries()){
  const body={text,quote,clientId:'idea-message-'+n};const response=await post('/api/send',body);assert.equal(response.status,200);const accepted=await response.json();
  assert.deepEqual(await(await post('/api/send',body)).json(),accepted);await h.waitForMain();
 }
 assert.equal(calls.length,2,'acknowledgement retry must not run twice');
 assert.ok(calls.every(c=>c.sessionKey==='agent:main:main'));assert.match(calls[0].input,/帮我安排一次饭后散步/);assert.match(calls[1].input,/只走十分钟/);
 const users=h.speech.history().filter(m=>m.role==='user');assert.equal(users[0].text,'');assert.equal(users[0].quote.title,idea.title);assert.equal(users[1].text,'只走十分钟');
 content.write('data/ideas/点子.md','## 新的一批\n- 📷 **挑十张照片**：周末的小事\n  > 帮我整理照片\n');
 assert.equal(h.speech.history().find(m=>m.id===users[0].id).quote.reply,idea.reply,'history retains the adopted Idea after refresh');
 assert.equal((await post('/api/send',{text:'保留附言',quote,clientId:'stale-idea'})).status,409);assert.equal(calls.length,2);
 const feed=await post('/api/send',{text:'',quote:{kind:'feed',path:'data/feed/2026-10-19/1000-news.md'},clientId:'feed-reference'});assert.equal(feed.status,200);await h.waitForMain();
 assert.match(calls.at(-1).input,/有来源的正文/);assert.equal(h.speech.history().filter(m=>m.role==='user').at(-1).quote.kind,'feed');
 assert.equal((await post('/api/ideas/click',{id:idea.id,revision:ideas.revision})).status,404,'deleted immediate-adoption route is not a compatibility path');
 assert.equal((await post('/api/feed/feedback',{path:'data/feed/2026-10-19/1000-news.md',action:'discuss'})).status,400);
});
