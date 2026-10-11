// Dry run by default. HTML is created before the original JSON is moved into a dated backup.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml as e, validateBrief } from "../src/briefs.mjs";

function blockHtml(block) {
  const items=block.items||[];
  if (block.type==="timeline") return `<div class="timeline">${items.map((i)=>`<div><span class="when">${e(i.when)}</span><strong>${e(i.label)}</strong>${i.text?`<div class="meta">${e(i.text)}</div>`:""}</div>`).join("")}</div>`;
  if (block.type==="tiles") return `<div class="tiles">${items.map((i)=>`<div class="tile"><h3>${e(i.title)}</h3><p>${e(i.text)}</p>${i.tag?`<span class="tag" data-tone="${e(i.tone||"info")}">${e(i.tag)}</span>`:""}</div>`).join("")}</div>`;
  if (block.type==="metrics") return `<div class="metrics">${items.map((i)=>`<div class="metric"><span class="value">${e(i.value)}</span><span class="unit">${e(i.unit)}</span><div class="label">${e(i.label)}</div>${i.delta?`<span class="delta">${e(i.delta)}</span>`:""}</div>`).join("")}</div>`;
  if (block.type==="list") return `<ul class="list">${items.map((i)=>`<li>${e(i.text)}${i.meta?`<span class="meta">${e(i.meta)}</span>`:""}</li>`).join("")}</ul>`;
  if (block.type==="note") return `<p class="note">${e(block.text)}</p>`;
  throw new Error("无法迁移未知的简报区块");
}

export function convertBrief(value) {
  if (value?.v!==1 || !Array.isArray(value.cards) || !value.name || !value.time) throw new Error("JSON 简报缺少 v、name、time 或 cards");
  const section=(s)=>`<section class="card">${s}</section>`;
  const cards=value.cards.flatMap((c)=>{
    const header=`<span class="chip">${e(c.chip)}</span><h1 class="title">${e(c.title)}</h1>`;
    let current=header+(c.summary?`<p class="summary">${e(c.summary)}</p>`:""), out=[];
    const parts=(c.blocks||[]).map(blockHtml);
    if (c.action) parts.push(`<button class="button" data-prompt="${e(c.action.prompt)}">${e(c.action.label)}</button>`);
    for (const part of parts) {
      if (/内容过高/.test(validateBrief(section(current+part)).error||"")) {out.push(section(current));current=header;}
      current+=part;
    }
    out.push(section(current));return out;
  }).join("\n");
  const html=`<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="brief-name" content="${e(value.name)}"><meta name="brief-time" content="${e(value.time)}"></head><body>\n${cards}\n</body></html>\n`;
  const result=validateBrief(html);
  if (result.error) throw new Error(result.error);
  return html;
}

export function migrate(root,{apply=false,now=new Date()}={}) {
  root=path.resolve(root);
  const backup=path.join(root,"backup/migrate-0.5",now.toISOString().replace(/[:.]/g,"-"));
  const report={apply,items:[],errors:[],schedule:null};
  const dir=path.join(root,"data/briefs");
  function walk(folder) {
    if (!fs.existsSync(folder)||fs.lstatSync(folder).isSymbolicLink()) return;
    for (const entry of fs.readdirSync(folder,{withFileTypes:true})) {
      const file=path.join(folder,entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()&&entry.name.endsWith(".json")) {
        const rel=path.relative(root,file), to=file.replace(/\.json$/,".html"), dest=path.join(backup,rel);
        try {
          const html=convertBrief(JSON.parse(fs.readFileSync(file,"utf8")));
          if (fs.existsSync(to) && (fs.lstatSync(to).isSymbolicLink()||fs.readFileSync(to,"utf8")!==html)) throw new Error("同名 HTML 已存在且内容不同，保留原文件，请人工处理");
          if (apply) {
            if (!fs.existsSync(to)) fs.writeFileSync(to,html,{flag:"wx",mode:0o600});
            fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});
            if (fs.existsSync(dest)) throw new Error("备份路径已存在，未移动原文件");
            fs.renameSync(file,dest);
          }
          report.items.push({from:rel,to:path.relative(root,to),backup:path.relative(root,dest)});
        } catch (error) {report.errors.push({path:rel,error:error instanceof SyntaxError?"JSON 无法解析":error.message});}
      }
    }
  }
  walk(dir);
  // Existing installations keep schedule.json; migrate its paths without replacing custom schedules.
  const schedule=path.join(root,"system/schedule.json");
  if (fs.existsSync(schedule)&&!fs.lstatSync(schedule).isSymbolicLink()) {
    try {
      const raw=fs.readFileSync(schedule,"utf8"), jobs=JSON.parse(raw);
      let changed=false;
      for (const job of jobs) if (typeof job.prompt==="string") {
        const prompt=job.prompt.replace(/按简报格式写\s*JSON\s*到/g,"写到").replace(/(data\/briefs\/[^\s。]+)\.json/g,"$1.html");
        if (prompt!==job.prompt) {job.prompt=prompt;changed=true;}
      }
      if (changed) {
        const dest=path.join(backup,"system/schedule.json");
        report.schedule={path:"system/schedule.json",backup:path.relative(root,dest)};
        if (apply) {
          fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});
          fs.copyFileSync(schedule,dest,fs.constants.COPYFILE_EXCL);
          const tmp=schedule+".v05.tmp";
          fs.writeFileSync(tmp,JSON.stringify(jobs,null,2)+"\n",{mode:0o600});fs.renameSync(tmp,schedule);
        }
      }
    } catch (error) {report.errors.push({path:"system/schedule.json",error:error instanceof SyntaxError?"JSON 无法解析":error.message});}
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const i=process.argv.indexOf("--root"), root=i<0?null:process.argv[i+1];
  if (!root) {console.error("用法：node scripts/migrate-0.5.mjs --root <工作目录> [--apply]（默认 dry-run）");process.exitCode=1;}
  else {
    const report=migrate(root,{apply:process.argv.includes("--apply")});
    console.log(JSON.stringify(report,null,2));
    if (report.errors.length) process.exitCode=1;
  }
}
