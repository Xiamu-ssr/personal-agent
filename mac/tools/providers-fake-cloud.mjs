// UI contract fixture only. No model, user data, environment credentials, or external network.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { WebSocketServer } = await import(path.join(repo, 'cloud/node_modules/ws/wrapper.mjs'));
const output = '/tmp/v081-mac-shots'; fs.mkdirSync(output, { recursive:true });
const builtin = { id:'zenmux', name:'ZenMux', builtin:true, protocol:'anthropic', models:[
  { id:'anthropic/claude-haiku-5.5', name:'Claude Haiku 5.5', note:'消耗约 1×；输入超过 100K 后约 5×' },
  { id:'anthropic/claude-opus-5.5', name:'Claude Opus 5.5', note:'消耗约 40×；缓存读约 20×' },
  { id:'z-ai/glm-5.3-flash', name:'GLM 5.3 Flash', note:'输入约 1.5×，输出约 1×；缓存读约 3×' },
  { id:'z-ai/glm-5.3-flashx', name:'GLM 5.3 FlashX', note:'输入约 3.75×，输出约 2.5×；缓存读约 7.5×' },
] };
let providers = [builtin, { id:'example', name:'示例模型服务', builtin:false, protocol:'anthropic', baseUrl:'https://example.test', keyHint:'abcd', models:[{id:'claude-custom-demo',name:'示例 Claude',note:'适合日常聊天与资料整理'}] }];
let model = {provider:'zenmux',id:builtin.models[0].id};
const events = [], requests = [];
const settings = () => ({model,kernel:'openclaw',providers});
const state = () => ({version:'1.0.0',busy:false,chatEmpty:false,avatar:{state:'idle'},activities:[],devices:[]});
const history = [{id:'hello-demo',role:'assistant',source:'say',text:'你好，模型服务可以在设置里添加。',ts:Date.now()}];
const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://127.0.0.1').pathname;
  const send = (code, body) => { res.writeHead(code, {'content-type':'application/json;charset=utf-8'}); res.end(JSON.stringify(body)); };
  let body = {}; if (['POST','PUT','PATCH'].includes(req.method)) { let raw = ''; for await (const part of req) raw += part; try { body = JSON.parse(raw || '{}'); } catch { return send(400,{error:'JSON 格式错误'}); } }
  // Record only public metadata and whether a key was supplied. Never record the value.
  if (p.startsWith('/api/providers') || (p === '/api/settings' && req.method === 'PUT')) requests.push({method:req.method,path:p,fields:Object.keys(body),keyProvided:Object.hasOwn(body,'apiKey'),model:body.model,name:body.name});
  const changed = () => { const e = {t:'settings',...settings()}; events.push({t:e.t,model}); for (const client of ws.clients) if (client.readyState === 1) client.send(JSON.stringify(e)); };
  if (p === '/api/settings') {
    if (req.method === 'PUT') {
      if (body.model && !providers.some(v => v.id === body.model.provider && v.models.some(m => m.id === body.model.id))) return send(400,{error:'没有这个模型'});
      if (body.model) model = body.model; changed();
    }
    return send(200, settings());
  }
  if (p === '/api/state') return send(200,state());
  if (p === '/api/history') return send(200,{items:history});
  if (p === '/api/activities') return send(200,{running:[],recent:[],next:null});
  if (p === '/api/memory') return send(200,{kernel:'openclaw',soul:{name:'豆豆',path:'SOUL.md'},items:[{name:'关于你',path:'USER.md'},{name:'长期记忆',path:'MEMORY.md'},{name:'今天',path:'memory/2026-10-19.md'}],health:'data/health/days.json'});
  if (p === '/api/memory/item') return send(200,{path:'MEMORY.md',text:'# 长期记忆\n\n演示数据。来源：本地界面验收；2026-10-19。',readOnly:false});
  if(p==='/api/goals')return send(200,{items:[],errors:[]});
  if(p==='/api/ideas')return send(200,{revision:'fixture',groups:[{name:'最近可以试试',items:[{id:'idea',icon:'🌱',title:'用豆豆安排一次短途散步',description:'根据天气与空闲时间选路线。',reply:'帮我安排一次散步'}]}]});
  if (p === '/api/profile') return send(200,{name:'豆豆',userName:'演示用户'});
  if (p === '/api/providers' && req.method === 'POST' || p.startsWith('/api/providers/') && req.method === 'PATCH') {
    const old = req.method === 'PATCH' ? providers.find(v => v.id === decodeURIComponent(p.split('/').pop())) : undefined;
    if (req.method === 'PATCH' && (!old || old.builtin)) return send(404,{error:'没有这个服务'});
    await delay(900);
    if (body.name?.includes('失败') || body.models?.[0]?.id === 'bad-model') return send(400,{error:'HTTP 401：演示服务拒绝了 API Key，请检查后重试。' + (body.apiKey || '')});
    const provider = {...old,id:old?.id || crypto.randomUUID(),builtin:false,protocol:'anthropic',name:body.name || old?.name,baseUrl:body.baseUrl || old?.baseUrl,keyHint:body.apiKey ? body.apiKey.slice(-4) : old?.keyHint,models:body.models || old?.models};
    providers = old ? providers.map(v => v.id === old.id ? provider : v) : [...providers,provider]; changed();
    return send(old ? 200 : 201,{provider});
  }
  if (p.startsWith('/api/providers/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.split('/').pop());
    if (id === model.provider) return send(409,{error:'先换到别的模型'});
    providers = providers.filter(v => v.id !== id); changed(); return send(200,{ok:true});
  }
  if (p === '/__review/state') return send(200,{requests,events,providerCount:providers.length});
  if (p === '/__review/select' && req.method === 'POST') { model = body.model; changed(); return send(200,{ok:true}); }
  send(200,{});
});
const ws = new WebSocketServer({server});
ws.on('connection', client => { client.send(JSON.stringify({t:'hello',...state(),history})); });
server.listen(0,'127.0.0.1'); await once(server,'listening');
fs.writeFileSync(path.join(output,'providers-fake-cloud.json'),JSON.stringify({server:`http://127.0.0.1:${server.address().port}`,pid:process.pid}));
console.log('PROVIDERS_FAKE_READY');
let closing = false;
function close() { if (closing) return; closing = true; for (const c of ws.clients) c.terminate(); ws.close(); server.closeAllConnections(); server.close(() => { fs.writeFileSync(path.join(output,'providers-fake-evidence.json'),JSON.stringify({requests,events},null,2)); process.exit(0); }); }
process.on('SIGTERM',close); process.on('SIGINT',close);
