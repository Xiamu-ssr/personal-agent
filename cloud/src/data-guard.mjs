import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { inside, resolvedPath } from "./local-paths.mjs";
import { bashWriteTargets } from "./bash-writes.mjs";

export const MANAGED_SKILL_MARKER=".connector-managed.json";
const deny=(reason)=>({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:reason}});
export function managedSkillDirs(root) {
  const dir=path.join(root,".claude/skills");
  try{return fs.readdirSync(dir,{withFileTypes:true}).filter((e)=>e.isDirectory()&&fs.existsSync(path.join(dir,e.name,MANAGED_SKILL_MARKER))).map((e)=>path.join(dir,e.name));}catch{return [];}
}
export function checkDataAccess(input,{root=config.root,feed=false}={}) {
  const name=input.tool_name,args=input.tool_input||{};
  if(!["Write","Edit","MultiEdit","NotebookEdit","Bash"].includes(name))return {};
  const dirs=[{dir:path.join(root,"data/health"),reason:"data/health/ 是系统从手机同步的原始健康数据，豆豆只能读取，不能写入、修改或删除。请通过健康同步更新。"},
    {dir:path.join(root,"data/uploads"),reason:"data/uploads/ 是用户上传的原始文件，豆豆只能读取，不能修改或删除。"},
    ...(feed?[{dir:path.join(root,"data/feed/动态说明.md"),reason:"[动态] 后台运行只能读取动态说明，不能修改或删除用户的偏好。请在主聊天中按用户要求更新。"}]:[]),
    ...managedSkillDirs(root).map((dir)=>({dir,reason:"这是连接器安装并维护的官方技能，不能修改或删除。需要更新或安装请使用连接器工具。"}))];
  if(name==="Bash") {
    const writes=bashWriteTargets(String(args.command||""),root);
    for(const {dir,reason} of dirs) {
      for(const target of writes) {
        const prefix=target.match(/[*?[]/)?.index;
        const file=resolvedPath(prefix===undefined?target:path.dirname(target.slice(0,prefix)+"_"));
        if(inside(file,resolvedPath(dir))||inside(resolvedPath(dir),file))return deny(reason);
      }
    }
    return {};
  }
  const targets=[args.file_path,args.notebook_path,...(Array.isArray(args.edits)?args.edits.map((e)=>e.file_path):[])].filter((p)=>typeof p==="string");
  for(const target of targets)for(const {dir,reason} of dirs) {
    const file=path.resolve(root,target);
    if(inside(file,dir)||inside(resolvedPath(file),resolvedPath(dir)))return deny(reason);
  }
  return {};
}
