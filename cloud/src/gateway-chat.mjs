import crypto from 'node:crypto';

const textOf=message=>(message?.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join('\n').trim();

// Submit every input to its native session immediately. The gateway owns durable
// acceptance, same-turn steering, fallback turns and session serialization.
export class GatewayChat {
 constructor(client){this.client=client;this.pending=new Map();}
 respond(message,{sessionKey,id=crypto.randomUUID(),signal,onAccepted=()=>{}}={}){
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
   const finish=(error,value)=>{this.pending.delete(id);signal?.removeEventListener('abort',aborted);error?reject(error):resolve(value);};
   const aborted=()=>finish(signal.reason||new Error('已停止'));
   this.pending.set(id,{sessionKey,text:'',finish});signal?.addEventListener('abort',aborted,{once:true});
   this.client.request('chat.send',{sessionKey,message,idempotencyKey:id,queueMode:'steer',deliver:false},{signal,timeoutMs:null})
    .then(ack=>onAccepted(ack)).catch(error=>finish(error));
  });
 }
 event(event){
  if(event.event!=='chat')return;
  const p=event.payload,entry=this.pending.get(p?.runId);
  if(!entry||entry.sessionKey!==p.sessionKey)return;
  const text=textOf(p.message);if(text)entry.text=text;
  if(p.state==='error'||p.state==='aborted')entry.finish(new Error(p.errorMessage||(p.state==='aborted'?'已停止':'OpenClaw 执行失败')));
  else if(p.state==='final')entry.finish(null,{text:entry.text});
 }
 close(){for(const entry of [...this.pending.values()])entry.finish(new Error('与 OpenClaw 的消息连接中断；已接收的消息不会自动重发'));}
}
