import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "htmlparser2";
import { readJson, dateIn } from "./store.mjs";
import { writePrivateJson } from "./connectors.mjs";
import { briefItem } from "./briefs.mjs";
import { shiftDate } from "./calendar-context.mjs";

const fields={sleepMinutes:"sleep_minutes",restingHr:"resting_heart_rate_bpm",hrv:"hrv_ms",steps:"steps"};
const emptyDay=(date)=>({date,sleepMinutes:null,restingHr:null,hrv:null,steps:null});
const round=(n)=>typeof n==="number"&&Number.isFinite(n)&&n>=0?Math.round(n):null;
const textOf=(n)=>n.type==="text"?n.data:(n.children||[]).map(textOf).join("");
const nodes=(n)=>[n,...(n.children||[]).flatMap(nodes)];
const plain=(s)=>s.replace(/!\[[^\]]*\]\([^)]*\)/g,"").replace(/\[([^\]]+)\]\([^)]*\)/g,"$1").replace(/<[^>]+>/g,"").replace(/^\s*(?:[-*+]\s+|\d+\.\s+|>\s*)/,"").replace(/[*_`]/g,"").trim();

export function mergeHealthDays(existing,items,today) {
  const byDate=new Map((Array.isArray(existing)?existing:[]).filter((d)=>/^\d{4}-\d{2}-\d{2}$/.test(d.date)).map((d)=>[d.date,{...emptyDay(d.date),...d}]));
  for (const item of items) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item?.date)) continue;
    const day=byDate.get(item.date)||emptyDay(item.date);
    for (const [field,key] of Object.entries(fields)) {
      const value=round(item[key]);
      if(value!==null) day[field]=value; // Partial sensor results must not erase Health Connect values.
    }
    byDate.set(item.date,day);
  }
  const cutoff=shiftDate(today,-89);
  return [...byDate.values()].filter((d)=>d.date>=cutoff&&d.date<=today).sort((a,b)=>a.date.localeCompare(b.date));
}

export class HealthSync {
  constructor({root,hub,timezone="Asia/Shanghai",clock=()=>new Date(),timeoutMs=20_000}) {
    Object.assign(this,{root,hub,timezone,clock,timeoutMs});this.file=path.join(root,"data/health/days.json");
  }
  stored() {return readJson(this.file,{syncedAt:null,device:null,note:null,days:[]});}
  async sync() {
    if(this.pending) return this.pending;
    this.pending=this.perform().finally(()=>{this.pending=null;});
    return this.pending;
  }
  async perform() {
    const now=this.clock(),today=dateIn(this.timezone,now),old=this.stored();
    const online=this.hub.online(),devices=online.filter((d)=>d.capabilities.includes("health"));
    if (!devices.length) {
      writePrivateJson(this.file,{...old,note:online.length?"在线设备没有开启健康能力，请在手机里开启健康":"手机不在线，暂时无法同步健康数据"});
      return this.view();
    }
    const deadline=Date.now()+this.timeoutMs;let error="健康同步失败";
    for (const device of devices) {
      try {
        const request=async(from,days)=> {
          const remaining=deadline-Date.now();
          if(remaining<=0) throw new Error("设备超时");
          let timer;
          try {
            return await Promise.race([this.hub.call(device.id,"health",{from,days},{timeoutMs:remaining}),
              new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("设备超时")),remaining);})]);
          } finally {clearTimeout(timer);}
        };
        const result=await request(shiftDate(today,-7),7);
        if (!Array.isArray(result?.items)) throw new Error("手机返回的健康数据格式不正确");
        const items=[...result.items];let note=result.note||null;
        // Android's `from` is inclusive: seven days from a week ago end yesterday.
        // Fetch today separately so the API's final day really is today.
        if (!items.some((d)=>d.date===today)) {
          try {const current=await request(today,1);if(Array.isArray(current?.items))items.push(...current.items);note=current?.note||note;}
          catch {note="今天的健康数据尚未同步，已保留最近的数据";}
        }
        writePrivateJson(this.file,{syncedAt:now.toISOString(),device:device.name||device.id,note,
          days:mergeHealthDays(old.days,items,today)});
        return this.view();
      } catch(e) {error=e.message==="设备超时"?"手机同步超时，请稍后重试":`健康同步未完成：${e.message}`;}
    }
    writePrivateJson(this.file,{...old,note:error});return this.view();
  }
  view() {
    const saved=this.stored(),today=dateIn(this.timezone,this.clock()),byDate=new Map((saved.days||[]).map((d)=>[d.date,d]));
    return {syncedAt:saved.syncedAt||null,device:saved.device||null,note:saved.note||null,
      days:Array.from({length:7},(_,n)=>byDate.get(shiftDate(today,n-6))||emptyDay(shiftDate(today,n-6))),
      weekly:this.weekly(),records:this.records()};
  }
  weekly() {
    const dir=path.join(this.root,"data/briefs"),items=[];
    if(!fs.existsSync(dir)||fs.lstatSync(dir).isSymbolicLink())return items;
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      if(!entry.isDirectory()||!/^\d{4}-\d{2}-\d{2}$/.test(entry.name))continue;
      const rel=`data/briefs/${entry.name}/健康周报.html`,brief=briefItem(this.root,rel);
      if(!brief)continue;
      const title=nodes(parseDocument(brief.cards[0].html)).find((n)=>(n.attribs?.class||"").split(/\s+/).includes("title"));
      const start=shiftDate(brief.date,-6),fmt=(d)=>`${Number(d.slice(5,7))}月${Number(d.slice(8))}日`;
      items.push({name:brief.name,path:rel,date:brief.date,range:`${fmt(start)}–${fmt(brief.date)}`,summary:title?textOf(title).trim():""});
    }
    return items.sort((a,b)=>b.date.localeCompare(a.date));
  }
  records() {
    const dir=path.join(this.root,"data/memory/health");
    if(!fs.existsSync(dir)||fs.lstatSync(dir).isSymbolicLink())return [];
    return fs.readdirSync(dir,{withFileTypes:true}).filter((e)=>e.isFile()&&e.name.endsWith(".md")).map((e)=> {
      const lines=fs.readFileSync(path.join(dir,e.name),"utf8").split(/\r?\n/),updated=lines[0]?.match(/^更新：\s*(\d{4}-\d{2}-\d{2})/)?.[1]||null;
      const preview=lines.slice(1).filter((s)=>!/^\s*#/.test(s)).map(plain).filter(Boolean).slice(0,2).join("\n");
      return {path:`data/memory/health/${e.name}`,title:path.basename(e.name,".md"),updated,preview};
    }).sort((a,b)=>(b.updated||"").localeCompare(a.updated||"")||a.title.localeCompare(b.title));
  }
}
