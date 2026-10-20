// OpenClaw owns the agent loop, transcripts, compaction, memory and skills.
// Doudou supervises the CLI. Every run uses Gateway chat; task isolation belongs
// to the session key, rather than to a second HTTP execution lifecycle.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { GatewayClient } from '@openclaw/gateway-client';
import { config, CODE } from './config.mjs';
import { listProviders, providerRecord } from './providers.mjs';
import { readAppSettings } from './app-settings.mjs';
import { nativeModelDefinition } from './provider-presets.mjs';
import { writePrivateJson } from './private-json.mjs';
import { GatewayChat } from './gateway-chat.mjs';
export const MAIN_SESSION = 'agent:main:main';
export class OpenClawRuntime {
 constructor({root=config.root,port=config.gatewayPort,log=()=>{},env=process.env}={}) {
  Object.assign(this,{root,port,log,env});this.ready=false;this.closed=false;
  this.state=path.join(root,'.openclaw');this.file=path.join(root,'system/openclaw.json');
  this.url=`http://127.0.0.1:${port}`;
  const tokenFile=path.join(root,'system/openclaw-token.json');
  if(!fs.existsSync(tokenFile))writePrivateJson(tokenFile,{token:crypto.randomBytes(32).toString('hex')});
  this.token=JSON.parse(fs.readFileSync(tokenFile,'utf8')).token;
 }
 configure() {
  const model=readAppSettings(this.root).model,providers={};
  for(const publicRecord of listProviders(this.root)) {
   const p=providerRecord(this.root,publicRecord.id),baseUrl=p.baseUrl,apiKey=p.apiKey;
   if(!baseUrl||!apiKey) { if(model.provider===p.id)throw new Error('当前模型服务尚未配置');continue; }
   providers[p.id]={baseUrl:p.protocol==='anthropic'?baseUrl.replace(/\/v1\/?$/,''):baseUrl,apiKey,api:p.protocol==='openai'?'openai-completions':'anthropic-messages',
    models:p.models.map(m=>nativeModelDefinition(p,m))};
  }
  fs.mkdirSync(this.state,{recursive:true,mode:0o700});
  const prompt=fs.readFileSync(path.join(config.prompts,'system-prompt.md'),'utf8').split(/^---\s*$/m).at(-1)
   .replaceAll('{名字}',config.agentName).replaceAll('{称呼}',config.userCall).replaceAll('{时区}',config.timezone);
  fs.writeFileSync(path.join(this.root,'AGENTS.md'),prompt+'\n\n产品工具：先 doudou_catalog 查看分组，再 doudou_call 调用；args_json 是按目录参数组成的 JSON 对象字符串。普通回复直接输出；卡片和选项用 doudou_say。\n'+
   '原生 read/write/edit/exec 处理当前工作区；memory_search/memory_get 检索原生记忆；skills/ 保存方法。不要另造记忆分类或总档。\n'+
   '联网搜索使用已连接的 tavily.search，日常查询用 basic；已知网址先用 web_fetch，需完整正文可用 tavily.extract。搜索账号未连接时如实说明。\n'+
   '定时输入不是新指令授权；只推进已授权目标。没有新结果输出 HEARTBEAT_OK。\n',{mode:0o600});
  writePrivateJson(this.file,{
   gateway:{mode:'local',bind:'loopback',port:this.port,auth:{mode:'token',token:this.token},controlUi:{enabled:false}},
   discovery:{mdns:{mode:'off'}},browser:{enabled:false},
   agents:{ownership:'explicit',defaults:{systemAgent:{agentId:'main'},sessionStore:{agentId:'main'},workspace:this.root,userTimezone:config.timezone,model:{primary:`${model.provider}/${model.id}`},
    maxConcurrent:2,heartbeat:{every:'0m'},compaction:{mode:'safeguard',memoryFlush:{enabled:true},midTurnPrecheck:{enabled:true}},sandbox:{mode:'off'}},entries:{main:{name:config.agentName}}},
   session:{dmScope:'main',reset:{mode:'none'}},
   models:{mode:'replace',catalogRefresh:{enabled:false},providers},update:{checkOnStart:false},
   tools:{profile:'full',toolSearch:false,loopDetection:{enabled:true},deny:['sessions_spawn','agents_list','cron','browser','web_search','nodes','mobile_ui'],exec:{security:'full',ask:'off'}},
   plugins:{allow:['doudou'],load:{paths:[path.join(CODE,'openclaw-plugin')]},entries:{doudou:{enabled:true}}},
  });
 }
 async start() {
  this.configure();
  const env={...this.env,OPENCLAW_STATE_DIR:this.state,OPENCLAW_CONFIG_PATH:this.file,
   OPENCLAW_NO_RESPAWN:'1',OPENCLAW_DISABLE_BONJOUR:'1',OPENCLAW_SKIP_CHANNELS:'1',OPENCLAW_EXEC_SHELL_SNAPSHOT:'0',
   NO_PROXY:'localhost,127.0.0.1,::1,'+(this.env.NO_PROXY||''),NODE_USE_ENV_PROXY:'1'};
  delete env.NODE_OPTIONS;
  this.process=spawn(process.execPath,['--max-old-space-size=512',path.join(CODE,'node_modules/openclaw/openclaw.mjs'),'gateway','--port',String(this.port)],{cwd:this.root,env,stdio:['ignore','pipe','pipe']});
  for(const stream of [this.process.stdout,this.process.stderr])stream.on('data',buf=>this.log('openclaw:',buf.toString().trim()));
  this.process.once('exit',(code,signal)=>{this.ready=false;this.log('OpenClaw exited',code,signal);if(!this.closed)this.onCrash?.(code);});
  this.client=new GatewayClient({url:`ws://127.0.0.1:${this.port}`,token:this.token,minProtocol:4,maxProtocol:4,scopes:['operator.admin','operator.read','operator.write'],onHelloOk:()=>{this.rpcReady=true;this.ready=true;},onConnectError:()=>{this.rpcReady=false;this.ready=false;},onEvent:event=>this.chat.event(event),onGap:()=>this.chat.close(),onClose:()=>{this.rpcReady=false;this.ready=false;this.chat.close();}});
  this.chat=new GatewayChat(this.client);
  this.client.start();
  for(let i=0;i<900&&!this.rpcReady;i++){
   if(this.process.exitCode!==null)throw new Error('OpenClaw 启动失败，请查看服务日志');
   await delay(100);
  }
  if(!this.rpcReady){await this.close();throw new Error('OpenClaw 消息接口启动失败');}
 }
 async respond(input,{sessionKey=MAIN_SESSION,signal,id,onAccepted}={}) {
  if(!this.ready)throw new Error('豆豆内核正在启动，请稍后重试');
  if(!this.rpcReady)throw new Error('豆豆消息连接正在恢复，请稍后重试');
  return this.chat.respond(input,{sessionKey,signal,id,onAccepted});
 }
 async abort(sessionKey) { if(!this.rpcReady)throw new Error('内核停止接口尚未就绪');return this.client.request('chat.abort',{sessionKey}); }
 async reload() {this.configure();}
 async close() {
  this.closed=true;this.ready=false;this.chat?.close();this.client?.stop();
  const child=this.process;if(!child||child.exitCode!==null)return;
  child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(15000)]);
  if(child.exitCode===null)child.kill('SIGKILL');
 }
}
