import fs from "node:fs";
import path from "node:path";
import { dateIn } from "./store.mjs";
import { writePrivateJson } from "./connectors.mjs";
import { readAppSettings } from "./app-settings.mjs";
import { V05_SCHEDULE_PROMPTS } from "./schedule-prompts-v05.mjs";

export const HEALTH_SCHEDULE = {id:"health-sync",name:"健康同步",cron:"0 */3 * * *",kind:"health-sync"};
// Idempotent, data-root-only startup migration. Custom prompts and other schedule fields are preserved.
export function migrateV06({root,seedDir,timezone="Asia/Shanghai",now=new Date()}) {
  const changed=[];
  const scheduleFile=path.join(root,"system/schedule.json");
  let jobs=[];
  if(fs.existsSync(scheduleFile)) {
    try {jobs=JSON.parse(fs.readFileSync(scheduleFile,"utf8"));if(!Array.isArray(jobs))throw new Error();}
    catch{throw new Error("定时配置损坏，未执行健康同步迁移，也未覆盖原配置");}
  }
  const seedJobs=JSON.parse(fs.readFileSync(path.join(seedDir,"system/schedule.json"),"utf8"));
  const seedPrompts=new Map(seedJobs.filter((j)=>typeof j.prompt==="string").map((j)=>[j.id,j.prompt]));
  let scheduleChanged=false;
  for(const job of jobs) {
    const prompt=seedPrompts.get(job.id);
    if(Object.hasOwn(V05_SCHEDULE_PROMPTS,job.id)&&job.prompt===V05_SCHEDULE_PROMPTS[job.id]&&
        typeof prompt==="string"&&prompt!==job.prompt) {
      job.prompt=prompt;scheduleChanged=true;changed.push(`schedule-prompt:${job.id}`);
    }
  }
  if (!jobs.some((j)=>j.kind==="health-sync"||j.id==="health-sync")) {
    jobs.push(HEALTH_SCHEDULE);scheduleChanged=true;changed.push("health-sync");
  }
  if(scheduleChanged)writePrivateJson(scheduleFile,jobs);
  const latest=path.join(root,"data/memory/health/latest.json");
  if (fs.existsSync(latest)||fs.existsSync(path.dirname(latest))&&fs.readdirSync(path.dirname(latest)).includes("latest.json")) {
    fs.rmSync(latest,{force:true});changed.push("health-metrics-removed");
  }
  const file=path.join(root,"data/memory/role/角色.md");
  if (fs.existsSync(file)&&!fs.lstatSync(file).isSymbolicLink()) {
    const before=fs.readFileSync(file,"utf8");
    if (!/^##[^\n]*说话习惯/m.test(before)) {
      const seed=fs.readFileSync(path.join(seedDir,"data/memory/role/角色.md"),"utf8");
      const section=seed.match(/^## 说话习惯[^\n]*\n[\s\S]*?(?=^##\s|$(?![\s\S]))/m)?.[0]?.trimEnd();
      if (!section) throw new Error("默认角色文件缺少说话习惯");
      const date=dateIn(timezone,now), updated=before.replace(/^更新：[^\r\n]*/,`更新：${date}`);
      fs.writeFileSync(file,updated+(updated.endsWith("\n")?"\n":"\n\n")+section+"\n");
      changed.push("role-speaking-style");
    }
  }
  readAppSettings(root); // Retired/unknown model ids are reset and atomically persisted.
  return changed;
}
