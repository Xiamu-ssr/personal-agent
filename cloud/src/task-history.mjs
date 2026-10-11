import fs from "node:fs";
import path from "node:path";
import { readJson } from "./store.mjs";
import { writePrivateJson } from "./connectors.mjs";
import { TaskError } from "./background-tasks.mjs";

export function taskId(id) {
  if (typeof id!=="string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new TaskError("任务 id 格式不对",400,"invalid_task_id");
  return id;
}
const statusOf=(status)=>({completed:"done",failed:"error",killed:"stopped"}[status]||status);
const blocks=(content)=>typeof content==="string"?[{type:"text",text:content}]:Array.isArray(content)?content:[];
const maskCredentials=(s)=>s.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi,"Bearer ••••")
  .replace(/\bsk-[A-Za-z0-9_-]{8,}/g,"••••")
  .replace(/((?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)|apiKey|password|secret)\s*[=:]\s*["']?)[^\s,"';}]+/gi,"$1••••");

export class TaskHistory {
  constructor({root,sessions,redact}) {
    Object.assign(this,{root,sessions,redact});
    this.file=path.join(root,"system/task-index.json");
    this.records=new Map(Object.entries(readJson(this.file,{})));
    for (const record of this.records.values()) if (record.status==="running") record.status="stopped";
    if (this.records.size) this.save();
  }
  save() { writePrivateJson(this.file,Object.fromEntries(this.records)); }
  put(id,patch) {
    taskId(id);
    const record={id,title:"后台任务",startedAt:Date.now(),...this.records.get(id),...patch};
    record.title=maskCredentials(this.redact(record.title));
    this.records.set(id,record); this.save(); return record;
  }
  get(id) {
    taskId(id);
    const record=this.records.get(id);
    if (!record) throw new TaskError("没有这个任务",404,"task_not_found");
    return record;
  }
  rememberPrompt(id,text) {
    const record=this.get(id);
    this.put(id,{prompts:[...(record.prompts||[]),{text:maskCredentials(this.redact(text)),time:new Date().toISOString()}]});
  }
  handle(m,parentSessionId) {
    const save=(item,patch={})=> {
      if (item.ambient || item.task_type && item.task_type!=="local_agent") return;
      if (!item.task_type && !this.records.has(item.task_id) && m.subtype!=="task_started") return;
      const prior=this.records.get(item.task_id);
      if (item.run_id && prior?.runId && item.run_id<prior.runId) return;
      this.put(item.task_id,{kind:"subagent",sessionId:parentSessionId,
        ...(item.run_id&&{runId:item.run_id}),...(item.description&&{title:item.description}),...patch});
    };
    if (m.subtype==="background_tasks_changed") for (const item of m.tasks) save(item,{status:"running"});
    if (m.subtype==="task_started") save(m,{status:"running",startedAt:Date.now()});
    if (m.subtype==="task_notification") save(m,{status:statusOf(m.status),endedAt:Date.now()});
    if (m.subtype==="task_updated" && m.patch?.status) save(m,{status:statusOf(m.patch.status)});
  }
  recent() {
    return [...this.records.values()].filter((r)=>r.status!=="running")
      .sort((a,b)=>(b.endedAt||b.startedAt)-(a.endedAt||a.startedAt)).slice(0,50)
      .map((r)=>({id:r.id,label:r.title,title:r.title,status:r.status,ok:r.status==="done",ts:r.endedAt||r.startedAt,
        outputs:r.outputs||[],...(r.path&&{path:r.path})}));
  }
  transcript(record) {
    if (!record.sessionId) return [];
    const relative=record.kind==="subagent" ? path.join(record.sessionId,"subagents",`agent-${record.id}.jsonl`) : `${record.sessionId}.jsonl`;
    // Search only this harness's private CLI storage, never ~/.claude or unrelated conversations.
    const projects=path.join(this.sessions,"projects");
    const find=(dir,depth=0)=> {
      if (depth>2 || !fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink()) return null;
      const candidate=path.join(dir,relative);
      if (fs.existsSync(candidate)&&!fs.lstatSync(candidate).isSymbolicLink()&&fs.realpathSync(candidate).startsWith(fs.realpathSync(this.sessions)+path.sep)) return candidate;
      for (const entry of fs.readdirSync(dir,{withFileTypes:true})) if (entry.isDirectory()) {
        const file=find(path.join(dir,entry.name),depth+1); if (file) return file;
      }
      return null;
    };
    const file=find(projects);
    if (!file) return [];
    return fs.readFileSync(file,"utf8").split("\n").flatMap((line)=>{try{return [JSON.parse(line)];}catch{return [];}});
  }
  history(id) {
    const record=this.get(id), rows=this.transcript(record), items=[], seen=new Set(), calls=new Map();
    const time=(row)=>row.timestamp||new Date(record.startedAt).toISOString();
    const add=(kind,text,row,tool)=> {
      const safe=maskCredentials(this.redact(text)).trim();
      if (safe) items.push({kind,text:safe,time:time(row),...(tool&&{tool})});
    };
    for (const row of rows) {
      if (!["user","assistant"].includes(row.type) || row.isCompactSummary) continue;
      if (row.uuid && seen.has(row.uuid)) continue;
      if (row.uuid) seen.add(row.uuid);
      for (const b of blocks(row.message?.content)) {
        if (b.type==="text") {
          let text=b.text||"";
          const delivered=text.match(/^The coordinator sent a message while you were working:\n([\s\S]*?)\n\nAddress this before completing your current task\.$/);
          if (delivered) text=delivered[1];
          if (row.type==="user" && (row.isMeta&&!delivered || /^(?:<task-notification>|<system-reminder>)/.test(text))) continue;
          if (delivered && text==="继续原任务，从已经完成的步骤接着做。") continue;
          add(row.type==="user"?"prompt":"text",text,row);
        }
        if (b.type==="tool_use") {
          const i=b.input||{}, verbs={Read:"读取",Write:"写入",Edit:"修改",Grep:"搜索",Glob:"查找",Bash:"执行",SendMessage:"发送任务消息",Agent:"派出任务"};
          let hint=i.file_path||i.path||i.pattern||i.description||i.to||"";
          if (typeof hint!=="string") hint="";
          if (hint.startsWith(this.root+path.sep)) hint=path.relative(this.root,hint);
          add("tool",`${verbs[b.name]||b.name} ${this.redact(hint).replace(/\s+/g," ").slice(0,100)}`.trim(),row,b.name);
          calls.set(b.id,items.at(-1));
        }
        if (b.type==="tool_result") {
          const item=calls.get(b.tool_use_id);
          if (item && b.is_error) item.text+="（失败）";
          // Never return raw tool results, command output, base64 or thinking blocks.
        }
      }
    }
    if (record.status!=="running") {
      const last=items.findLast((i)=>i.kind==="text");
      if (last) last.kind="result";
    }
    // A running SendMessage can be folded into an API tool round without a durable user row.
    // Retain only actual user submissions here; all assistant content and steps come from the transcript.
    const matched=new Set();
    for (const prompt of record.prompts||[]) {
      const index=items.findIndex((i,n)=>!matched.has(n)&&i.kind==="prompt"&&i.text===prompt.text);
      if (index>=0) matched.add(index);
      else items.push({kind:"prompt",text:prompt.text,time:prompt.time});
    }
    items.sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
    return {id,title:record.title,status:record.status,items};
  }
}
