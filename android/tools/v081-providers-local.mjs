// Real local cloud HTTP/WS/Providers/Harness, isolated data and scripted model.
// Only the example.test Messages transport is routed to a loopback fake upstream.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {once} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const output=process.env.V081_PROVIDER_OUTPUT || '/tmp/v081-android-shots/providers-local';fs.mkdirSync(output,{recursive:true});
const root=fs.mkdtempSync('/tmp/v081-provider-cloud-');
for(const key of Object.keys(process.env))if(/TOKEN|KEY|SECRET|PASSWORD|ANTHROPIC|ZENMUX|CLAUDE|PROXY/i.test(key))delete process.env[key];
Object.assign(process.env,{AGENT_ROOT:root,AGENT_TOKEN:'local-android-demo-only',AGENT_HOST:'127.0.0.1',AGENT_PORT:'18768',AGENT_TZ:'Asia/Shanghai',NO_PROXY:'*'});
const fakeKey='sk-test-0000abcd';let failNext=false,delay=350;const requests=[],wire=[],events=[];
const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value))};
const read=async req=>{let raw='';for await(const part of req)raw+=part;return JSON.parse(raw||'{}')};
const upstream=http.createServer(async(req,res)=>{
    const body=await read(req);wire.push({path:req.url,model:body.model,maxTokens:body.max_tokens,messages:body.messages,keyMatched:req.headers['x-api-key']===fakeKey});
    await new Promise(resolve=>setTimeout(resolve,delay));
    if(failNext){failNext=false;send(res,401,{error:{type:'authentication_error',message:'API Key 无效或模型不可用'}})}
    else send(res,200,{id:'fake-provider-response',type:'message',role:'assistant',content:[{type:'text',text:'OK'}],model:body.model,stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}});
});await new Promise(resolve=>upstream.listen(18771,'127.0.0.1',resolve));
const originalHttpsRequest=https.request;
https.request=(url,options,callback)=>{
    const target=new URL(url);if(target.hostname!=='example.test')throw Error('Only the demo provider is permitted');
    return http.request(new URL(target.pathname,'http://127.0.0.1:18771'),options,callback);
};
const module=name=>import(pathToFileURL(path.join(repo,'cloud',name)));
const [{Harness},{DeviceHub},{Content},{startServer},{Schedules},{migrateV08},{queryFixture}]=await Promise.all(['src/agent.mjs','src/devices.mjs','src/content.mjs','src/server.mjs','src/scheduler.mjs','src/migrate-v08.mjs','test/query-fixture.mjs'].map(module));
migrateV08({root,seedDir:path.join(repo,'cloud/seed')});
const listeners=new Set();const bus={on:fn=>listeners.add(fn),emit:event=>{events.push(event);for(const fn of listeners)fn(event)}};
const calls=[];let h;
const queryFactory=queryFixture(calls,{onInput(q){h.speech.emit({text:'可以在设置里添加模型服务。'},{activityId:h.main.activityId});q.emit({type:'result',subtype:'success'});q.emit({type:'system',subtype:'session_state_changed',state:'idle'})}});
const hub=new DeviceHub();h=new Harness({hub,bus,log(){},queryFactory,summarize:async()=>({title:'演示设置',summary:'演示模型服务设置。'})});h.startMain();
const content=new Content({root,bus});const schedules=new Schedules({harness:h,content});
const server=startServer({harness:h,hub,bus,content,schedules,log(){}});await once(server,'listening');
server.prependListener('request',(req)=>{
    if(!/^\/api\/(providers(?:\/|$)|settings$)/.test(req.url||'')||req.method==='GET')return;
    let raw='';req.on('data',part=>{raw+=part});req.on('end',()=>{
        const body=JSON.parse(raw||'{}');const entry={method:req.method,path:req.url,body:JSON.parse(JSON.stringify(body,(key,value)=>key==='apiKey'?'[redacted]':value)),keyPresent:Object.hasOwn(body,'apiKey')};
        requests.push(entry);fs.appendFileSync(path.join(output,'requests.jsonl'),JSON.stringify(entry)+'\n');
    });
});
async function api(method,p,body) {const r=await fetch('http://127.0.0.1:18768'+p,{method,headers:{authorization:'Bearer local-android-demo-only','content-type':'application/json'},...(body&&{body:JSON.stringify(body)})});const value=await r.json();if(!r.ok)throw Error(value.error);return value}
await api('POST','/api/providers',{name:'Demo Service',baseUrl:'https://example.test',apiKey:fakeKey,models:[{id:'demo-sonnet',name:'Demo Sonnet'}]});
const control=http.createServer(async(req,res)=>{try{
    const value=await read(req);if(value.action==='fail-next')failNext=true;if(value.action==='delay')delay=value.ms;
    if(value.action==='external-select')await api('PUT','/api/settings',{model:value.model});
    send(res,200,{ok:true,requests,wire,settings:await api('GET','/api/settings')});
}catch(e){send(res,400,{error:e.message})}});await new Promise(resolve=>control.listen(18769,'127.0.0.1',resolve));
fs.writeFileSync(path.join(output,'host.json'),JSON.stringify({pid:process.pid,root,mode:'real-local-cloud',ports:[18768,18769,18771]},null,2));
console.log('Real local provider cloud ready on 10.0.2.2:18768');
let closing=false;async function close(){if(closing)return;closing=true;https.request=originalHttpsRequest;
    fs.writeFileSync(path.join(output,'proof.json'),JSON.stringify({requests,wire,events:events.filter(e=>e.t==='settings'),model:'cloud/test/query-fixture.mjs'},null,2));
    control.closeAllConnections();control.close();await h.close();server.closeSockets();server.closeAllConnections();server.close();upstream.closeAllConnections();upstream.close();process.exit(0)}
process.on('SIGTERM',close);process.on('SIGINT',close);
