import fs from 'node:fs';
import path from 'node:path';
import { CODE } from './config.mjs';
import { writePrivateJson } from './private-json.mjs';
export const DEFAULT_JOBS=[
 {id:'heartbeat',name:'继续未完成的事',kind:'heartbeat',cron:'*/30 * * * *'},
 {id:'feed',name:'动态',kind:'feed'},
 {id:'ideas',name:'点子',kind:'ideas',cron:'0 10 * * *'},
 {id:'health',name:'健康同步',kind:'health-sync',cron:'0 */3 * * *'},
 {id:'cleanup',name:'清理草稿',kind:'cleanup',cron:'0 4 * * *'},
];
export function initialize(root){
 if(fs.existsSync(path.join(root,'data/memory'))||fs.existsSync(path.join(root,'.claude')))throw new Error('请先停服并运行 v1 持久化迁移，再启动新版');
 for(const dir of ['data/feed','data/ideas','data/goals','data/library/artifacts','data/library/media','data/health','data/uploads','workspace','system/connectors','system/sync','memory','skills'])fs.mkdirSync(path.join(root,dir),{recursive:true,mode:0o700});
 const seed=(file,text)=>{if(!fs.existsSync(path.join(root,file)))fs.writeFileSync(path.join(root,file),text,{mode:0o600});};
 seed('SOUL.md','# 豆豆\n\n你是用户的个人助理，坦诚、有判断，持续把已经答应的事做完。\n');
 seed('USER.md','# 关于用户\n\n从日常交流中逐渐认识用户；尚不知道的不要编造。\n');
 seed('MEMORY.md','# 长期记忆\n');
 seed('HEARTBEAT.md',fs.readFileSync(path.join(CODE,'../spec/prompts/heartbeat.md'),'utf8'));
 seed('data/feed/动态说明.md',fs.readFileSync(path.join(CODE,'seed/data/feed/动态说明.md'),'utf8'));
 if(!fs.existsSync(path.join(root,'system/schedule.json')))writePrivateJson(path.join(root,'system/schedule.json'),DEFAULT_JOBS);
}
