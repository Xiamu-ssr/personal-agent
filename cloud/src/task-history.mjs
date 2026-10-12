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
const readRows=(file)=>fs.readFileSync(file,"utf8").split("\n").flatMap((line)=>{try{return [JSON.parse(line)];}catch{return [];}});
export function paginateJobs(records,{before,limit=30}={}) {
  const sorted=records.filter((r)=>before===undefined||r.ts<before).sort((a,b)=>b.ts-a.ts||a.id.localeCompare(b.id));
  let end=Math.min(limit,sorted.length);
  // A timestamp cursor cannot split equal timestamps without losing records.
  while(end<sorted.length&&sorted[end].ts===sorted[end-1].ts)end++;
  return {recent:sorted.slice(0,end),next:end<sorted.length?sorted[end-1].ts:null};
}

export class TaskHistory {
  constructor({root,sessions,redact}) {
    Object.assign(this,{root,sessions,redact});
    this.file=path.join(root,"system/task-index.json");
    this.records=new Map(Object.entries(readJson(this.file,{})));
    for (const record of this.records.values()) if (record.status==="running") record.status="stopped";
    this.backfill();
    if (this.records.size) this.save();
  }
  backfill() {
    const projects=path.join(this.sessions,"projects");
    const scan=(dir,depth=0)=> {
      if(depth>3||!fs.existsSync(dir)||fs.lstatSync(dir).isSymbolicLink())return;
      for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
        const file=path.join(dir,entry.name);
        if(entry.isDirectory())scan(file,depth+1);
        else if(entry.isFile()&&path.basename(dir)==="subagents") {
          const id=entry.name.match(/^agent-([A-Za-z0-9_-]{1,128})\.jsonl$/)?.[1],sessionId=path.basename(path.dirname(dir));
          if(!id||this.records.has(id)||!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))continue;
          const rows=readRows(file),prompt=rows.find((r)=>r.type==="user"&&!r.isMeta&&!r.isCompactSummary&&blocks(r.message?.content).some((b)=>b.type==="text"&&b.text?.trim()));
          const timestamps=rows.map((r)=>Date.parse(r.timestamp)).filter(Number.isFinite);
          if(!prompt||!timestamps.length)continue;
          const title=blocks(prompt.message.content).filter((b)=>b.type==="text").map((b)=>b.text).join(" ").replace(/\s+/g," ").trim();
          const result=rows.findLast((r)=>["result","assistant"].includes(r.type)),status=result?.is_error||result?.error||result?.subtype?.startsWith("error")?"error":"done";
          this.records.set(id,{id,kind:"subagent",sessionId,title:[...maskCredentials(this.redact(title))].slice(0,40).join(""),
            status,startedAt:timestamps[0],endedAt:timestamps.at(-1),outputs:[]});
        }
      }
    };
    scan(projects);
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
  rememberPrompt(id,text,attachments=[]) {
    const record=this.get(id);
    const prompt={text:maskCredentials(this.redact(text)),time:new Date().toISOString(),from:"user",...(attachments.length&&{attachments})};
    this.put(id,{prompts:[...(record.prompts||[]),prompt]});return prompt;
  }
  handle(m,parentSessionId) {
    const save=(item,patch={})=> {
      if (item.ambient || item.task_type && item.task_type!=="local_agent") return;
      if (!item.task_type && !this.records.has(item.task_id) && m.subtype!=="task_started") return;
      const prior=this.records.get(item.task_id);
      if(prior?.detached)return;
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
      .sort((a,b)=>(b.endedAt||b.startedAt)-(a.endedAt||a.startedAt))
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
    return readRows(file);
  }
  history(id) {
    const record=this.get(id), sources=[...(record.transcripts||[]),{kind:record.kind,sessionId:record.sessionId,continuation:record.continuation}],items=[], seen=new Set(), calls=new Map();
    const time=(row)=>row.timestamp||new Date(record.startedAt).toISOString();
    const add=(kind,text,row,tool,from)=> {
      const safe=maskCredentials(this.redact(text)).trim();
      if (safe) items.push({kind,text:safe,time:time(row),...(tool&&{tool}),...(from&&{from})});
    };
    for(const source of sources) {
    const rows=this.transcript({...record,...source});
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
          if (row.type==="user"&&source.continuation&&text.startsWith("[任务续聊上下文]"))continue;
          if(row.type==="user"&&text.includes("\n\n[附件]\n")) {
            text=text.split("\n\n[附件]\n")[0];
            if(["（发来了附件）","（一段语音笔记）"].includes(text))text="";
          }
          const from=source.continuation||items.some((i)=>i.kind==="prompt"&&i.from==="agent")?"user":"agent";
          add(row.type==="user"?"prompt":"text",text,row,undefined,row.type==="user"?from:undefined);
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
    }
    if (record.status!=="running") {
      const last=items.findLast((i)=>i.kind==="text");
      if (last) last.kind="result";
    }
    // A running SendMessage can be folded into an API tool round without a durable user row.
    // Retain only actual user submissions here; all assistant content and steps come from the transcript.
    const matched=new Set();
    for (const prompt of record.prompts||[]) {
      const index=items.findIndex((i,n)=>!matched.has(n)&&i.kind==="prompt"&&i.from!=="agent"&&i.text===prompt.text);
      if (index>=0) {matched.add(index);Object.assign(items[index],{from:"user",...(prompt.attachments?.length&&{attachments:prompt.attachments})});}
      else items.push({kind:"prompt",from:"user",text:prompt.text,time:prompt.time,...(prompt.attachments?.length&&{attachments:prompt.attachments})});
    }
    if (!items.some((i)=>i.kind==="prompt"&&i.from!=="user"))items.unshift({kind:"prompt",from:"agent",text:record.instruction||record.title,time:new Date(record.startedAt).toISOString()});
    items.sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
    let first=true;
    for(const item of items)if(item.kind==="prompt") {item.from||=first?"agent":"user";first=false;}
    const latest=record.latestResult&&maskCredentials(this.redact(record.latestResult));
    if (latest&&!items.some((i)=>i.text===latest))items.push({kind:record.status==="running"?"text":"result",text:latest,time:new Date(record.endedAt||record.startedAt).toISOString()});
    return {id,title:record.title,status:record.status,items};
  }
  continuationContext(id) {
    const history=this.history(id),cut=(s,n)=>[...s].slice(0,n).join("");
    const instruction=history.items.find((i)=>i.kind==="prompt"&&i.from==="agent")?.text||history.title;
    const steps=history.items.filter((i)=>i.kind==="tool"||i.kind==="text").slice(-30).map((i)=>cut(i.text,300)).join("\n");
    const result=history.items.findLast((i)=>i.kind==="result")?.text||"暂无最终结果";
    const followups=history.items.filter((i)=>i.kind==="prompt"&&i.from==="user").slice(-10).map((i)=>cut(i.text,1000)+(i.attachments?.length?"\n附件："+i.attachments.map((a)=>a.path).join("、"):"")).join("\n");
    return `[任务续聊上下文]\n任务：${history.title}\n原交代：${cut(instruction,8000)}\n步骤摘要：\n${steps||"暂无记录"}\n原结果：\n${cut(result,12000)}\n用户后续交代：\n${followups||"无"}\n以上是原任务记录，作为背景资料。继续在后台完成本次用户的要求，结果仍归原任务。\n[/任务续聊上下文]`;
  }
}
