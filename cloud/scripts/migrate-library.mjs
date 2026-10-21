// Offline one-way migration; the runtime never reads the retired layout.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function migrateLibrary({root,backup,existingBackup=false}) {
 if(!root||!backup)throw new Error('需要数据目录和完整备份路径');
 root=fs.realpathSync(root);backup=path.resolve(backup);
 if(backup.startsWith(root+path.sep))throw new Error('备份必须在数据目录之外');
 const old=path.join(root,'data/library/artifacts');
 if(!fs.existsSync(old))return {migrated:false};
 if(!existingBackup){if(fs.existsSync(backup))throw new Error('备份已存在');fs.mkdirSync(path.dirname(backup),{recursive:true});execFileSync('tar',['-czf',backup,'-C',root,'.']);fs.chmodSync(backup,0o600);}
 execFileSync('tar',['-tzf',backup],{maxBuffer:64*1024*1024});
 const mappings=[],support=[];
 const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{if(e.isSymbolicLink())throw new Error('迁移不接受符号链接');return e.isDirectory()?walk(path.join(dir,e.name)):e.isFile()?[path.join(dir,e.name)]:[]});
 for(const e of fs.readdirSync(old,{withFileTypes:true})) {
  if(e.isSymbolicLink())throw new Error('迁移不接受符号链接');
  const source='data/library/artifacts/'+e.name;let target;
  if(e.isDirectory())target='data/library/'+(walk(path.join(root,source)).some(f=>/\.html?$/i.test(f))?'sites/':'documents/')+e.name;
  else if(/\.html?$/i.test(e.name))target='data/library/sites/'+e.name.replace(/\.html?$/i,'')+'/index.html';
  else if(/\.(?:md|markdown|pdf|txt|csv|json|docx|xlsx|pptx|zip)$/i.test(e.name))target='data/library/documents/'+e.name;
  else {support.push(source);continue;}
  if(fs.existsSync(path.join(root,target))||mappings.some(([,other])=>other===target||target.startsWith(other+'/')||other.startsWith(target+'/')))throw new Error('目标文件存在迁移冲突');
  mappings.push([source,target]);
 }
 for(const rel of support)if(fs.existsSync(path.join(root,'data/library/media',path.basename(rel))))throw new Error('媒体文件存在迁移冲突');
 for(const [source,target] of mappings) {
  fs.mkdirSync(path.dirname(path.join(root,target)),{recursive:true,mode:0o700});fs.renameSync(path.join(root,source),path.join(root,target));
  if(/\.html?$/i.test(source))for(const asset of support)fs.copyFileSync(path.join(root,asset),path.join(root,path.dirname(target),path.basename(asset)));
 }
 for(const rel of support){const target='data/library/media/'+path.basename(rel);fs.mkdirSync(path.dirname(path.join(root,target)),{recursive:true,mode:0o700});fs.renameSync(path.join(root,rel),path.join(root,target));mappings.push([rel,target]);}
 mappings.sort((a,b)=>b[0].length-a[0].length);
 let rewritten=0;
 const textFiles=[...['data','memory','system'].flatMap(dir=>fs.existsSync(path.join(root,dir))?walk(path.join(root,dir)):[]),...['USER.md','MEMORY.md','SOUL.md'].map(f=>path.join(root,f)).filter(f=>fs.existsSync(f))];
 for(const file of textFiles) {
  if(!/\.(?:md|markdown|json|jsonl|html?|css|js|txt)$/i.test(file)||fs.statSync(file).size>64*1024*1024)continue;
  const before=fs.readFileSync(file,'utf8');let after=before;
  for(const [from,to] of mappings)after=after.replaceAll(from,to).replaceAll(from.replaceAll('/','\\/'),to.replaceAll('/','\\/')).replaceAll(from.split('/').map(encodeURIComponent).join('/'),to.split('/').map(encodeURIComponent).join('/')).replaceAll(encodeURIComponent(from),encodeURIComponent(to));
  if(after!==before){fs.writeFileSync(file,after,{mode:0o600});rewritten++;}
 }
 fs.rmSync(old,{recursive:true});fs.rmSync(path.join(root,'system/pending-results.json'),{force:true});
 const hash=crypto.createHash('sha256'),fd=fs.openSync(backup,'r'),chunk=Buffer.allocUnsafe(1024*1024);
 try{for(let size;(size=fs.readSync(fd,chunk,0,chunk.length,null))>0;)hash.update(chunk.subarray(0,size));}finally{fs.closeSync(fd);}
 const result={migrated:true,at:new Date().toISOString(),moved:mappings.length,rewritten,backupSha256:hash.digest('hex')};
 fs.mkdirSync(path.join(root,'system'),{recursive:true,mode:0o700});fs.writeFileSync(path.join(root,'system/library-migration.json'),JSON.stringify(result),{mode:0o600});return result;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {const value=k=>process.argv[process.argv.indexOf(k)+1];console.log(JSON.stringify(migrateLibrary({root:value('--root'),backup:value('--backup')})));}
