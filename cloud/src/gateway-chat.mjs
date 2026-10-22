import crypto from 'node:crypto';

const blocksOf=message=>Array.isArray(message?.content)?message.content:[];
const textOf=message=>typeof message?.content==='string'?message.content.trim():blocksOf(message).filter(c=>c.type==='text').map(c=>c.text||'').join('\n').trim();
const mediaOf=message=>blocksOf(message).filter(c=>['input_image','image','attachment'].includes(c.type));
export function runFailureText(error) {
 if(error?.code==='outcome_unknown')return '连接已恢复，但这次任务的最终结果尚未确认。请先查看活动记录。';
 const text=error?.message||String(error);
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
       entry.finish(null,{text:reply?.disposition==='visible'?(reply.text||entry.text):'',...(entry.media.length&&{media:entry.media}),recovered:true});return;
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
