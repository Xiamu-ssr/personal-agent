// Loopback-only UI fixture. No credentials, paid APIs or real device/user data.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { WebSocketServer } from 'ws';
import { listProviderPresets } from '../src/provider-presets.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const fixture=JSON.parse(fs.readFileSync(process.env.DOUDOU_UI_FIXTURE || path.join(root,'verification/v1.6.0/fixture.json'),'utf8'));
const settings=fixture.settings; settings.providerPresets=listProviderPresets();
const requests=[];
const socketStats={connections:0,serverPings:0,pongs:0,clientPings:0,registrations:0};
let deviceSocket;
const batteryCalls=new Map();
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1'),p=url.pathname;
 const send=(code,body)=>{res.writeHead(code,{'content-type':'application/json;charset=utf-8'});res.end(JSON.stringify(body));};
 let body={};if(['POST','PUT','PATCH'].includes(req.method)){let raw='';for await(const chunk of req)raw+=chunk;body=JSON.parse(raw||'{}');}
 requests.push({method:req.method,path:p,model:body.model,keyProvided:!!body.apiKey});
 if(p==='/api/pair')return send(200,{token:'local-synthetic-review'});
 if(p==='/api/settings'){if(req.method==='PUT'){settings.model=body.model;for(const ws of sockets.clients)ws.send(JSON.stringify({t:'settings',...settings}));}return send(200,settings);}
 if(p==='/api/connectors')return send(200,fixture.connectors);
 if(p.startsWith('/files/')) {
  const shape=fixture.images?.[decodeURIComponent(p.slice(7))];
  if(shape) {
   const {width:w,height:h}=shape;
   const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><path fill="#497aa7" d="M0 0h${w}v${h/3}H0z"/><path fill="#78a58c" d="M0 ${h/3}h${w}v${h/3}H0z"/><path fill="#cf915c" d="M0 ${h*2/3}h${w}v${h/3}H0z"/></svg>`;
   const image=await sharp(Buffer.from(svg)).png().toBuffer();res.writeHead(200,{'content-type':'image/png'});return res.end(image);
  }
 }
 if(p==='/api/feed')return send(200,fixture.feed || {days:[],items:[],next:null,errors:[]});
 if(p==='/api/feed/item')return send(200,fixture.feed?.items.find(p=>p.path===url.searchParams.get('path')) || {});
 const icon=p.match(/^\/api\/connectors\/(tavily|wind|amap)\/icon$/);if(icon){const files=fs.readdirSync(path.join(root,'cloud/connectors',icon[1]));const file=files.find(f=>/\.(png|svg|webp|ico)$/.test(f));if(file){res.writeHead(200,{'content-type':file.endsWith('svg')?'image/svg+xml':'image/png'});return res.end(fs.readFileSync(path.join(root,'cloud/connectors',icon[1],file)));}}
 if(p==='/api/state')return send(200,{version:'1.6.0',kernel:'openclaw',busy:false,avatar:{state:'idle'},activities:[],devices:[]});
 if(p==='/api/profile')return send(200,{name:'豆豆',userName:'演示用户'});
 if(p==='/api/history')return send(200,{items:fixture.history || []});
 if(p==='/api/activities')return send(200,{running:[],recent:[]});
 if(p==='/__review/device-battery'&&req.method==='POST'){
  if(deviceSocket?.readyState!==1)return send(503,{error:'No synthetic device connected'});
  const id=crypto.randomUUID();let timer;
  const result=await new Promise(resolve=>{batteryCalls.set(id,resolve);timer=setTimeout(()=>resolve({ok:false}),5000);deviceSocket.send(JSON.stringify({t:'call',id,capability:'battery',args:{}}));});
  clearTimeout(timer);batteryCalls.delete(id);return send(200,result);
 }
 if(p==='/api/providers' && req.method==='POST'){
  const provider={id:crypto.randomUUID(),name:body.name,protocol:body.protocol,builtin:false,baseUrl:body.baseUrl,models:body.models,keyHint:'demo',usage:{status:'unsupported',message:'尚未接入余额查询',items:[]}};
  settings.providers.push(provider);settings.model={provider:provider.id,id:provider.models[0].id};return send(200,{provider});
 }
 if(p.startsWith('/api/providers/')){
  const id=p.split('/').at(-1),old=settings.providers.find(p=>p.id===id);
  if(!old)return send(404,{error:'没有这个服务'});
  if(req.method==='DELETE'){if(id===settings.model.provider){const next=settings.providers.find(p=>p.id!==id);if(!next)return send(409,{error:'至少保留一个已配置的模型服务'});settings.model={provider:next.id,id:next.models[0].id};}settings.providers=settings.providers.filter(p=>p.id!==id);return send(200,{ok:true});}
  if(req.method==='PATCH'){Object.assign(old,{name:body.name,models:body.models,baseUrl:body.baseUrl,protocol:body.protocol});return send(200,{provider:old});}
 }
 if(p==='/__review/state')return send(200,{requests,socketStats,model:settings.model,providers:settings.providers.map(p=>({id:p.id,name:p.name}))});
 return send(200,{items:[],jobs:[],groups:[]});
});
const sockets=new WebSocketServer({server});
sockets.on('connection',(ws,req)=>{
 socketStats.connections++;
 ws.on('pong',()=>socketStats.pongs++);ws.on('ping',()=>socketStats.clientPings++);
 if(new URL(req.url,'http://127.0.0.1').searchParams.get('role')!=='device')ws.send(JSON.stringify({t:'hello',version:'1.6.0',protocol:'2',busy:false,avatar:{state:'idle'},activities:[],devices:[],history:fixture.history || []}));
 ws.on('message',raw=>{try{const m=JSON.parse(raw);if(m.t==='register'){deviceSocket=ws;socketStats.registrations++;ws.send(JSON.stringify({t:'registered',id:m.device.id}));}if(m.t==='result'&&batteryCalls.has(m.id))batteryCalls.get(m.id)({ok:m.ok,data:m.data});}catch{}});
 const beat=setInterval(()=>{if(ws.readyState===1){socketStats.serverPings++;ws.ping();}},Number(process.env.DOUDOU_REVIEW_HEARTBEAT_MS)||90_000);
 ws.on('close',()=>clearInterval(beat));beat.unref();
});
server.listen(18770,'127.0.0.1',()=>console.log('usage UI fixture ready'));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{for(const ws of sockets.clients)ws.terminate();server.closeAllConnections();server.close(()=>process.exit(0));});
