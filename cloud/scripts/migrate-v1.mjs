// Offline one-way migration. Archive is verified before any source file is changed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialize, DEFAULT_JOBS } from '../src/initialize.mjs';
import { writePrivateJson } from '../src/private-json.mjs';
export function migrateV1({root,backup}){
 root=fs.realpathSync(root);backup=path.resolve(backup);
 const marker=path.join(root,'system/migrations/v1.json');
 if(fs.existsSync(marker))throw new Error('v1 已迁移，不重复执行');
 if(backup.startsWith(root+path.sep)||fs.existsSync(backup))throw new Error('请指定数据目录之外的新备份文件');
 fs.mkdirSync(path.dirname(backup),{recursive:true,mode:0o700});
 execFileSync('tar',['-czf',backup,'-C',root,'.'],{stdio:'pipe'});fs.chmodSync(backup,0o600);
 const entries=execFileSync('tar',['-tzf',backup],{maxBuffer:20<<20}).toString().split('\n').filter(Boolean);
 if(!entries.includes('./system/')||!entries.includes('./data/'))throw new Error('备份校验失败，未开始迁移');
 const sha256=crypto.createHash('sha256').update(fs.readFileSync(backup)).digest('hex');
 const originals=[];
 const list=(rel)=>{const dir=path.join(root,rel);if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const r=`${rel}/${e.name}`;if(e.isSymbolicLink())throw new Error('记忆/技能存在符号链接，迁移中止');if(e.isDirectory())list(r);else if(e.isFile()&&r.endsWith('.md'))originals.push(r);}};
 list('data/memory');list('data/soul/diary');
 fs.mkdirSync(path.join(root,'memory'),{recursive:true});const mapped=new Map();
 for(const rel of originals){
  const target=rel==='data/memory/profile/总档.md'?'USER.md':`memory/${rel.slice(5).replaceAll('/','-')}`;
  if(fs.existsSync(path.join(root,target)))throw new Error('迁移目标已存在，未覆盖');mapped.set(rel,target);
 }
 for(const [rel,target]of mapped){const st=fs.statSync(path.join(root,rel));let body=fs.readFileSync(path.join(root,rel),'utf8');for(const [old,next]of mapped)body=body.replaceAll(old,next);fs.writeFileSync(path.join(root,target),`<!-- 迁移来源：${rel}；原修改时间：${st.mtime.toISOString()}；迁移前事实需按新证据更新 -->\n`+body,{mode:0o600});}
 const soul=path.join(root,'data/soul/角色.md');if(fs.existsSync(soul))fs.copyFileSync(soul,path.join(root,'SOUL.md'));
 const skillSource=path.join(root,'.claude/skills');let skills=0;
 if(fs.existsSync(skillSource)){fs.mkdirSync(path.join(root,'skills'),{recursive:true});for(const e of fs.readdirSync(skillSource,{withFileTypes:true})){if(e.isDirectory()){fs.cpSync(path.join(skillSource,e.name),path.join(root,'skills',e.name),{recursive:true,errorOnExist:true,force:false});skills++;}}}
 const setting=path.join(root,'system/app-settings.json');if(fs.existsSync(setting)){const old=JSON.parse(fs.readFileSync(setting,'utf8'));writePrivateJson(setting,{model:old.model});}
 const providers=path.join(root,'system/providers.json');if(fs.existsSync(providers)){const old=JSON.parse(fs.readFileSync(providers,'utf8'));for(const p of old.providers)p.protocol='anthropic';writePrivateJson(providers,old);}
 let goals=0;
 for(const dir of ['data/goals','data/goals/done']){if(!fs.existsSync(path.join(root,dir)))continue;for(const e of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){if(!e.isFile()||!e.name.endsWith('.md'))continue;const source=path.join(root,dir,e.name);let body=fs.readFileSync(source,'utf8');body=body.replace(/^status:\s*["\']?(追踪中|完成|放弃)["\']?\s*$/m,(_,s)=>'status: '+({'追踪中':'进行中','完成':'已完成','放弃':'取消'}[s]));const target=dir.endsWith('/done')?path.join(root,'data/goals',fs.existsSync(path.join(root,'data/goals',e.name))?'归档-'+e.name:e.name):source;fs.writeFileSync(target,body,{mode:0o600});if(target!==source)fs.unlinkSync(source);goals++;}}
 const schedules=path.join(root,'system/schedule.json');let jobs=[];if(fs.existsSync(schedules))jobs=JSON.parse(fs.readFileSync(schedules,'utf8')).filter(j=>!['feed','ideas','night','compact','cleanup','health','health-sync','heartbeat'].includes(j.id)&&!['compact','night','memory','feed','ideas','health-sync','cleanup'].includes(j.kind));
 writePrivateJson(schedules,[...DEFAULT_JOBS,...jobs]);
 // Chat/session history is archived only, never imported into the new kernel.
 const retired=['system/browser','data/memory','data/soul','.claude','system/sessions','system/chat.jsonl','system/chat-options.json','system/side-chats','system/activity-index.json','system/task-index.json','system/state.json','system/jobs.jsonl','system/pending-results.json'];
 for(const rel of retired)fs.rmSync(path.join(root,rel),{recursive:true,force:true});
 initialize(root);
 const result={version:'1.0.0',at:new Date().toISOString(),backup,sha256,archiveEntries:entries.length,memoryFiles:mapped.size,skills,goals,sessionsImported:0};
 writePrivateJson(marker,result);return result;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);const value=k=>args[args.indexOf(k)+1];
 if(!args.includes('--root')||!args.includes('--backup'))throw new Error('用法：node migrate-v1.mjs --root <数据目录> --backup <完整备份.tar.gz>');
 console.log(JSON.stringify(migrateV1({root:value('--root'),backup:value('--backup')})));
}
