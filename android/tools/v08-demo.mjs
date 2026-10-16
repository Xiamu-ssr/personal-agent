// Local-only 0.8.1 integration host. Uses the real cloud HTTP/WS/content/Harness and
// cloud/test/query-fixture.mjs as a deterministic model. No secrets or external model.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { once } from 'node:events';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const output=path.resolve(process.env.V08_DEMO_OUTPUT || '/tmp/v08-android-shots'); fs.mkdirSync(output,{recursive:true});
const root=fs.mkdtempSync('/tmp/v08-android-cloud-');
for(const key of Object.keys(process.env)) if(/TOKEN|KEY|SECRET|PASSWORD|ANTHROPIC|ZENMUX|CLAUDE/i.test(key)) delete process.env[key];
Object.assign(process.env,{AGENT_ROOT:root,AGENT_TOKEN:'local-android-demo-only',AGENT_HOST:'127.0.0.1',AGENT_PORT:'18768',AGENT_TZ:'Asia/Shanghai'});
const module=(name)=>import(pathToFileURL(path.join(repo,'cloud',name)));
const [{Harness},{DeviceHub},{Content},{startServer},{Schedules},{migrateV08},{queryFixture}]=await Promise.all(['src/agent.mjs','src/devices.mjs','src/content.mjs','src/server.mjs','src/scheduler.mjs','src/migrate-v08.mjs','test/query-fixture.mjs'].map(module));
migrateV08({root,seedDir:path.join(repo,'cloud/seed')});
const write=(name,data)=>{const f=path.join(root,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,data)};
const copy=(source,dest)=>{fs.mkdirSync(path.dirname(path.join(root,dest)),{recursive:true});fs.copyFileSync(path.join(repo,source),path.join(root,dest))};
const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
const date=(offset)=>{const d=new Date(`${today}T12:00:00+08:00`);d.setDate(d.getDate()-offset);return d.toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'})};
function post(day,name,title,icon,body,character='a') {
    write(`data/feed/${day}/${name}.md`,`---\ntitle: ${title}\nsource: 豆豆演示 · 产品手记\nurl: https://example.test/article\npublished: ${day} 09:00\nicon: ${icon}\nimage: cover-${name}.png\n---\n${body}\n`);
    copy(`design/mascot/states/${({a:"idle",b:"happy",c:"working"})[character]}/still.png`,`data/feed/${day}/cover-${name}.png`);
    return {path:`data/feed/${day}/${name}.md`,title,date:day};
}
post(today,'1000-芽豆','芽豆，把小事放在心上','🌱','设计手记更新了三种角色。两片叶子和柔软的轮廓，让小尺寸头像也容易辨认。\n\n[查看设计手记](https://example.test/design)','a');
post(today,'0900-专注','给一天留一点空白','☕','本期小实验：把今天的目标缩成一件小事，给自己二十分钟专注时间。','c');
post(date(1),'1000-进展','每周运动，从十分钟开始','🌿','一周三次散步，先从饭后十分钟开始。\n\n| 本周 | 已完成 |\n| --- | --- |\n| 散步 | 2 / 3 次 |','b');
for(let i=2;i<10;i++) post(date(i),'0900-日常',`第 ${i} 天的小进展`,'🗞️','这是用于验证按日期翻页的本地演示动态。','a');
write('data/feed/动态说明.md','多给我看一点 AI 产品、设计和生活方式。每条点名来源，附上原文链接。没有新鲜事就不发。');
write('data/ideas/点子.md','## 健康\n- 🌿 **把散步放进日程**：晚饭后走十分钟，从一个容易坚持的动作开始。\n  > 帮我安排一周三次的饭后散步\n- 🥣 **一周简单晚餐**：用家里常见的食材，列一份轻松的菜单。\n  > 帮我规划一周简单晚餐\n\n## 学习\n- 📚 **每天读十页**：找一个你感兴趣的主题，陪你读完第一本书。\n  > 我想养成每天阅读的习惯\n\n## 连接应用\n- ✉️ **让收件箱清爽一点**：连上邮箱，重要的来信不会错过。\n  > 帮我连接 QQ 邮箱，看看重要来信\n');
for(const [name,domain,progress,plan] of [['每周运动','健康',67,'每周三次饭后散步，每次十分钟。'],['读完一本书','兴趣',35,'每天读十页，周日聊聊收获。']]) write(`data/goals/${name}.md`,`---\ntitle: ${name}\ndomain: ${domain}\ncadence: "0 8 * * 1"\ndue: 2026-12-31\nstatus: 追踪中\nprogress: ${progress}\n---\n## 计划\n${plan}\n\n## 步骤\n- [x] 定好固定时间\n- [x] 完成第一次\n- [ ] 坚持这一周\n\n## 记录\n${today}：已经开始，先保持轻松的节奏。\n`);
write('data/library/artifacts/一周计划/index.html','<!doctype html><html lang="zh"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px system-ui;margin:0;background:#f4f4f1;color:#202020;padding:24px}h1{font-size:30px}small{letter-spacing:3px;color:#777}.card{padding:20px;background:white;border-radius:20px;margin:18px 0}label{display:block;padding:12px 0}input{margin-right:12px;accent-color:black}.tag{font-size:12px;border:1px solid #ddd;border-radius:20px;padding:7px 12px}</style><small>A LITTLE EVERY DAY</small><h1>把日子过轻一点。</h1><p>这一周，给三件小事留个位置。</p><div class="card"><span class="tag">本周计划</span><h2>从十分钟开始</h2><label><input type="checkbox">饭后散步十分钟</label><label><input type="checkbox">读完今天的十页</label><label><input type="checkbox">周日整理一周收获</label></div><p>保持轻松，也是一种进步。</p><script>document.querySelectorAll("input").forEach((e,i)=>{e.checked=localStorage[i]==="1";e.onchange=()=>localStorage[i]=e.checked?"1":"0"})</script></html>');
write('data/library/artifacts/阅读笔记/index.md','# 阅读笔记\n\n## 今天的一句话\n好的习惯，从一个小得不会失败的动作开始。\n\n## 下次试试\n- 每天读十页\n- 留下一句自己的话\n');
for(const [i,c] of ['a','b','c'].entries()) copy(`design/mascot/states/${["idle","happy","working"][i]}/still.png`,`data/library/media/${today}/角色-${i+1}.png`);
copy('design/mascot/states/idle/light.mp4',`data/library/media/${today}/芽豆转台.mp4`);
write('data/soul/角色.md','- 名字：豆豆\n- 性格：温和、可靠、有好奇心\n- 口吻：简洁自然\n\n陪你把重要的事一点点做好。');
write(`data/soul/diary/${today}.md`,'# 今天\n\n认识了新的朋友，准备一起把小事做好。');
write('data/memory/profile/总档.md','# 总档\n\n用户正在尝试规律运动和阅读，喜欢简洁的设计。\n');
write('data/memory/interests/阅读.md','# 阅读\n\n每天读十页，从容易坚持的主题开始。');
const days=Array.from({length:7},(_,i)=>({date:date(6-i),sleepMinutes:420+i*7,restingHr:62-i,steps:5000+i*430,hrv:40+i}));
write('data/health/days.json',JSON.stringify({days}));
write('system/pair.json',JSON.stringify({code:'123456',expires:Date.now()+86400000,fails:0}));
const timers=new Set(); const later=(fn,ms)=>{const t=setTimeout(()=>{timers.delete(t);fn()},ms);timers.add(t)};
const listeners=new Set(); const events=[];
const bus={on:fn=>listeners.add(fn),emit:e=>{events.push(e);fs.appendFileSync(path.join(output,'cloud-events.jsonl'),JSON.stringify(e)+'\n');for(const fn of listeners)fn(e)}};
fs.writeFileSync(path.join(output,'cloud-events.jsonl'),'');
fs.writeFileSync(path.join(output,'model-inputs.jsonl'),'');
fs.writeFileSync(path.join(output,'message-requests.jsonl'),'');
const calls=[];let h;let chain=Promise.resolve();
const finish=q=>{q.emit({type:'result',subtype:'success'});q.emit({type:'system',subtype:'session_state_changed',state:'idle'})};
const speak=(value)=>h.speech.emit(value,{activityId:h.main.activityId});
const factory=queryFixture(calls,{onInput(q,message){
    const text=typeof message.message.content==='string'?message.message.content:JSON.stringify(message.message.content);
    const own=[...h.isolated].find(([,context])=>context.q===q);
    const sideId=own && h.history.get(own[0]).chatType==='side' ? own[0] : null;
    fs.appendFileSync(path.join(output,'model-inputs.jsonl'),JSON.stringify({text,busy:h.busy,activityId:sideId || h.main.activityId,...(sideId && {chatType:'side'})})+'\n');
    if(own && !sideId) {
        q.emit({type:'assistant',message:{content:[{type:'tool_use',id:'demo-background-read',name:'Read',input:{file_path:path.join(root,'data/ideas/点子.md')}}]}});
        later(()=>{q.emit({type:'assistant',message:{content:[{type:'text',text:'后台检查完成：演示资料已经整理好。'}]}});finish(q)},500);
        return;
    }
    if(sideId) {
        const context={activityId:sideId,chatType:'side'};
        q.emit({type:'system',subtype:'session_state_changed',state:'running'});
        if(!text.includes('[旁聊恢复上下文]') && q.received.length===1) {
            h.speech.emit({text:'这件事我们在旁聊里单独展开，主聊天里的事照常进行。'},context);
            later(()=>{h.speech.emit({text:'想先从哪一步开始？',options:[{label:'先做调研'},{label:'列个计划'}],cards:[{type:'link',url:'https://example.test/reading',title:'阅读计划参考',description:'本地演示资料，不包含个人信息。'}]},context);finish(q)},700);
        } else later(()=>{h.speech.emit({text:'补充收到了，我们继续这次旁聊。'},context);finish(q)},500);
        return;
    }
    if(text.includes('DEMO_INTERJECTION')) { speak({text:'补充收到了，我会按你刚才说的来。'});return }
    q.emit({type:'system',subtype:'session_state_changed',state:'running'});
    if(text.includes('[第一次聊天]')) {
        later(()=>speak({text:'你好，我是豆豆，住在你自己的云主机上。你不在的时候，我也能帮你把事情做好。'}),300);
        later(()=>speak({text:'先给我起个名字吧，也可以直接告诉我你喜欢的名字。',options:[{label:'豆豆'},{label:'小芽'},{label:'团子'}]}),700);
        later(()=>{speak({text:'连上手机和常用应用，我就能帮你做更多事。',cards:[{type:'device'},{type:'connector',id:'qq-mail'}]});finish(q);h.avatar.set('waiting')},1000);
    } else if(text.includes('DEMO_RECONNECT') || text.includes('DEMO_BACKGROUND')) {
        const reply=text.includes('DEMO_RECONNECT')?'断线期间补上的回复，只出现一次。':'回到前台补上的回复，只出现一次。';
        later(()=>{speak({text:reply});finish(q)},500);
    } else if(text.includes('DEMO_FINAL_SAY')) {
        q.emit({type:'assistant',message:{content:[{type:'text',text:'这段模型正文只保存在过程记录里。'}]}});
        speak({text:'这是最终答复，通过 say 完整发出。'});finish(q);
    } else if(text.includes('DEMO_MAIN_HOLD')) {
        speak({text:'主聊天正在整理资料，这句话只留在主聊天。'});
        later(()=>{speak({text:'主聊天的资料整理好了。'});finish(q)},45000);
    } else if(text.includes('DEMO_CHAT')) {
        speak({text:'我先看看这周的安排。'});
        q.emit({type:'assistant',message:{content:[{type:'tool_use',id:'local-read',name:'Read',input:{file_path:path.join(root,'data/memory/profile/总档.md')}}]}});
        later(()=>{speak({text:'可以从十分钟散步开始，也可以先排个时间。你想选哪一个？',options:[{label:'先散步',reply:'先帮我安排散步'},{label:'排个时间'}]});finish(q)},8000);
    } else if(text.includes('DEMO_BROWSER')) {
        chain=chain.then(async()=>{await h.browser.runAgent(async p=>p.goto(`http://127.0.0.1:18770/`));speak({text:'页面准备好了。需要时你可以接管。',cards:[{type:'browser'}]});finish(q)}).catch(()=>{speak({text:'演示浏览器打开失败'});finish(q)});
    } else if(text.includes('DEMO_ERROR')) {
        speak({text:'这次演示任务遇到了一点问题。'}); q.emit({type:'result',subtype:'error_during_execution'});q.emit({type:'system',subtype:'session_state_changed',state:'idle'});h.avatar.set('error');
    } else {
        later(()=>{speak({text:text==='豆豆'?'那就叫豆豆。接下来想做什么，随时告诉我。':'收到，我们从一个轻松的小步骤开始。',...(text==='豆豆'?{cards:[{type:'device'},{type:'connector',id:'qq-mail'}]}:{})});finish(q)},500);
    }
}});
let summaryDelay=350;
const summarize=async record=>{await new Promise(resolve=>setTimeout(resolve,summaryDelay));return record.kind==='chat'
    ? {title:'安排轻量运动',summary:'读取本周安排，并给出十分钟散步建议。'}
    : {title:'检查演示资料',summary:'在后台读取点子文档，完成资料检查。'}};
const hub=new DeviceHub();h=new Harness({hub,bus,log(){},queryFactory:factory,summarize});
const content=new Content({root,bus});const schedules=new Schedules({harness:h,content});h.startMain();
const server=startServer({harness:h,hub,bus,content,schedules,log(){}});await once(server,'listening');
// Test-only transport faults surround the real server; they never change cloud code.
let holdUntil=0,dropAcks=0,dropDelay=0,activitiesReads=0; const requests=[];
const upgrades=server.listeners('upgrade');server.removeAllListeners('upgrade');
server.on('upgrade',function(req,socket,head){
    if(req.url?.startsWith('/ws') && Date.now()<holdUntil) {socket.destroy();return}
    for(const handler of upgrades) handler.call(this,req,socket,head);
});
server.prependListener('request',(req,res)=>{
    if(req.method==='GET' && /^\/api\/activities(?:\?|$)/.test(req.url||'')) activitiesReads++;
    if(!/^\/api\/(?:send|side-chats|feed\/feedback|activities\/[^/]+\/send)(?:\?|$)/.test(req.url||'') || req.method!=='POST') return;
    let raw='';req.on('data',part=>{raw+=part});
    let entry;req.on('end',()=>{entry={path:req.url,body:JSON.parse(raw||'{}'),time:Date.now()};requests.push(entry);fs.appendFileSync(path.join(output,'message-requests.jsonl'),JSON.stringify(entry)+'\n')});
    const end=res.end.bind(res);res.end=(...args)=>{if(dropAcks>0){dropAcks--;if(entry) entry.droppedReceipt=true;if(dropDelay) later(()=>res.destroy(),dropDelay);else res.destroy();return res}return end(...args)};
});
const page=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><meta name="viewport" content="width=device-width"><style>body{font:24px system-ui;background:#f5f5f2;color:#222;padding:60px}main{background:white;border-radius:30px;padding:36px;max-width:680px}input,button{font:24px system-ui;border:1px solid #ccc;border-radius:14px;padding:15px;margin:12px 0}button{background:#222;color:white}small{color:#888}section{height:400px}</style><main><small>DOUDOU · LOCAL DEMO</small><h1>给今天留一个小计划。</h1><p>这是本机演示页面，可以安全体验接管。</p><input placeholder="写下一件小事" id="note"><br><button onclick="document.querySelector(\'h2\').textContent=document.querySelector(\'input\').value||\'已保存\'">保存计划</button><h2></h2><button onclick="confirm(\'确认保存这个演示计划？\')">网页确认框</button><section></section><p>你已经看到页面底部。</p></main>')});await new Promise(r=>page.listen(18770,'127.0.0.1',r));
const control=http.createServer(async(req,res)=>{try{let raw='';for await(const part of req) raw+=part;const body=JSON.parse(raw||'{}');
    if(body.action==='avatar') h.avatar.set(body.state,body.text);
    if(body.action==='feed-new') {const item=post(today,`${String(Date.now()).slice(-4)}-新动态`,'刚刚，一点新的灵感','✨','新内容到了。动态的红点只提示一次。','b');bus.emit({t:'feed_new',items:[item]})}
    if(body.action==='reset-chat') {write('system/chat.jsonl','');h.speech.used={};write('system/chat-options.json','{}');h.avatar.set('idle')}
    if(body.action==='send') await h.send(body.text);
    if(body.action==='disconnect-reply') {holdUntil=Date.now()+6000;server.closeSockets();await h.send('DEMO_RECONNECT')}
    if(body.action==='drop-ack') {dropAcks=body.count??2;dropDelay=body.delay??0}
    if(body.action==='background-job') await h.runIsolated('后台资料检查','DEMO_BACKGROUND_JOB');
    if(body.action==='summary-delay') summaryDelay=body.ms??350;
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,busy:h.busy,avatar:h.avatar.value,inputs:calls.flatMap(q=>q.received).length,history:h.speech.history(),requests,activitiesReads}));
}catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}))}});await new Promise(r=>control.listen(18769,'127.0.0.1',r));
fs.writeFileSync(path.join(output,'demo-host.json'),JSON.stringify({root,port:18768,control:18769,page:18770,pid:process.pid,model:'cloud/test/query-fixture.mjs',browser:'real CloudBrowser + local form'},null,2));
console.log('Local demo ready on 10.0.2.2:18768. Pairing code: 123456.');
let closed=false;async function shutdown(){if(closed)return;closed=true;for(const t of timers)clearTimeout(t);control.closeAllConnections();page.closeAllConnections();control.close();page.close();await h.close();await server.browserRoutes?.close();server.closeAllConnections();server.close();fs.writeFileSync(path.join(output,'cloud-summary.json'),JSON.stringify({events:events.length,inputs:calls.flatMap(q=>q.received).length,say:events.filter(e=>e.t==='say').length,interjection:calls.some(q=>q.received.some(m=>JSON.stringify(m).includes('DEMO_INTERJECTION')))},null,2));process.exit(0)}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
