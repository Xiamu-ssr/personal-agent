import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { inside, resolvedPath } from "./local-paths.mjs";

export const MANAGED_SKILL_MARKER=".connector-managed.json";
const deny=(reason)=>({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:reason}});
export function managedSkillDirs(root) {
  const dir=path.join(root,".claude/skills");
  try{return fs.readdirSync(dir,{withFileTypes:true}).filter((e)=>e.isDirectory()&&fs.existsSync(path.join(dir,e.name,MANAGED_SKILL_MARKER))).map((e)=>path.join(dir,e.name));}catch{return [];}
}
export function checkDataAccess(input,{root=config.root}={}) {
  const name=input.tool_name,args=input.tool_input||{};
  if(!["Write","Edit","MultiEdit","NotebookEdit","Bash"].includes(name))return {};
  const dirs=[{dir:path.join(root,"data/health"),reason:"data/health/ 是系统从手机同步的原始健康数据，豆豆只能读取，不能写入、修改或删除。请通过健康同步更新。"},
    ...managedSkillDirs(root).map((dir)=>({dir,reason:"这是连接器安装并维护的官方技能，不能修改或删除。需要更新或安装请使用连接器工具。"}))];
  if(name==="Bash") {
    const command=String(args.command||"");
    // Hooks are a conservative shell guard, not an OS sandbox. Read-only commands remain available.
    const readOnly=/^(?:\s*(?:cat|head|tail|less|ls|stat|du|wc|rg|grep|find|sed|awk)\b[^;&|>]*)(?:\s*\|\s*(?:head|tail|wc|grep|rg)\b[^;&|>]*)*\s*$/.test(command)&&
      !/\b(?:sed\s+[^\n]*-i|find\s+[^\n]*-(?:delete|exec)|awk\s+[^\n]*(?:system\s*\(|print[^\n]*>))/.test(command);
    const readsData=/\b(?:readFileSync|readFile|read_text|read_bytes|json\.load|read_csv|read_json)\b/.test(command);
    const mutatesData=/\b(?:writeFileSync|writeFile|appendFile|write_text|write_bytes|unlink|rmdir|rename|remove|mkdir|truncate|chmod|chown|rm|mv|cp|rsync|tee|touch|eval|exec|subprocess|child_process)\b|open\([^\n]*,\s*["'](?:w|a|x)|[^<]>\s*[^=]/.test(command);
    if((readOnly||readsData&&!mutatesData)&&!/[`$]/.test(command))return {};
    const tokens=command.match(/(?:\/(?:[^\s'";|<>]+)|(?:\.?\.?\/)?(?:data|\.claude|workspace)\/[^\s'";|<>]*)/g)||[];
    for(const {dir,reason} of dirs) {
      const rel=path.relative(root,dir);
      if(command.includes(rel)||command.includes(dir))return deny(reason);
      for(const token of tokens) {const file=resolvedPath(path.resolve(root,token));if(inside(file,resolvedPath(dir))||inside(resolvedPath(dir),file))return deny(reason);}
    }
    if(/\b(?:rm|mv|cp|rsync|tar|unzip|chmod|chown|find)\b/.test(command)&&/(?:^|\s)(?:\.?\/?data\/?|\.claude\/?|\.)(?:\s|$)/.test(command))return deny(dirs[0].reason);
    return {};
  }
  const targets=[args.file_path,args.notebook_path,...(Array.isArray(args.edits)?args.edits.map((e)=>e.file_path):[])].filter((p)=>typeof p==="string");
  for(const target of targets)for(const {dir,reason} of dirs) {
    const file=path.resolve(root,target);
    if(inside(file,dir)||inside(resolvedPath(file),resolvedPath(dir)))return deny(reason);
  }
  return {};
}
