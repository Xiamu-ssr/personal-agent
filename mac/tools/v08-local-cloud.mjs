// Real cloud HTTP/WS + Agent SDK, pointed exclusively at a scripted localhost model.
// All state, browser profiles and generated files live under the explicitly chosen /tmp directory.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const patchReview=process.env.V081_MAC === "1";
const roundTwo=process.env.V08_MAC_R2 === "1" || patchReview;
const output=process.env.V08_MAC_OUTPUT || '/tmp/v08-mac-shots';
fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'cloud-events.jsonl'),'');fs.writeFileSync(path.join(output,'summary-results.jsonl'),'');
const root=fs.mkdtempSync('/tmp/v08-mac-cloud-');
Object.assign(process.env,{AGENT_ROOT:root,AGENT_TOKEN:'local-fixture',AGENT_HOST:'127.0.0.1',AGENT_PORT:'0',AGENT_TZ:'Asia/Shanghai'});
const [{query},{Harness},{DeviceHub},{Content},{startServer},{Schedules},{migrateV08},{fakeAnthropic},{toolReply,textReply,resultFor,hasInput},{activitySummary}]=await Promise.all([
 import(path.join(repo,'cloud/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')),
 import(path.join(repo,'cloud/src/agent.mjs')),import(path.join(repo,'cloud/src/devices.mjs')),import(path.join(repo,'cloud/src/content.mjs')),
 import(path.join(repo,'cloud/src/server.mjs')),import(path.join(repo,'cloud/src/scheduler.mjs')),import(path.join(repo,'cloud/src/migrate-v08.mjs')),
 import(path.join(repo,'cloud/test/fake-anthropic.mjs')),import(path.join(repo,'cloud/test/native-fixture.mjs')),import(path.join(repo,'cloud/src/activity-summary.mjs'))]);
const write=(p,s)=>{fs.mkdirSync(path.dirname(path.join(root,p)),{recursive:true});fs.writeFileSync(path.join(root,p),s)};
migrateV08({root,seedDir:path.join(repo,'cloud/seed')});
write('data/soul/角色.md','- 名字：豆豆\n- 性格：温和、认真，有一点好奇心\n- 口吻：简洁自然\n');
write('data/soul/diary/2026-10-15.md','# 今天\n一起整理了一个新的工作节奏。\n');
write('data/memory/profile/总档.md','# 总档\n这是演示用户，关注 AI 产品与规律运动。\n');
write('data/memory/work/项目.md','# 项目\n整理一份每周产品观察。\n');
write('data/feed/动态说明.md','关注 AI 产品的真实发布、产品设计和科学进展。每条带原始来源，避免重复。\n');
const imageSource=path.join(repo,'mac/Resources/Mascot/idle/still.png');
for(let i=0;i<10;i++) {
 const date=`2026-10-${String(15-i).padStart(2,'0')}`;
 const title=i===0?'让重要的事实，回到信息流里':i===1?'一个更轻的每周回顾方式':`第 ${i+1} 天的产品观察`;
 write(`data/feed/${date}/0900-产品观察.md`,`---\ntitle: ${title}\nsource: 演示编辑部 · 产品手记\nurl: https://example.test/notes/${i}\npublished: ${date} 09:00\nicon: ${i%2?'🔎':'📰'}\n${i===0?'image: cover.png\n':''}---\n这是一条本地演示动态。我们把值得读的事实放在前面，留出空间给自己的判断。\n\n[阅读原文](https://example.test/notes/${i})\n${i===1?'\n| 频率 | 用途 |\n| --- | --- |\n| 每天 | 看新事实 |\n| 每周 | 回顾进展 |':''}`);
 if(i===0)fs.copyFileSync(imageSource,path.join(root,`data/feed/${date}/cover.png`));
}
write('data/ideas/点子.md','## 调研\n- 🔎 **做一份每周产品观察**：从你关心的 AI 产品出发，挑三件值得继续追的事。\n  > 帮我做一份每周产品观察\n- 📬 **让邮箱变得清爽一点**：连上邮箱，先找出值得留意的消息。\n  > 我想连接邮箱，整理重要消息\n## 健康\n- 🌿 **把散步放进日程里**：从每周三次开始，找到一个轻松的节奏。\n  > 帮我安排一个每周散步计划\n');
for(const [name,domain,progress,cadence] of [['每周运动','健康',35,'0 8 * * 1'],['每周产品观察','事业',60,'0 9 * * 5']])write(`data/goals/${name}.md`,`---\ntitle: ${name}\ndomain: ${domain}\ncadence: "${cadence}"\ndue: 2026-12-31\nstatus: 追踪中\nprogress: ${progress}\n---\n## 计划\n先找到一个能够坚持的节奏。\n## 步骤\n- [x] 定好时间\n- [ ] 完成下一次练习\n## 记录\n10 月 15 日：完成第一次回顾。\n`);
write('data/library/artifacts/一周计划/index.html','<!doctype html><html lang="zh"><meta charset="utf-8"><title>一周计划</title><style>body{margin:0;font:16px -apple-system;background:#fff;color:#111;padding:38px}small{color:#888}h1{font-size:38px;margin:12px 0 34px}.card{padding:22px;border-radius:20px;background:#f3f3f3;margin:14px 0}button{border:0;border-radius:20px;background:#111;color:white;padding:12px 22px}</style><small>豆豆为你整理</small><h1>留一点时间，<br>做在意的事。</h1><div class="card">周一 · 散步 30 分钟</div><div class="card">周三 · 读一篇长文章</div><div class="card">周五 · 产品观察</div><button onclick="this.textContent=\'已开始\'">开始这一周</button></html>');
write('data/library/artifacts/产品观察/index.md','# 本周产品观察\n\n## 三件值得留意的事\n- 从真实问题出发\n- 把交互做得更简单\n- 给长期工作留一点空间\n');
for(const [name,candidate] of [['芽豆','idle'],['等你','waiting'],['工作中','working']]) {
 const dest=`data/library/media/2026-10-15/${name}.png`;write(dest,'');fs.copyFileSync(fs.existsSync(path.join(repo,`design/mascot/states/${candidate}/still.png`)) ? path.join(repo,`design/mascot/states/${candidate}/still.png`) : imageSource,path.join(root,dest));
}
write('workspace/demo/context.txt','这是本地脚本化假模型的演示资料，没有个人信息。');
write('data/health/days.json',JSON.stringify({syncedAt:Date.now(),device:'演示手机',note:'本地演示数据',days:[{date:'2026-10-15',steps:6800,sleepMinutes:430,restingHr:62,hrv:null}]}));
const movie=path.join(repo,'mac/Resources/Mascot/happy/light.mp4');
if(fs.existsSync(movie)){write('data/library/media/2026-10-15/开心一刻.mp4','');fs.copyFileSync(movie,path.join(root,'data/library/media/2026-10-15/开心一刻.mp4'))}
const website=http.createServer((req,res)=> {res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(`<!doctype html><meta charset="utf-8"><title>一周计划 · 演示</title><style>body{font:22px -apple-system;padding:65px;color:#111;background:white}small{color:#888}h1{font-size:52px}.box{background:#f3f3f3;padding:35px;border-radius:25px;width:70%}input,button{font:22px -apple-system;border:1px solid #ddd;padding:18px;border-radius:14px}button{background:black;color:white}#result{margin-top:25px}</style><small>豆豆 · 本地演示</small><h1>为重要的事，留一点时间。</h1><div class="box"><p>你想给这一周起什么名字？</p><input id="name" placeholder="输入一个主题"><button onclick="document.querySelector('#result').textContent='这一周：'+document.querySelector('#name').value">保存</button><div id="result"></div></div>`) });
website.listen(0,'127.0.0.1');await once(website,'listening');
const listeners=new Set(),events=[];let readStarted=false,releaseRead,summaryStarted=false,releaseSummary;
const readGate=new Promise(r=>releaseRead=r);
const summaryGate=new Promise(r=>releaseSummary=r);
const bus={on:fn=>listeners.add(fn),emit:e=>{events.push(e);fs.appendFileSync(path.join(output,'cloud-events.jsonl'),JSON.stringify(e)+'\n');for(const fn of listeners)fn(e)}};
let scenario="",turnCounter=0;
const api=await fakeAnthropic(async body=> {
 if(typeof body.system === 'string' && body.system.includes('根据活动记录概括中文话题')) {
   const record=JSON.parse(body.messages[0].content),work=record.instruction.includes('0.8.1 验收');
   if(patchReview && work){summaryStarted=true;await summaryGate}
   return textReply(JSON.stringify(work ? {title:'阅读并整理资料',summary:'读取演示资料并整理了行动建议。'} : {title:'整理阅读清单',summary:'整理阅读方向，提供了下一步选项。'}));
 }
 const all=JSON.stringify(body.messages);
 if(roundTwo && all.includes('旁聊演示：')) {
   const last=body.messages.findLast(m=>m.role==='user')?.content;
   if(Array.isArray(last) && last.some(p=>p.type==='tool_result'))return textReply(' ');
   const follow=all.includes('先列三个方向');
   const reading=all.includes('阅读清单');
   return toolReply('side_say_'+api.requests.length,'mcp__doudou__say',{
     text:follow ? '好，我们先列三个方向：事实、计划，还有下一步。这个话题留在这条旁聊里继续。' : reading ? '我们单独整理阅读清单。你想先从产品设计，还是日常生活开始？' : '这条旁聊里，我们一起给周末留一点时间。先选一个你最在意的方向吧。',
     ...(!follow && {options:[{label:'先列三个方向',reply:'先列三个方向'},{label:'聊聊具体计划',reply:'聊聊具体计划'}]})
   });
 }
 if(scenario.includes('[动态]')||scenario.includes('[点子]'))return textReply(' ');
 if(scenario.includes('故障演示'))return {error:'本地演示错误',status:400};
 if(patchReview && scenario.includes('0.8.1 验收')) {
   if(!resultFor(body,'work_first'))return toolReply('work_first','mcp__doudou__say',{text:'我先读一下演示资料，再把过程和结论告诉你。'});
   if(!resultFor(body,'work_read'))return toolReply('work_read','Read',{file_path:path.join(root,'workspace/demo/context.txt')});
   if(!resultFor(body,'work_second'))return toolReply('work_second','mcp__doudou__say',{text:'资料看完了。接下来可以整理一个简短的行动清单。',cards:[{type:'connector',id:'gmail'},{type:'device',capability:'calendar_events'}]});
   if(!resultFor(body,'work_third'))return toolReply('work_third','mcp__doudou__say',{text:'行动清单已经整理好。先选一件今天就能做的小事，再安排一次回顾。'});
   return textReply('这段普通正文只留在活动轨迹里，不进入聊天。');
 }
 if(roundTwo ? all.includes('演示忙时') : scenario.includes('忙时插话') || scenario.includes('演示忙时')) {
   if(!resultFor(body,'work_first'))return toolReply('work_first','mcp__doudou__say',{text:'我先读一下计划，马上回来和你说。'});
   if(!resultFor(body,'work_read'))return toolReply('work_read','Read',{file_path:path.join(root,'workspace/demo/context.txt')});
   if(!resultFor(body,'work_second'))return toolReply('work_second','mcp__doudou__say',{text:all.includes('忙时插话')?'收到你的补充了，已经放进这一次的计划。想从哪一步开始？':'计划看完了，想从哪一步开始？',options:[{label:'从散步开始',reply:'我们先安排散步'},{label:'先看产品观察'}],cards:[{type:'goal',name:'每周运动'},{type:'browser'},{type:'image',path:'data/library/media/2026-10-15/芽豆.png'},{type:'file',path:'data/library/artifacts/产品观察/index.md',name:'产品观察.md'}]});
   return textReply(' ');
 }
 if(scenario.includes('[第一次聊天]')) {
   if(!resultFor(body,'onboarding_first'))return toolReply('onboarding_first','mcp__doudou__say',{text:'你好，我是住在你自己云主机上的个人助手。你不在的时候，我也能帮你做事。怎么称呼你？'});
   if(!resultFor(body,'onboarding_second'))return toolReply('onboarding_second','mcp__doudou__say',{text:'也给我起个名字吧。你喜欢哪一个？',options:[{label:'豆豆',reply:'豆豆这个名字很好'},{label:'芽芽'},{label:'小豆'}],cards:[{type:'device'},{type:'connector',id:'qq-mail'}]});
   return textReply(' ');
 }
 const suffix=String(turnCounter);
 if(!resultFor(body,'reply_'+suffix))return toolReply('reply_'+suffix,'mcp__doudou__say',{text:'好，我们从一件小事开始。我会把计划和下一步整理好，需要确认时再问你。',cards:[{type:'goal',name:'每周运动'},{type:'link',url:'https://example.test/notes',title:'一周产品观察',description:'本地演示链接'}]});
 return textReply(' ');
});
const hub=new DeviceHub();
const harness=new Harness({hub,bus,log(...items){if(String(items[0]).includes('activity summary failed'))console.log(...items)},summarize:async(record,{signal})=>{
 const result=await activitySummary(record,{signal,env:{ANTHROPIC_BASE_URL:api.url,ANTHROPIC_API_KEY:'fake-local-only'}});
 fs.appendFileSync(path.join(output,'summary-results.jsonl'),JSON.stringify({id:record.id,chatType:record.chatType,...result})+'\n');return result;
},queryFactory:({prompt,options})=>query({prompt:(async function*(){ for await(const m of prompt){ scenario=JSON.stringify(m.message.content);turnCounter++;yield m; } })(),options:{...options,settingSources:[],agentProgressSummaries:false,
 hooks:{...options.hooks,PreToolUse:[...options.hooks.PreToolUse,{matcher:'Read',hooks:[async input=>{if(input.tool_use_id==='work_read'){readStarted=true;await readGate}return {}}]}]},
 env:{...options.env,ANTHROPIC_BASE_URL:api.url,ANTHROPIC_API_KEY:'fake-local-only',ANTHROPIC_AUTH_TOKEN:'',CLAUDE_CONFIG_DIR:path.join(root,'system/sessions'),CLAUDE_CODE_TMPDIR:path.join(root,'native-tmp'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'}}})});
const content=new Content({root,bus}),schedules=new Schedules({harness,content});harness.startMain();
const server=startServer({harness,hub,bus,content,schedules,log(){},listen:{host:'127.0.0.1',port:0}});await once(server,'listening');
const control=http.createServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json');
 if(req.method==='POST' && req.url==='/release'){releaseRead();res.end('{"ok":true}');return}
 if(req.method==='POST' && req.url==='/release-summary'){releaseSummary();res.end('{"ok":true}');return}
 if(req.method==='GET' && req.url==='/browser-value'){res.end(JSON.stringify({value:await harness.browser.page.locator('#name').inputValue()}));return}
 if(req.method==='POST' && req.url==='/browser'){await harness.browser.runAgent(page=>page.goto(`http://127.0.0.1:${website.address().port}`));res.end('{"ok":true}');return}
 if(req.method==='POST' && req.url==='/feed-new'){bus.emit({t:'feed_new',items:[{path:'data/feed/2026-10-15/0900-产品观察.md',title:'演示',date:'2026-10-15'}]});res.end('{"ok":true}');return}
 res.end(JSON.stringify({readStarted,summaryStarted,busy:harness.busy,avatar:harness.avatar.value,results:events.filter(e=>e.t==='say').length,requests:api.requests.length}));
});control.listen(0,'127.0.0.1');await once(control,'listening');
fs.writeFileSync(path.join(output,'local-cloud.json'),JSON.stringify({root,server:`http://127.0.0.1:${server.address().port}`,control:`http://127.0.0.1:${control.address().port}`,pid:process.pid}));
console.log('LOCAL_CLOUD_READY '+server.address().port);
let closing=false;
async function close(){if(closing)return;closing=true;releaseRead();releaseSummary();await harness.close();await server.browserRoutes?.close();server.closeAllConnections();server.close();control.closeAllConnections();control.close();website.closeAllConnections();website.close();await api.close();fs.writeFileSync(path.join(output,'cloud-summary.json'),JSON.stringify({requests:api.requests.length,events:events.map(e=>({t:e.t,phase:e.phase,state:e.state,id:e.id})),root},null,2));process.exit(0)}
process.on('SIGINT',close);process.on('SIGTERM',close);
