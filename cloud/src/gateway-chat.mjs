import crypto from 'node:crypto';

const blocksOf=message=>Array.isArray(message?.content)?message.content:[];
const textOf=message=>typeof message?.content==='string'?message.content.trim():blocksOf(message).filter(c=>c.type==='text').map(c=>c.text||'').join('\n').trim();
const mediaOf=message=>blocksOf(message).filter(c=>['input_image','image','attachment'].includes(c.type));
export function runFailureText(error) {
 if(error?.code==='outcome_unknown')return '连接已恢复，但这次任务的最终结果尚未确认。请先查看活动记录。';
 const text=error?.message||String(error);
 if(/conversation is too long.*shortening it took too long|compaction timed out/i.test(text))return '整理聊天记录超时，这次回复未完成。消息和历史已保留。';
 if(/context overflow|prompt too (?:large|long)|conversation is too long.*couldn.t shorten|preflight compaction.*failed/i.test(text))return '对话上下文整理失败，这次回复未完成。消息和历史已保留。';
 if(text.includes('The provider refused this request'))return '模型服务拒绝了这次请求，未完成的内容已保留。';
 return text.includes('Lost the connection to the AI service')?'模型服务连接中断，消息已保留。稍后可以继续。':text;
}

// Submit every input to its native session immediately. The gateway owns durable
// acceptance, same-turn steering, fallback turns and session serialization.
export class GatewayChat {
 constructor(client,{observeSessionKey,onObservedRun=()=>{}}={}){
  Object.assign(this,{client,observeSessionKey,onObservedRun});this.pending=new Map();this.observed=new Map();this.completed=new Set();this.connected=true;
 }
 rememberCompleted(id){this.completed.add(id);if(this.completed.size>512)this.completed.delete(this.completed.values().next().value);}
 liveEntry(id){return this.pending.get(id)||this.observed.get(id);}
 respond(message,{sessionKey,id=crypto.randomUUID(),signal,onAccepted=()=>{}}={}){
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
   const finish=(error,value)=>{if(!this.pending.has(id))return;this.pending.delete(id);if(entry.started||value?.text||value?.media?.length)this.rememberCompleted(id);signal?.removeEventListener('abort',aborted);error?reject(error):resolve(value);};
   const aborted=()=>finish(signal.reason||new Error('已停止'));
   const entry={sessionKey,text:'',media:[],finish,onAccepted,signal,interrupted:false};this.pending.set(id,entry);signal?.addEventListener('abort',aborted,{once:true});
   this.client.request('chat.send',{sessionKey,message,idempotencyKey:id,queueMode:'steer',deliver:false},{signal,timeoutMs:null})
    .then(ack=>{entry.accepted=true;onAccepted(ack);}).catch(error=>{if(!entry.interrupted)finish(error);});
  });
 }
 observe(id,sessionKey){
  const entry={sessionKey,text:'',media:[],started:true,onAccepted:()=>{},interrupted:false};
  entry.finish=(error,value)=>{
   if(this.observed.get(id)!==entry)return;
   this.observed.delete(id);this.rememberCompleted(id);
   this.onObservedRun({id,sessionKey,phase:error?'error':'final',...(error?{error}:{response:value})});
  };
  this.observed.set(id,entry);this.onObservedRun({id,sessionKey,phase:'start'});return entry;
 }
 event(event){
  if(!['chat','agent'].includes(event.event))return;
  const p=event.payload,id=p?.runId;if(!id)return;
  let entry=this.liveEntry(id);
  // A queued input may finish admission before OpenClaw starts its follow-up
  // under a new run id. That execution still belongs to the same conversation.
  if(!entry&&p.sessionKey===this.observeSessionKey&&!this.completed.has(id)){
   const starts=event.event==='agent'&&p.stream==='lifecycle'&&p.data?.phase==='start';
   const hasOutput=event.event==='chat'&&(textOf(p.message)||mediaOf(p.message).length);
   if(starts||hasOutput)entry=this.observe(id,p.sessionKey);
  }
  if(!entry||(p.sessionKey&&entry.sessionKey!==p.sessionKey))return;
  if(event.event==='agent') {
   if(p.stream==='lifecycle'&&p.data?.phase==='start')entry.started=true;
   if(p.stream!=='assistant')return;
   const sources=[...(p.data?.mediaUrls||[]),...(p.data?.mediaUrl?[p.data.mediaUrl]:[])];
   for(const url of sources)if(typeof url==='string'&&!entry.media.some(b=>b.attachment?.url===url))entry.media.push({type:'attachment',attachment:{url}});
   return;
  }
  const text=textOf(p.message);if(text)entry.text=text;
  const media=mediaOf(p.message);
  for(const block of media)if(!entry.media.some(x=>JSON.stringify(x)===JSON.stringify(block)))entry.media.push(block);
  if(p.state==='error'||p.state==='aborted')entry.finish(new Error(p.errorMessage||(p.state==='aborted'?'已停止':'OpenClaw 执行失败')));
  else if(p.state==='final')entry.finish(null,{text:entry.text,...(entry.media.length&&{media:entry.media})});
 }
 disconnect(){this.connected=false;for(const entry of [...this.pending.values(),...this.observed.values()])entry.interrupted=true;}
 async transcriptReply(id,entry){
  const history=await this.client.request('chat.history',{sessionKey:entry.sessionKey,limit:100},{signal:entry.signal,timeoutMs:20000});
  const messages=history.messages||[],isReply=m=>m.role==='assistant'&&!m.provenance&&['stop','length'].includes(m.stopReason);
  let reply=messages.findLast(m=>isReply(m)&&m.__openclaw?.runId===id);
  if(!reply){
   // Native follow-ups can retain a different execution id in the transcript.
   // Bind via this exact accepted input, stopping at the next user turn.
   const start=messages.findLastIndex(m=>m.role==='user'&&(m.idempotencyKey||m.__openclaw?.idempotencyKey)===`${id}:user`);
   if(start<0)return null;
   const end=messages.findIndex((m,i)=>i>start&&m.role==='user'),turn=messages.slice(start+1,end<0?undefined:end);
   const nativeId=turn.find(m=>m.role==='assistant'&&m.__openclaw?.runId)?.__openclaw.runId;
   if(!nativeId)return null;
   reply=turn.findLast(m=>isReply(m)&&m.__openclaw?.runId===nativeId);
   if(reply&&nativeId!==id&&(this.liveEntry(nativeId)||this.completed.has(nativeId)))return {text:''};
  }
  if(!reply)return null;
  if(reply.__openclaw?.truncated){
   const full=await this.client.request('chat.message.get',{sessionKey:entry.sessionKey,messageId:reply.__openclaw.id},{signal:entry.signal,timeoutMs:20000});
   if(!full.ok||full.message?.__openclaw?.truncated||!isReply(full.message)||full.message.__openclaw?.runId!==reply.__openclaw.runId)return null;
   reply=full.message;
  }
  return {text:textOf(reply),media:mediaOf(reply),nativeRunId:reply.__openclaw?.runId};
 }
 recover(){
  this.connected=true;
  for(const [id,entry] of [...this.pending,...this.observed])if(entry.interrupted&&!entry.recovering){
   entry.recovering=true;
   const check=async()=>{
    try {
     while(this.connected&&this.liveEntry(id)===entry){
      const run=await this.client.request('agent.wait',{runId:id,timeoutMs:15000},{signal:entry.signal,timeoutMs:20000});
      if(this.liveEntry(id)!==entry)return;
      if(['pending','timeout'].includes(run.status)&&!run.endedAt&&!run.stopReason)continue;
      if(run.status==='ok'){
       if(!entry.accepted){entry.accepted=true;entry.onAccepted({runId:id,recovered:true});}
       const reply=run.terminalReply;
       const restored=reply?{text:reply.disposition==='visible'?(reply.text||entry.text):''}:await this.transcriptReply(id,entry);
       if(this.liveEntry(id)!==entry)return;
       if(!restored){const error=new Error('任务已结束，但回复尚未确认，请查看活动记录');error.code='outcome_unknown';entry.finish(error);return;}
       if(restored.nativeRunId&&restored.nativeRunId!==id)this.rememberCompleted(restored.nativeRunId);
       entry.finish(null,{text:restored.text,...((restored.media?.length||entry.media.length)&&{media:restored.media?.length?restored.media:entry.media}),recovered:true});return;
      }
      const error=new Error(run.error||'任务结果尚未确认，请查看活动记录');
      if(!run.endedAt&&!run.stopReason)error.code='outcome_unknown';entry.finish(error);return;
     }
    }catch(error){if(this.connected&&this.liveEntry(id)===entry){error.code='outcome_unknown';entry.finish(error);}}
    finally{entry.recovering=false;}
   };void check();
  }
 }
 close(){for(const entry of [...this.pending.values(),...this.observed.values()])entry.finish(new Error('与 OpenClaw 的消息连接中断；已接收的消息不会自动重发'));}
}
