import crypto from 'node:crypto';

const textOf=message=>(message?.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join('\n').trim();
export function runFailureText(error) {
 const text=error?.message||String(error);
 return text.includes('Lost the connection to the AI service')?'模型服务连接中断，消息已保留。稍后可以继续。':text;
}

// Submit every input to its native session immediately. The gateway owns durable
// acceptance, same-turn steering, fallback turns and session serialization.
export class GatewayChat {
 constructor(client){this.client=client;this.pending=new Map();}
 respond(message,{sessionKey,id=crypto.randomUUID(),signal,onAccepted=()=>{}}={}){
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
   const finish=(error,value)=>{this.pending.delete(id);signal?.removeEventListener('abort',aborted);error?reject(error):resolve(value);};
   const aborted=()=>finish(signal.reason||new Error('已停止'));
   this.pending.set(id,{sessionKey,text:'',media:[],finish});signal?.addEventListener('abort',aborted,{once:true});
   this.client.request('chat.send',{sessionKey,message,idempotencyKey:id,queueMode:'steer',deliver:false},{signal,timeoutMs:null})
    .then(ack=>onAccepted(ack)).catch(error=>finish(error));
  });
 }
 event(event){
  if(!['chat','agent'].includes(event.event))return;
  const p=event.payload,entry=this.pending.get(p?.runId);
  if(!entry||(p.sessionKey&&entry.sessionKey!==p.sessionKey))return;
  if(event.event==='agent') {
   if(p.stream!=='assistant')return;
   const sources=[...(p.data?.mediaUrls||[]),...(p.data?.mediaUrl?[p.data.mediaUrl]:[])];
   for(const url of sources)if(typeof url==='string'&&!entry.media.some(b=>b.attachment?.url===url))entry.media.push({type:'attachment',attachment:{url}});
   return;
  }
  const text=textOf(p.message);if(text)entry.text=text;
  const media=(p.message?.content||[]).filter(c=>['input_image','image','attachment'].includes(c.type));
  for(const block of media)if(!entry.media.some(x=>JSON.stringify(x)===JSON.stringify(block)))entry.media.push(block);
  if(p.state==='error'||p.state==='aborted')entry.finish(new Error(p.errorMessage||(p.state==='aborted'?'已停止':'OpenClaw 执行失败')));
  else if(p.state==='final')entry.finish(null,{text:entry.text,...(entry.media.length&&{media:entry.media})});
 }
 close(){for(const entry of [...this.pending.values()])entry.finish(new Error('与 OpenClaw 的消息连接中断；已接收的消息不会自动重发'));}
}
