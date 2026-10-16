// Scripted provider contract fixture. No cloud config, environment credentials,
// upstream network requests, or real keys are read. Only loopback ports are used.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {WebSocketServer}=createRequire(path.join(repo,'cloud/package.json'))('ws');
const output=process.env.V081_PROVIDER_OUTPUT || '/tmp/v081-android-shots/providers-fixture';
fs.mkdirSync(output,{recursive:true});
const builtin={id:'zenmux',name:'ZenMux',builtin:true,protocol:'anthropic',models:[
    {id:'anthropic/claude-haiku-5.5',name:'Claude Haiku 5.5',note:'消耗约 1×；输入超过 100K 后约 5×'},
    {id:'anthropic/claude-opus-5.5',name:'Claude Opus 5.5',note:'消耗约 40×；缓存读约 20×'},
    {id:'z-ai/glm-5.3-flash',name:'GLM 5.3 Flash',note:'输入约 1.5×，输出约 1×'},
    {id:'z-ai/glm-5.3-flashx',name:'GLM 5.3 FlashX',note:'输入约 3.75×，输出约 2.5×'},
]};
let providers=[builtin,{id:'custom-demo',name:'Demo Service',builtin:false,protocol:'anthropic',baseUrl:'https://example.test',keyHint:'abcd',models:[{id:'demo-sonnet',name:'Demo Sonnet',note:'自定义 Anthropic 模型'}]}];
let model={provider:'zenmux',id:builtin.models[0].id},permissionMode='auto',failNext=false,delay=350;
const permissionModes=[{id:'auto',label:'自动',note:'自动拦下危险操作'},{id:'bypassPermissions',label:'完全放行',note:'什么都不拦'}];
const settings=()=>({model,permissionMode,providers,permissionModes});
const requests=[];
const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body))};
const body=async req=>{let raw='';for await(const chunk of req)raw+=chunk;return JSON.parse(raw||'{}')};
const diagnostic=value=>JSON.parse(JSON.stringify(value,(k,v)=>k==='apiKey'?'[redacted]':v));
const record=(req,value)=>{const entry={method:req.method,path:req.url,body:diagnostic(value),keyPresent:Object.hasOwn(value,'apiKey')};requests.push(entry);fs.appendFileSync(path.join(output,'requests.jsonl'),JSON.stringify(entry)+'\n')};
const broadcast=()=>{for(const socket of ws.clients)if(socket.readyState===1)socket.send(JSON.stringify({t:'settings',...settings()}))};
async function test(value) {
    await new Promise(resolve=>setTimeout(resolve,delay));
    if(failNext || value.models?.[0]?.id==='reject-model' || value.model==='reject-model') {failNext=false;throw Error('演示服务返回 401：API Key 无效或模型不可用')}
}
function validate(value,editing) {
    if(typeof value.name!=='string' || !value.name.trim() || value.name.trim().length>40)throw Error('名称请填 1–40 字');
    const url=new URL(value.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.search||url.hash)throw Error('Base URL 格式不正确');
    if(!editing && !value.apiKey?.trim())throw Error('请填写 API Key');
    if(!Array.isArray(value.models)||value.models.length<1||value.models.length>20)throw Error('请添加 1–20 个模型');
    if(value.models.some(m=>!m.id?.trim()||m.id.length>200||!m.name?.trim()||m.name.length>40)||new Set(value.models.map(m=>m.id.trim())).size!==value.models.length)throw Error('模型格式不正确或 ID 重复');
}
const server=http.createServer(async(req,res)=>{try {
    const p=new URL(req.url,'http://127.0.0.1').pathname;
    if(req.headers.authorization!=='Bearer local-android-demo-only')return send(res,401,{error:'仅本机演示'});
    if(p==='/api/settings' && req.method==='GET')return send(res,200,settings());
    if(p==='/api/settings' && req.method==='PUT') {
        const value=await body(req);record(req,value);
        if(value.model) {if(!providers.some(p=>p.id===value.model.provider&&p.models.some(m=>m.id===value.model.id)))throw Error('请选择已有模型');model=value.model}
        if(value.permissionMode)permissionMode=value.permissionMode;broadcast();return send(res,200,settings());
    }
    if(p==='/api/providers/test' && req.method==='POST') {const value=await body(req);record(req,value);await test(value);return send(res,200,{ok:true,ms:delay})}
    if(p==='/api/providers' && req.method==='POST') {
        const value=await body(req);record(req,value);validate(value,false);await test(value);
        const provider={id:'custom-'+String(providers.length),name:value.name.trim(),builtin:false,protocol:'anthropic',baseUrl:value.baseUrl.replace(/\/+$/,''),keyHint:value.apiKey.trim().slice(-4),models:value.models};
        providers.push(provider);broadcast();return send(res,200,{provider});
    }
    if(p.startsWith('/api/providers/')) {
        const id=decodeURIComponent(p.slice('/api/providers/'.length)),index=providers.findIndex(p=>p.id===id&&!p.builtin);
        if(index<0)return send(res,404,{error:'找不到这个模型服务'});
        if(req.method==='PATCH') {
            const value=await body(req);record(req,value);const combined={...providers[index],...value};validate(combined,true);await test(combined);
            const provider={...providers[index],name:combined.name,baseUrl:combined.baseUrl.replace(/\/+$/,''),models:combined.models,...(value.apiKey?{keyHint:value.apiKey.trim().slice(-4)}:{})};
            providers[index]=provider;broadcast();return send(res,200,{provider});
        }
        if(req.method==='DELETE') {record(req,{});if(model.provider===id)return send(res,409,{error:'先换到别的模型'});providers.splice(index,1);broadcast();return send(res,200,{ok:true})}
    }
    if(p==='/api/state')return send(res,200,{version:'0.8.1',agentName:'豆豆',chatEmpty:false,busy:false,avatar:{state:'idle'},activities:[],devices:[],schedule:[]});
    if(p==='/api/history')return send(res,200,{items:[]});
    if(p==='/api/feed')return send(res,200,{items:[],next:null});
    if(p==='/api/activities')return send(res,200,{running:[],recent:[],next:null});
    send(res,404,{error:'演示中未使用的接口'});
} catch(e) {send(res,400,{error:e.message})}});
const ws=new WebSocketServer({server});ws.on('connection',socket=>socket.send(JSON.stringify({t:'hello',version:'0.8.1',busy:false,avatar:{state:'idle'},activities:[],devices:[],history:[]})));
await new Promise(resolve=>server.listen(18768,'127.0.0.1',resolve));
const control=http.createServer(async(req,res)=>{try {
    const value=await body(req);if(value.action==='fail-next')failNext=true;
    if(value.action==='delay')delay=value.ms;
    if(value.action==='external-select'){model=value.model;broadcast()}
    send(res,200,{ok:true,settings:settings(),requests});
}catch(e){send(res,400,{error:e.message})}});await new Promise(resolve=>control.listen(18769,'127.0.0.1',resolve));
fs.writeFileSync(path.join(output,'host.json'),JSON.stringify({pid:process.pid,mode:'scripted-contract',ports:[18768,18769]},null,2));
console.log('Provider contract fixture ready on 10.0.2.2:18768');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{for(const s of ws.clients)s.terminate();ws.close();server.closeAllConnections();control.closeAllConnections();server.close();control.close();process.exit(0)});
