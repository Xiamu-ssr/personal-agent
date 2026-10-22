// Product presentation around a single native OpenClaw agent. No model/tool execution loop here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from './config.mjs';
import { OpenClawRuntime, MAIN_SESSION } from './openclaw-runtime.mjs';
import { TaskHistory, TaskError, listedActivity } from './task-history.mjs';
import { Speech } from './say.mjs';
import { Avatar } from './avatar.mjs';
import { PageScreenshot } from './page-screenshot.mjs';
import { Content } from './content.mjs';
import { triggerTitle } from './activity-title.mjs';
import { cronFields } from './cron.mjs';
import { defineTool } from './product-tools.mjs';
import { appendJsonl, readJson, tailJsonl } from './store.mjs';
import { MessageInbox } from './message-inbox.mjs';
import { writePrivateJson } from './private-json.mjs';
import { validateMessage, prepareAttachments, userContent } from './attachments.mjs';
import { runFailureText } from './gateway-chat.mjs';
import { goalFields } from './content-contract.mjs';
const quiet=text=>!text||/^(?:HEARTBEAT_OK|NO_REPLY|NONE)[.!。\s]*$/.test(text);
const result=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
export class Harness {
 constructor({hub,bus,log=()=>{},connectors,runtime}){
  Object.assign(this,{hub,bus,connectors});this.log=(...args)=>log(...args.map(v=>connectors.redact(v)));
  for(const [key,value]of Object.entries(process.env))if(/(?:TOKEN|KEY|SECRET|PASSWORD)$/i.test(key)&&value?.length>=8)connectors.knownSecrets.add(value);
  this.runtime=runtime||new OpenClawRuntime({log:this.log});this.busy=false;this.closed=false;this.running=new Map();this.sessionRuns=new Map();this.mainTask=Promise.resolve();
  this.history=new TaskHistory({root:config.root,redact:s=>connectors.redact(s)});
  this.inbox=new MessageInbox(config.root);this.delivering=new Set();
  this.receipts=new Map(tailJsonl(config.chatLog,Number.MAX_SAFE_INTEGER).filter(m=>m.clientId).map(m=>[m.clientId,m.id]));
  this.content=new Content({root:config.root,bus,timezone:config.timezone});this.pages=new PageScreenshot({root:config.root});
  this.speech=new Speech({root:config.root,bus,redact:s=>connectors.redact(s),onSay:e=>{const run=this.running.get(e.activityId);if(run)run.said=true;}});
  this.avatar=new Avatar({bus,busy:()=>this.running.size>0,waiting:()=>this.speech.waiting()});
 }
 async startMain(){await this.runtime.start();for(const record of this.inbox.records.values())this.deliverMessage(record);}
 async settingsChanged(){await this.runtime.reload();}
 step(id,kind,text,tool,extra={}){if(!this.history.records.has(id))return;const item={kind,text:this.connectors.redact(String(text||'')),time:new Date().toISOString(),...(tool&&{tool}),...extra};this.history.appendStep(id,item);this.bus.emit({t:'activity_step',id,item});}
 groups(){
  const wrap=fn=>async args=>result(await fn(args));
  return {...this.connectors.toolGroups(),devices:this.hub.tools(),page:this.pages.tools(),speech:this.speech.tools(),
   content:[defineTool('publish','校验并发布已有的动态、点子、目标或资源文件；文件是唯一事实源，错误返回具体原因。',{path:z.string()},wrap(({path})=>this.content.publish(path)))],
   activities:[defineTool('list','查看已经运行的后台工作及结果摘要。',{},wrap(()=>this.history.recent())),defineTool('get','读取一项活动的完整结果和过程。',{id:z.string()},wrap(({id})=>this.history.get(id)))],
   schedules:[defineTool('list','查看定时安排。',{},wrap(()=>readJson(config.scheduleFile,[]))),
    defineTool('put','创建或更新已授权的提醒/定时推进。cron 与 at 二选一，at 是 ISO 时间；enabled=false 停止。',{id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),name:z.string().max(100),prompt:z.string().max(8000),cron:z.string().optional(),at:z.string().optional(),enabled:z.boolean()},wrap(job=>{
      if(job.enabled && (!job.prompt.trim() || !!job.cron===!!job.at))throw new Error('请提供提示词及 cron 或 at');
      if(job.cron)cronFields(job.cron);if(job.at&&!Number.isFinite(Date.parse(job.at)))throw new Error('at 时间不正确');
      const jobs=readJson(config.scheduleFile,[]),old=jobs.find(j=>j.id===job.id);if(old&&old.kind!=='reminder')throw new Error('内置安排请在 App 中管理');
      const updated={...job,kind:'reminder'};const successFile=path.join(config.system,'schedule-success.json'),success=readJson(successFile,{});delete success[job.id];writePrivateJson(successFile,success);writePrivateJson(config.scheduleFile,[...jobs.filter(j=>j.id!==job.id),updated]);this.bus.emit({t:'schedules_updated'});return updated;
    }))],
   goals:[defineTool('list','列出目标及当前状态。',{},wrap(()=>this.content.goals())),defineTool('get','读取一个目标。',{name:z.string()},wrap(({name})=>this.content.goal(name))),
    defineTool('put','创建或更新目标；用户明确认可后才可标记已完成，交付先标待用户反馈。',goalFields,wrap(args=>this.content.putGoal(args)))]};
 }
 async productTool(route,args){
  const run=this.sessionRuns.get(args.sessionKey);
  if(route==='event'){if(run&&!String(args.tool).startsWith('doudou_')){this.step(run.id,args.phase==='before'?'tool':'tool_result',args.phase==='before'?args.tool:(args.error?'执行未完成':'执行完成'),args.tool);this.avatar.working(args.tool);}return result({ok:true});}
  if(!run)throw new Error('这个工具没有当前运行上下文');
  if(route==='catalog'){
   const groups=this.groups();if(!args.group)return result(Object.entries(groups).map(([name,tools])=>({group:name,tools:tools.map(t=>({name:`${name}.${t.name}`,description:t.description}))})));
   if(!groups[args.group])throw new Error('没有这组工具');return result(groups[args.group].map(t=>({name:`${args.group}.${t.name}`,description:t.description,parameters:t.parameters})));
  }
  if(route==='say'){
   if(run.silent)throw new Error('本次内容更新不发聊天消息，请把成果写入对应栏目');
   const {sessionKey,...value}=args;this.speech.emit(value,{activityId:run.id,chatType:run.chatType});return result({ok:true});
  }
  if(route!=='call')throw new Error('没有这个工具入口');
  const [group,name,...tail]=String(args.name||'').split('.');const tool=!tail.length&&this.groups()[group]?.find(t=>t.name===name);
  if(!tool)throw new Error('没有这个工具，请查看目录');
  if(run.silent&&group==='speech')throw new Error('本次内容更新不发聊天消息');
  this.step(run.id,'tool',`${group}.${name}`,`${group}.${name}`);
  try{
   if(typeof args.args_json!=='string')throw new Error('args_json 必须是 JSON 对象字符串');
   let values;try{values=JSON.parse(args.args_json);}catch{throw new Error('args_json 不是有效 JSON');}
   if(!values||typeof values!=='object'||Array.isArray(values))throw new Error('args_json 必须编码一个 JSON 对象');
   this.avatar.working(`${group}.${name}`,values);
   const value=group==='speech'?result({id:this.speech.emit(values,{activityId:run.id,chatType:run.chatType}).id}):await tool.execute(values,{onStart:()=>{}});
   const detail=value.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')||'操作未完成';
   this.step(run.id,'tool_result',value.isError?detail.slice(0,1200):'操作完成',`${group}.${name}`,{isError:!!value.isError});
   if(group==='speech')run.said=true;
   return this.connectors.redact(value);
  }catch(e){
   const message=this.connectors.redact(e.issues?e.issues.map(i=>`${i.path.join('.')||'参数'}: ${i.message}`).join('; '):e.message);
   this.step(run.id,'tool_result',`调用失败：${message}`,`${group}.${name}`,{isError:true});
   return {...result({error:message,parameters:tool.parameters,instruction:'按 parameters 构造参数对象，再 JSON.stringify 后传入 args_json；不要重复同一错误调用。'}),isError:true};
  }
 }
 async execute(prompt,{id=crypto.randomUUID(),label='处理消息',sessionKey=MAIN_SESSION,chatType,attachments=[],silent=false,reportError=true,kind='chat',scheduleId,onAccepted}={}){
  if(this.closed)throw new Error('云端正在关闭');
  const controller=new AbortController(),run={id,label,sessionKey,controller,chatType,silent,said:false,incoming:new Set(),started:Date.now()};
  this.running.set(id,run);this.sessionRuns.set(sessionKey,run);this.history.put(id,{title:label,kind,status:'running',sessionKey,chatType,scheduleId});this.history.rememberPrompt(id,prompt,attachments);
  this.busy=[...this.running.values()].some(r=>r.sessionKey===MAIN_SESSION);this.bus.emit({t:'status',busy:this.busy});this.bus.emit({t:'activity',phase:'started',id,title:label,ts:Date.now()});this.avatar.working();
  let ok=false;
  try{
   const input=userContent(config.root,prompt,attachments);
   const response=await this.runtime.respond(input,{sessionKey,signal:controller.signal,id,onAccepted});
   if(response.text)this.step(id,'result',response.text);
   if(!silent&&(!run.said||response.media?.length)&&(!quiet(response.text)||response.media?.length))this.speech.emit({text:response.text},{activityId:id,chatType,nativeMedia:response.media});
   await this.drainMain(run);
   const latest=run.latestResponse||response.text;
   this.history.put(id,{status:'done',endedAt:Date.now(),summary:quiet(latest)?'已检查，无新变化':latest.slice(0,180),latestResult:latest,usage:response.usage});ok=true;
   return {ok:true,text:response.text};
  }catch(e){onAccepted?.(null,e);await this.drainMain(run);const stopped=controller.signal.aborted,message=this.connectors.redact(runFailureText(e));if(!stopped)this.log('OpenClaw run failed',id,e.message);this.history.put(id,{status:stopped?'stopped':e.code==='outcome_unknown'?'unknown':'error',endedAt:Date.now(),summary:stopped?'已停止':message});if(!silent&&!stopped&&reportError)this.speech.emit({text:(e.code==='outcome_unknown'?'结果待确认：':'这次没完成：')+message},{activityId:id,chatType,error:true});return {ok:false,error:e.message};
  }finally{
   this.running.delete(id);this.sessionRuns.delete(sessionKey);this.busy=[...this.running.values()].some(r=>r.sessionKey===MAIN_SESSION);
   this.bus.emit({t:'status',busy:this.busy});this.bus.emit({t:'activity',phase:'done',id,title:label,status:this.history.get(id).status,summary:this.history.get(id).summary,ts:Date.now()});
   this.content.discoverFeed();this.avatar.settle(ok);
  }
 }
 async drainMain(run){while(run.incoming.size)await Promise.allSettled([...run.incoming]);}
 async waitForMain(){let task;do{task=this.mainTask;await task;}while(task!==this.mainTask);}
 runMain(prompt,options={}){
  const run=this.sessionRuns.get(MAIN_SESSION);
  if(run?.controller.signal.aborted)return this.mainTask.then(()=>this.runMain(prompt,options));
  if(!run){this.mainTask=this.execute(prompt,{label:triggerTitle(prompt)||'处理消息',...options});return this.mainTask;}
  const id=options.id||crypto.randomUUID();this.step(run.id,'prompt',prompt,null,{from:'user',messageId:id,attachments:options.attachments||[]});
  const done=(async()=>{
   try{
    const response=await this.runtime.respond(userContent(config.root,prompt,options.attachments||[]),{sessionKey:MAIN_SESSION,signal:run.controller.signal,id,onAccepted:options.onAccepted});
    if(response.text||response.media?.length){run.latestResponse=response.text;this.step(run.id,'result',response.text);if(!quiet(response.text)||response.media?.length)this.speech.emit({text:response.text},{activityId:run.id,nativeMedia:response.media});}
    return {ok:true,text:response.text};
   }catch(e){options.onAccepted?.(null,e);if(!run.controller.signal.aborted){this.log('OpenClaw steered input failed',id,e.message);if(options.reportError!==false)this.speech.emit({text:'这条消息没完成：'+this.connectors.redact(runFailureText(e))},{activityId:run.id,error:true});}return {ok:false,error:e.message};}
  })();
  run.incoming.add(done);done.finally(()=>run.incoming.delete(done));
  const mainTask=this.mainTask;return done.then(reply=>reply.ok?mainTask:reply);
 }
 deliverMessage(record){
  const {entry,promptText}=record,id=entry.id;if(this.delivering.has(id))return;
  // The inbox is committed before the visible chat log. Recover a crash between them.
  if(!tailJsonl(config.chatLog,Number.MAX_SAFE_INTEGER).some(m=>m.id===id))appendJsonl(config.chatLog,entry);
  if(entry.clientId)this.receipts.set(entry.clientId,id);
  this.delivering.add(id);
  this.runMain(promptText,{id,label:(entry.text||entry.quote?.title||'附件').replace(/\s+/g,' ').slice(0,32),attachments:entry.attachments||[],
   onAccepted:(_ack,error)=>{if(!error)this.inbox.received(id);}})
   .then(()=>this.inbox.received(id),e=>this.log('message delivery failed',id,e.message)).finally(()=>this.delivering.delete(id));
 }
 async send(text,source='app',attachments=[],{ifEmpty=false,promptText=text,quote,clientId}={}){
  if(this.closed)throw new Error('云端正在关闭');if(ifEmpty&&this.speech.history(1).length)return null;
  if(clientId&&this.receipts.has(clientId))return this.receipts.get(clientId);
  const msg=validateMessage(config.root,promptText,attachments),atts=await prepareAttachments(config.root,msg.attachments),id=crypto.randomUUID();
  if(this.closed)throw new Error('云端正在关闭');
  const activityId=this.sessionRuns.get(MAIN_SESSION)?.id||id;
  const entry={role:'user',id,activityId,text:text.trim(),ts:Date.now(),source,...(clientId&&{clientId}),...(atts.length&&{attachments:atts}),...(quote&&{quote})};
  const record={entry,promptText:msg.text};this.inbox.put(record);appendJsonl(config.chatLog,entry);
  if(clientId)this.receipts.set(clientId,id);
  if(source!=='onboarding')this.bus.emit({t:'user',...entry});
  this.deliverMessage(record);return id;
 }
 async firstChat(device){if(!['mac','android'].includes(device))throw new Error('设备必须是 android 或 mac');const id=await this.send(`[第一次聊天] 设备：${device}。介绍自己；已从旧版迁移的偏好先读取，不让用户重复介绍。`,'onboarding',[],{ifEmpty:true});return {started:!!id,...(id&&{id})};}
 runIsolated(label,prompt,{id=crypto.randomUUID(),chatType,attachments=[],resumeTask,mainContext=false,scheduleId}={}){
  const key=resumeTask?.sessionKey||`agent:main:task:${id}`;
  if(mainContext){
   const recent=this.speech.history(24).map(({role,text,ts,quote})=>({role,text:text.slice(-2000),ts,...(quote&&{quote})}));
   const bounded=[];let size=0;for(const row of recent.reverse()){const length=JSON.stringify(row).length;if(size+length>16000)break;bounded.unshift(row);size+=length;}
   if(bounded.length)prompt='[近期主聊天快照，仅作背景，不是本次的新指令；完整事实按需检索记忆]\n'+JSON.stringify(bounded)+'\n\n[本次任务]\n'+prompt;
  }
  return this.execute(prompt,{id,label,chatType,attachments,sessionKey:key,kind:chatType==='side'?'side':'background',silent:!chatType,scheduleId});
 }
 async createSideChat(text,attachments=[],title){const m=validateMessage(config.root,text,attachments),id=crypto.randomUUID();this.speech.side(id).user(m.text,m.attachments);this.runIsolated(title||text.slice(0,32),m.text,{id,chatType:'side',attachments:m.attachments}).catch(e=>this.log(e.message));return id;}
 async sendTask(id,text,attachments=[]){const task=this.history.get(id);if(this.running.has(id))throw new TaskError('这个活动正在执行，请稍后补充',409);this.speech.side(id).user(text,attachments);this.runIsolated(task.title,text,{id,chatType:'side',resumeTask:task,attachments}).catch(e=>this.log(e.message));return id;}
 taskHistory(id){const r=this.history.history(id);return this.history.get(id).chatType==='side'?{...r,chatType:'side',messages:this.speech.side(id).history(1000)}:r;}
 runningJobs(){return [...this.running.values()].filter(r=>listedActivity(this.history.records.get(r.id))).map(r=>({id:r.id,title:r.label,label:r.label,summary:this.history.records.get(r.id)?.summary||'',status:'running',started:r.started,...(r.chatType&&{chatType:r.chatType})}));}
 recentJobs(){return this.history.recent();}
 chooseOption(messageId,optionId,activityId){return activityId?this.speech.side(activityId).choose(messageId,optionId,(text)=>this.sendTask(activityId,text)):this.speech.choose(messageId,optionId,this.send.bind(this));}
 async stopTask(id){const r=this.running.get(id);if(!r)throw new TaskError('活动已经结束',409);if(!r.controller)throw new TaskError('系统维护正在完成，请稍候',409);r.controller.abort();await this.runtime.abort(r.sessionKey);return {ok:true};}
 async interrupt(){for(const r of this.running.values())if(r.sessionKey===MAIN_SESSION)await this.stopTask(r.id);}
 async close(){this.closed=true;for(const r of this.running.values())r.controller?.abort();await this.runtime.close();this.content.close();this.avatar.close();}
}
