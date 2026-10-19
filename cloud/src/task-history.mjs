import path from 'node:path';
import { readJson } from './store.mjs';
import { writePrivateJson } from './private-json.mjs';
export class TaskError extends Error {constructor(message,status=400,code='task_error'){super(message);Object.assign(this,{status,code});}}
export function taskId(id){if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new TaskError('任务 id 格式不对');return id;}
export function listedActivity(r){return !!r && (r.kind!=='chat'||r.steps?.some(s=>s.kind==='tool'));}
export function paginateJobs(records,{before,limit=30}={}){
 const sorted=records.filter(r=>before===undefined||r.ts<before).sort((a,b)=>b.ts-a.ts||a.id.localeCompare(b.id));
 let end=Math.min(limit,sorted.length);while(end<sorted.length&&sorted[end].ts===sorted[end-1].ts)end++;
 return {recent:sorted.slice(0,end),next:end<sorted.length?sorted[end-1].ts:null};
}
export class TaskHistory {
 constructor({root,redact=s=>s}){this.root=root;this.redact=redact;this.file=path.join(root,'system/activity-index.json');this.records=new Map(Object.entries(readJson(this.file,{})));for(const r of this.records.values())if(r.status==='running')r.status='stopped';this.save();}
 save(){writePrivateJson(this.file,Object.fromEntries(this.records));}
 safe(s){return this.redact(String(s||''));}
 put(id,patch){taskId(id);const row={id,title:'后台任务',startedAt:Date.now(),...this.records.get(id),...patch};for(const k of ['title','summary','latestResult'])if(row[k])row[k]=this.safe(row[k]);this.records.set(id,row);this.save();return row;}
 get(id){taskId(id);const r=this.records.get(id);if(!r)throw new TaskError('没有这个活动',404);return r;}
 recent(){return [...this.records.values()].filter(r=>r.status!=='running'&&listedActivity(r)).map(r=>({id:r.id,label:r.title,title:r.title,summary:r.summary||'',status:r.status,ok:r.status==='done',ts:r.endedAt||r.startedAt,outputs:r.outputs||[],...(r.chatType&&{chatType:r.chatType})})).sort((a,b)=>b.ts-a.ts);}
 history(id){const r=this.get(id);return {id,title:r.title,status:r.status,items:r.steps||[]};}
 rememberPrompt(id,text,attachments=[]){const r=this.get(id);return this.put(id,{steps:[...(r.steps||[]),{kind:'prompt',from:'user',text:this.safe(text),attachments,time:new Date().toISOString()}]});}
}
