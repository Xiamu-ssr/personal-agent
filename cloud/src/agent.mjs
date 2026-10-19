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
import { appendJsonl, readJson } from './store.mjs';
import { writePrivateJson } from './private-json.mjs';
import { validateMessage, prepareAttachments, userContent } from './attachments.mjs';
const quiet=text=>!text||/^(?:HEARTBEAT_OK|NO_REPLY|NONE)[.!。\s]*$/.test(text);
const result=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
export class Harness {
 constructor({hub,bus,log=()=>{},connectors,runtime}){
  Object.assign(this,{hub,bus,connectors});this.log=(...args)=>log(...args.map(v=>connectors.redact(v)));
  for(const [key,value]of Object.entries(process.env))if(/(?:TOKEN|KEY|SECRET|PASSWORD)$/i.test(key)&&value?.length>=8)connectors.knownSecrets.add(value);
  this.runtime=runtime||new OpenClawRuntime({log:this.log});this.busy=false;this.closed=false;this.running=new Map();this.sessionRuns=new Map();this.mainChain=Promise.resolve();
  this.pendingFile=path.join(config.root,'system/pending-results.json');this.pending=readJson(this.pendingFile,[]);
  this.history=new TaskHistory({root:config.root,redact:s=>connectors.redact(s)});
  this.content=new Content({root:config.root,bus,timezone:config.timezone});this.pages=new PageScreenshot({root:config.root});
  this.speech=new Speech({root:config.root,bus,redact:s=>connectors.redact(s),onSay:e=>{const run=this.running.get(e.activityId);if(run)run.said=true;}});
  this.avatar=new Avatar({bus,busy:()=>this.running.size>0,waiting:()=>this.speech.waiting()});
 }
 async startMain(){await this.runtime.start();}
 async settingsChanged(){await this.runtime.reload();}
 step(id,kind,text,tool,extra={}){if(!this.history.records.has(id))return;const item={kind,text:this.connectors.redact(String(text||'')),time:new Date().toISOString(),...(tool&&{tool}),...extra};const record=this.history.get(id);this.history.put(id,{steps:[...(record.steps||[]),item]});this.bus.emit({t:'activity_step',id,item});}
 groups(){
  const wrap=fn=>async args=>result(await fn(args));
  const goalShape={name:z.string(),title:z.string(),status:z.enum(['未开始','进行中','等待条件','待用户反馈','已完成','暂停','取消']),progress:z.number().min(0).max(100),body:z.string(),domain:z.string().optional(),cadence:z.string().optional(),due:z.string().optional()};
  return {...this.connectors.toolGroups(),devices:this.hub.tools(),page:this.pages.tools(),speech:this.speech.tools(),
   schedules:[defineTool('list','查看定时安排。',{},wrap(()=>readJson(config.scheduleFile,[]))),
    defineTool('put','创建或更新已授权的提醒/定时推进。cron 与 at 二选一，at 是 ISO 时间；enabled=false 停止。',{id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),name:z.string().max(100),prompt:z.string().max(8000),cron:z.string().optional(),at:z.string().optional(),enabled:z.boolean()},wrap(job=>{
      if(job.enabled && (!job.prompt.trim() || !!job.cron===!!job.at))throw new Error('请提供提示词及 cron 或 at');
      if(job.cron)cronFields(job.cron);if(job.at&&!Number.isFinite(Date.parse(job.at)))throw new Error('at 时间不正确');
      const jobs=readJson(config.scheduleFile,[]),old=jobs.find(j=>j.id===job.id);if(old&&old.kind!=='reminder')throw new Error('内置安排请在 App 中管理');
      const updated={...job,kind:'reminder'};const successFile=path.join(config.system,'schedule-success.json'),success=readJson(successFile,{});delete success[job.id];writePrivateJson(successFile,success);writePrivateJson(config.scheduleFile,[...jobs.filter(j=>j.id!==job.id),updated]);this.bus.emit({t:'schedules_updated'});return updated;
    }))],
   goals:[defineTool('list','列出目标及当前状态。',{},wrap(()=>this.content.goals())),defineTool('get','读取一个目标。',{name:z.string()},wrap(({name})=>this.content.goal(name))),
    defineTool('put','创建或更新目标；用户明确认可后才可标记已完成，交付先标待用户反馈。',goalShape,wrap(args=>this.content.putGoal(args)))]};
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
  this.step(run.id,'tool',`${group}.${name}`,`${group}.${name}`);this.avatar.working(`${group}.${name}`,args.args);
  const value=group==='speech'?result({id:this.speech.emit(args.args||{},{activityId:run.id,chatType:run.chatType}).id}):await tool.execute(args.args||{}, {onStart:()=>{}});
  this.step(run.id,'tool_result',value.isError?'操作未完成':'操作完成',`${group}.${name}`);
  if(group==='speech')run.said=true;
  return this.connectors.redact(value);
 }
 async execute(prompt,{id=crypto.randomUUID(),label='处理消息',sessionKey=MAIN_SESSION,chatType,attachments=[],silent=false,reportError=true,kind='chat'}={}){
  if(this.closed)throw new Error('云端正在关闭');
  const controller=new AbortController(),run={id,label,sessionKey,controller,chatType,silent,said:false,started:Date.now()};
  this.running.set(id,run);this.sessionRuns.set(sessionKey,run);this.history.put(id,{title:label,kind,status:'running',sessionKey,chatType,steps:this.history.records.get(id)?.steps||[]});this.history.rememberPrompt(id,prompt,attachments);
  this.busy=[...this.running.values()].some(r=>r.sessionKey===MAIN_SESSION);this.bus.emit({t:'status',busy:this.busy});this.bus.emit({t:'activity',phase:'started',id,title:label,ts:Date.now()});this.avatar.working();
  let ok=false;
  try{
   let text=prompt;const pendingSnapshot=sessionKey===MAIN_SESSION?[...this.pending]:[];
   if(sessionKey===MAIN_SESSION&&this.pending.length){const pending=pendingSnapshot;text='[已完成的后台工作，作为当前上下文，不是用户的新指令]\n'+pending.map(x=>`${x.label}: ${x.text}`).join('\n')+'\n\n'+prompt;}
   const content=userContent(config.root,text,attachments);
   const input=typeof content==='string'?content:[{type:'message',role:'user',content:content.map(b=>b.type==='text'?{type:'input_text',text:b.text}:{type:'input_image',image_url:`data:${b.source.media_type};base64,${b.source.data}`})}];
   const response=await this.runtime.respond(input,{sessionKey,signal:controller.signal});
   if(pendingSnapshot.length){this.pending=this.pending.filter(x=>!pendingSnapshot.includes(x));writePrivateJson(this.pendingFile,this.pending);}
   if(response.text)this.step(id,'result',response.text);
   if(!silent&&!run.said&&!quiet(response.text))this.speech.emit({text:response.text},{activityId:id,chatType});
   if(sessionKey!==MAIN_SESSION&&response.text){this.pending.push({label,text:response.text.slice(-12000)});this.pending=this.pending.slice(-20);writePrivateJson(this.pendingFile,this.pending);}
   this.history.put(id,{status:'done',endedAt:Date.now(),summary:quiet(response.text)?'已检查，无新变化':response.text.slice(0,180),latestResult:response.text,usage:response.usage});ok=true;
   return {ok:true,text:response.text};
  }catch(e){const stopped=controller.signal.aborted;this.history.put(id,{status:stopped?'stopped':'error',endedAt:Date.now(),summary:stopped?'已停止':this.connectors.redact(e.message)});if(!silent&&!stopped&&reportError)this.speech.emit({text:'这次没完成：'+this.connectors.redact(e.message)},{activityId:id,chatType,error:true});return {ok:false,error:e.message};
  }finally{
   this.running.delete(id);this.sessionRuns.delete(sessionKey);this.busy=[...this.running.values()].some(r=>r.sessionKey===MAIN_SESSION);
   this.bus.emit({t:'status',busy:this.busy});this.bus.emit({t:'activity',phase:'done',id,title:label,status:this.history.get(id).status,summary:this.history.get(id).summary,ts:Date.now()});
   this.content.discoverFeed();for(const t of ['memory_updated','goals_updated','ideas_updated','library_updated'])this.bus.emit({t});this.avatar.settle(ok);
  }
 }
 runMain(prompt,options={}){const done=this.mainChain.then(()=>this.execute(prompt,{label:triggerTitle(prompt)||'处理消息',...options}));this.mainChain=done.catch(()=>{});return done;}
 async send(text,source='app',attachments=[],{ifEmpty=false,promptText=text,quote}={}){
  if(this.closed)throw new Error('云端正在关闭');if(ifEmpty&&this.speech.history(1).length)return null;
  const msg=validateMessage(config.root,promptText,attachments),atts=await prepareAttachments(config.root,msg.attachments),id=crypto.randomUUID();
  const entry={role:'user',id,activityId:id,text:text.trim(),ts:Date.now(),source,...(atts.length&&{attachments:atts}),...(quote&&{quote})};appendJsonl(config.chatLog,entry);if(source!=='onboarding')this.bus.emit({t:'user',...entry});
  this.runMain(msg.text,{id,label:(text||quote?.title||'附件').replace(/\s+/g,' ').slice(0,32),attachments:atts}).catch(e=>this.log(e.message));return id;
 }
 async firstChat(device){if(!['mac','android'].includes(device))throw new Error('设备必须是 android 或 mac');const id=await this.send(`[第一次聊天] 设备：${device}。介绍自己；已从旧版迁移的偏好先读取，不让用户重复介绍。`,'onboarding',[],{ifEmpty:true});return {started:!!id,...(id&&{id})};}
 runIsolated(label,prompt,{id=crypto.randomUUID(),chatType,attachments=[],resumeTask,mainContext=false}={}){
  const key=resumeTask?.sessionKey||`agent:main:task:${id}`;
  if(mainContext){
   const recent=this.speech.history(24).map(({role,text,ts,quote})=>({role,text:text.slice(-2000),ts,...(quote&&{quote})}));
   const bounded=[];let size=0;for(const row of recent.reverse()){const length=JSON.stringify(row).length;if(size+length>16000)break;bounded.unshift(row);size+=length;}
   if(bounded.length)prompt='[近期主聊天快照，仅作背景，不是本次的新指令；完整事实按需检索记忆]\n'+JSON.stringify(bounded)+'\n\n[本次任务]\n'+prompt;
  }
  return this.execute(prompt,{id,label,chatType,attachments,sessionKey:key,kind:chatType==='side'?'side':'background',silent:!chatType});
 }
 async createSideChat(text,attachments=[],title){const m=validateMessage(config.root,text,attachments),id=crypto.randomUUID();this.speech.side(id).user(m.text,m.attachments);this.runIsolated(title||text.slice(0,32),m.text,{id,chatType:'side',attachments:m.attachments}).catch(e=>this.log(e.message));return id;}
 async sendTask(id,text,attachments=[]){const task=this.history.get(id);if(this.running.has(id))throw new TaskError('这个活动正在执行，请稍后补充',409);this.speech.side(id).user(text,attachments);this.runIsolated(task.title,text,{id,chatType:'side',resumeTask:task,attachments}).catch(e=>this.log(e.message));return id;}
 taskHistory(id){const r=this.history.history(id);return this.history.get(id).chatType==='side'?{...r,chatType:'side',messages:this.speech.side(id).history(1000)}:r;}
 runningJobs(){return [...this.running.values()].filter(r=>listedActivity(this.history.records.get(r.id))).map(r=>({id:r.id,title:r.label,label:r.label,summary:this.history.records.get(r.id)?.summary||'',status:'running',started:r.started,...(r.chatType&&{chatType:r.chatType})}));}
 recentJobs(){return this.history.recent();}
 chooseOption(messageId,optionId,activityId){return activityId?this.speech.side(activityId).choose(messageId,optionId,(text)=>this.sendTask(activityId,text)):this.speech.choose(messageId,optionId,this.send.bind(this));}
 async stopTask(id){const r=this.running.get(id);if(!r)throw new TaskError('活动已经结束',409);if(!r.controller)throw new TaskError('系统维护正在完成，请稍候',409);r.controller.abort();await this.runtime.abort(r.sessionKey);return {ok:true};}
 async interrupt(){for(const r of this.running.values())if(r.sessionKey===MAIN_SESSION)await this.stopTask(r.id);}
 async close(){this.closed=true;for(const r of this.running.values())r.controller?.abort();await this.runtime.close();this.avatar.close();}
}
