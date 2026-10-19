// Official skill content is cached/installed in the data root, never shipped in this repository.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { x as untar } from "tar";
export const MANAGED_SKILL_MARKER=".connector-managed.json";
export function managedSkillDirs(root) {
  const dir=path.join(root,"skills");
  try{return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()&&fs.existsSync(path.join(dir,e.name,MANAGED_SKILL_MARKER))).map(e=>path.join(dir,e.name));}catch{return [];}
}
import { writePrivateJson } from "../../src/private-json.mjs";
import { readJson } from "../../src/store.mjs";

export const SKILLS_URL="https://codeload.github.com/Wind-Information-Co-Ltd/wind-skills/tar.gz/refs/heads/main";
export const CORE_SKILLS=["wind-mcp-skill","wind-find-finance-skill","wind-alice"];
const nameOk=(s)=>typeof s==="string"&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(s);
export const installedName=(name)=>name.startsWith("wind-")?name:"wind-"+name;
const DIR_NOTE=`## 本环境的调用方式\n本环境用 wind.call 工具代替 node scripts/cli.mjs call <server_type> <tool> '<json>'：server 对应 server_type，tool 对应 tool，args 对应 JSON 对象。用 wind.list_tools(server) 查询参数。账号由连接器管理，不需要也不要配置 API Key；不要读取密钥或配置文件。技能更新由连接器负责，不运行技能自己的安装或更新脚本。\n`;
const section=(text,heading,replacement)=>text.replace(new RegExp(`^#{1,3} [^\\n]*${heading}[^\\n]*\\n[\\s\\S]*?(?=^#{1,3} |$(?![\\s\\S]))`,"gm"),replacement);

export function rewriteSkillMarkdown(text,{name}) {
  let body=text.replace(/^\uFEFF/,""),front="";
  const fm=body.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if(fm){front=name?fm[0].replace(/^name:\s*.*$/m,"name: "+installedName(name)):fm[0];body=body.slice(fm[0].length);}
  if(name==="wind-find-finance-skill") {
    // Keep the domain routing rules; discovery/installation now stays within the connector's cache.
    const route=body.indexOf("## 路由规则");
    body=`## 发现与安装\n1. 调用 wind.list_skills()，按名称和一句话描述选需要的数据或分析技能。\n2. 在 skills/wind-<原名>/SKILL.md 查看已经安装的技能；原名带 wind- 时不重复前缀。\n3. 缺少匹配的技能时调用 wind.install_skill(name)，安装完成后读取返回的 SKILL.md 路径，继续用户任务。只安装到当前豆豆，不安装到其他 agent。\n4. 不读取外部 catalog，不执行 npx、更新检查或配置脚本。\n\n`+(route>=0?body.slice(route):"");
    body=body.replace(/`references\/skills-catalog\.md`/g,"wind.list_skills() 的结果").replace(/第 [345] 步/g,"上面的发现步骤").replace(/询问安装范围/g,"调用 wind.install_skill(name)");
    body=section(body,"边界","## 边界\n本技能不直接取数。可用技能以连接器缓存为准，安装和升级只通过连接器工具完成。\n");
  }
  body=section(body,"一次性配置","");
  body=section(body,"更新检查(?:处理)?","");
  body=body.replace(/```(?:bash|powershell|shell)?\n([\s\S]*?)```/gi,(whole,code)=> {
    if(/npx\s+skills\s+(?:add|update)/i.test(code))return "使用 wind.install_skill(name) 安装所需技能。";
    if(/node\s+[^\n]*scripts\/cli\.mjs\s+call/.test(code)) {
      const m=code.match(/scripts\/cli\.mjs\s+call\s+([\w<>]+)\s+([\w<>]+)\s+['"]([\s\S]*?)['"]/);
      if(m&&!m[1].startsWith("<")){try{return "```json\n"+JSON.stringify({server:m[1],tool:m[2],args:JSON.parse(m[3])},null,2)+"\n```\n将以上参数传给 wind.call。";}catch{}}
      return "调用 wind.call(server=<server_type>, tool=<tool_name>, args=<params_json>)，直接传 JSON 对象，不经过 shell。";
    }
    if(/wind-alice\.mjs/.test(code))return "调用 wind.ask_alice(question)，question 保留用户问题原文。";
    if(/WIND_API_KEY|wind_api_key|\.wind-aifinmarket|config\.json/.test(code))return "";
    return whole;
  });
  // Remove paragraphs that instruct credential access; references/contracts remain verbatim otherwise.
  body=body.split(/\n\s*\n/).filter((p)=>!/WIND_API_KEY|wind_api_key|\.wind-aifinmarket|config\.json|\*\*Key\*\*|(?:node\s+.*cli\.mjs\s+open-portal)/i.test(p)).join("\n\n");
  body=body.replace(/`npx skills add [^`]+`/g,"wind.install_skill(name)");
  body=body.replace(/node\s+(?:scripts\/cli\.mjs|<[^>]+>\/scripts\/cli\.mjs)\s+call\s+[^\n`]+/g,"wind.call(server, tool, args)");
  body=body.replace(/`?scripts\/(?:update-check\.[\w]+|cli\.mjs|wind-alice\.mjs)`?/g,"连接器工具");
  if(name==="wind-alice") {
    body=section(body,"文件下载处理","## 附件\n本环境工具返回 Alice 的原始正文与附件引用；不自动下载附件，也不读取本地配置。\n");
  }
  return front+(name?"\n"+DIR_NOTE:"")+(name==="wind-alice"?"\nAlice 用 wind.ask_alice(question) 调用，同一连接器账号鉴权。保留用户问题原文；CLI 的 --skill 和自动下载不适用于本环境。\n":"")+"\n"+body.trim()+"\n";
}
function description(text) {
  const fm=text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]||"";
  const lines=fm.split(/\r?\n/),i=lines.findIndex((l)=>/^description:/.test(l));
  if(i<0)return "";
  let desc=lines[i].replace(/^description:\s*/,"").replace(/^['"]|['"]$/g,"");
  if(/^[>|][-+]?\s*$/.test(desc))desc=lines.slice(i+1).filter((l)=>/^\s/.test(l)).join(" ").trim();
  return desc.replace(/\s+/g," ").split(/[。\n]/)[0].slice(0,180);
}
export class WindSkills {
  constructor({ctx,fetchImpl=fetch,archiveUrl=SKILLS_URL}) {
    Object.assign(this,{ctx,fetchImpl,archiveUrl});this.cache=path.join(ctx.root,"system/connector-cache/wind");this.skills=path.join(this.cache,"skills");
  }
  list() {
    if(!fs.existsSync(this.skills))throw new Error("Wind 技能缓存尚未安装，请重新连接 Wind");
    return fs.readdirSync(this.skills,{withFileTypes:true}).filter((e)=>e.isDirectory()&&nameOk(e.name)&&fs.existsSync(path.join(this.skills,e.name,"SKILL.md")))
      .map((e)=>({name:e.name,description:description(fs.readFileSync(path.join(this.skills,e.name,"SKILL.md"),"utf8"))})).sort((a,b)=>a.name.localeCompare(b.name));
  }
  async refresh() {
    const manifest=readJson(path.join(this.cache,"manifest.json"),{}),version=this.ctx.version||"0.6.0";
    if(manifest.version===version&&Date.now()-Date.parse(manifest.checkedAt)<86400_000&&fs.existsSync(this.skills))return;
    const response=await this.fetchImpl(this.archiveUrl,{signal:AbortSignal.timeout(30_000)});
    if(!response.ok)throw new Error("Wind 官方技能暂时无法下载，请稍后重试");
    const chunks=[];let size=0;
    for await(const chunk of response.body) {size+=chunk.length;if(size>20*1024*1024)throw new Error("Wind 技能包超过 20MB，已停止安装");chunks.push(chunk);}
    const archive=Buffer.concat(chunks),hash=crypto.createHash("sha256").update(archive).digest("hex");
    if(hash===manifest.sha256&&fs.existsSync(this.skills)){writePrivateJson(path.join(this.cache,"manifest.json"),{...manifest,version,checkedAt:new Date().toISOString()});return;}
    fs.mkdirSync(this.cache,{recursive:true,mode:0o700});const temp=fs.mkdtempSync(path.join(this.cache,".download-"));
    try {
      const file=path.join(temp,"source.tgz"),extract=path.join(temp,"extract");fs.writeFileSync(file,archive,{mode:0o600});fs.mkdirSync(extract);
      let total=0;
      await untar({file,cwd:extract,strip:1,preservePaths:false,strict:true,filter:(p,entry)=> {
        if(!["File","Directory"].includes(entry.type)||p.split("/").includes("..")||path.isAbsolute(p))return false;
        total+=entry.size||0;if(total>80*1024*1024)throw new Error("Wind 技能解压体积超过上限");return true;
      }});
      const source=path.join(extract,"skills");
      if(!CORE_SKILLS.every((name)=>fs.existsSync(path.join(source,name,"SKILL.md"))))throw new Error("Wind 技能包缺少核心技能");
      fs.writeFileSync(path.join(temp,"source.tgz"),archive,{mode:0o600});
      if(fs.existsSync(this.skills))fs.renameSync(this.skills,path.join(temp,"previous"));
      fs.renameSync(source,this.skills);fs.renameSync(file,path.join(this.cache,"source.tgz"));
      writePrivateJson(path.join(this.cache,"manifest.json"),{version,sha256:hash,checkedAt:new Date().toISOString()});
    } finally {fs.rmSync(temp,{recursive:true,force:true});}
  }
  installSkill(name) {
    if(!nameOk(name))throw new Error("技能名格式不正确");
    const source=path.join(this.skills,name);if(!fs.existsSync(path.join(source,"SKILL.md")))throw new Error("Wind 缓存里没有这个技能，请先 list_skills");
    const destination=path.join(this.ctx.root,"skills",installedName(name)),manifest=readJson(path.join(this.cache,"manifest.json"),{});
    const marker=path.join(destination,MANAGED_SKILL_MARKER);
    if(fs.existsSync(destination)&&(!fs.existsSync(marker)||readJson(marker,{}).connector!=="wind"))throw new Error("同名技能已经存在且不归连接器管理，未覆盖");
    const parent=path.dirname(destination);fs.mkdirSync(parent,{recursive:true});const temp=fs.mkdtempSync(path.join(parent,".wind-install-"));
    try {
      const copy=(src,dst)=> {
        for(const entry of fs.readdirSync(src,{withFileTypes:true})) {
          const file=path.join(src,entry.name),out=path.join(dst,entry.name);
          if(entry.isSymbolicLink())continue;
          // Upstream self-update code can overwrite managed skills, so it is not installed.
          if(/^(?:update-check|update-state)/.test(entry.name)||/^config(?:\.|$)/.test(entry.name))continue;
          if(entry.isDirectory()){fs.mkdirSync(out);copy(file,out);}
          else if(entry.isFile()) {
            const data=fs.readFileSync(file),ext=path.extname(entry.name);
            if(/\.(?:[cm]?js|py|sh|ps1)$/.test(entry.name)&&(/WIND_API_KEY|wind_api_key|\.wind-aifinmarket|config\.json|child_process/.test(data.toString("utf8"))||/^(?:cli|request|wind-alice)\./.test(entry.name)))continue;
            fs.writeFileSync(out,ext===".md"?rewriteSkillMarkdown(data.toString("utf8"),{name:src===source&&entry.name==="SKILL.md"?name:null}):data);
          }
        }
      };
      copy(source,temp);
      writePrivateJson(path.join(temp,MANAGED_SKILL_MARKER),{connector:"wind",name,version:manifest.sha256,appVersion:this.ctx.version||"0.6.0",installedAt:new Date().toISOString()});
      if(fs.existsSync(destination))fs.rmSync(destination,{recursive:true});fs.renameSync(temp,destination);
    } finally {fs.rmSync(temp,{recursive:true,force:true});}
    return {name,path:path.relative(this.ctx.root,path.join(destination,"SKILL.md")),installed:true};
  }
  async install() {
    // Reinstall user-selected managed skills on upgrades as well as the three core skills.
    const selected=managedSkillDirs(this.ctx.root).map((d)=>readJson(path.join(d,MANAGED_SKILL_MARKER),{})).filter((m)=>m.connector==="wind").map((m)=>m.name);
    await this.refresh();
    const manifest=readJson(path.join(this.cache,"manifest.json"),{});
    for(const name of new Set([...CORE_SKILLS,...selected])) {
      if(!nameOk(name)||!fs.existsSync(path.join(this.skills,name,"SKILL.md")))continue;
      const marker=readJson(path.join(this.ctx.root,"skills",installedName(name),MANAGED_SKILL_MARKER),{});
      if(marker.version!==manifest.sha256||marker.appVersion!==(this.ctx.version||"0.6.0")||!fs.existsSync(path.join(this.ctx.root,"skills",installedName(name),"SKILL.md")))this.installSkill(name);
    }
  }
  uninstall() {
    for(const dir of managedSkillDirs(this.ctx.root))if(path.basename(dir).startsWith("wind-")&&readJson(path.join(dir,MANAGED_SKILL_MARKER),{}).connector==="wind")fs.rmSync(dir,{recursive:true});
  }
}
