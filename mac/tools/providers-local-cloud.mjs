// Real cloud HTTP/WS + Harness/Agent SDK. All model traffic goes to these local fake APIs.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = '/tmp/v081-mac-shots'; fs.mkdirSync(output,{recursive:true});
const root = fs.mkdtempSync('/tmp/doudou-providers-cloud-');
// Drop inherited credential/proxy/config variables by name without inspecting their values.
for (const name of Object.keys(process.env)) if (!['PATH','HOME','TMPDIR','LANG','LC_ALL','SHELL','TERM'].includes(name)) delete process.env[name];
Object.assign(process.env,{AGENT_ROOT:root,AGENT_TOKEN:'local-fixture',AGENT_HOST:'127.0.0.1',AGENT_PORT:'0',AGENT_TZ:'Asia/Shanghai',AGENT_ACTIVITY_SUMMARIES:'0',AGENT_BROWSER_SERVICE:''});
const { fakeAnthropic } = await import(path.join(repo,'cloud/test/fake-anthropic.mjs'));
const { toolReply, textReply } = await import(path.join(repo,'cloud/test/native-fixture.mjs'));
const respond = label => body => {
  if (body.model === 'rejected-model') return {error:'演示服务拒绝模型，请检查 ID。',status:400};
  if (!body.stream) return textReply('OK');
  const last = body.messages.findLast(m=>m.role==='user')?.content;
  if (Array.isArray(last) && last.some(part=>part.type==='tool_result')) return textReply(' ');
  return toolReply('provider_say_' + body.messages.length, 'mcp__doudou__say', {text:label + '假模型已收到你的消息。'});
};
const builtin = await fakeAnthropic(respond('内置')), custom = await fakeAnthropic(respond('自定义'));
Object.assign(process.env,{ANTHROPIC_BASE_URL:builtin.url,ANTHROPIC_API_KEY:'fake-local-only',ANTHROPIC_AUTH_TOKEN:'',CLAUDE_CONFIG_DIR:path.join(root,'cli-config'),CLAUDE_CODE_TMPDIR:path.join(root,'cli-tmp'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'});
const [{query},{Harness},{DeviceHub},{Content},{startServer},{Schedules},{migrateV08}] = await Promise.all([
  import(path.join(repo,'cloud/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')),
  import(path.join(repo,'cloud/src/agent.mjs')),import(path.join(repo,'cloud/src/devices.mjs')),
  import(path.join(repo,'cloud/src/content.mjs')),import(path.join(repo,'cloud/src/server.mjs')),
  import(path.join(repo,'cloud/src/scheduler.mjs')),import(path.join(repo,'cloud/src/migrate-v08.mjs')),
]);
migrateV08({root,seedDir:path.join(repo,'cloud/seed')});
fs.mkdirSync(path.join(root,'system'),{recursive:true});
fs.writeFileSync(path.join(root,'system/chat.jsonl'),JSON.stringify({id:'provider-seed',role:'assistant',source:'say',text:'这是隔离的模型服务验收。',ts:Date.now()})+'\n');
const listeners = new Set(), events = [];
const bus = {on:fn=>listeners.add(fn),emit:event=>{events.push({t:event.t,phase:event.phase,model:event.model}); for (const fn of listeners) fn(event);}};
const hub = new DeviceHub();
const harness = new Harness({hub,bus,log(){},queryFactory:({prompt,options})=>query({prompt,options:{...options,settingSources:[],agentProgressSummaries:false,env:{...options.env,CLAUDE_CONFIG_DIR:path.join(root,'cli-config'),CLAUDE_CODE_TMPDIR:path.join(root,'cli-tmp'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'}}})});
const content = new Content({root,bus}), schedules = new Schedules({harness,content});
harness.startMain();
const server = startServer({harness,hub,bus,content,schedules,log(){},listen:{host:'127.0.0.1',port:0}}); await once(server,'listening');
const evidence = () => ({builtinRequests:builtin.requests.map(r=>({model:r.model,stream:!!r.stream})),customRequests:custom.requests.map(r=>({model:r.model,stream:!!r.stream})),settingsEvents:events.filter(e=>e.t==='settings'),allModelsLocal:true,root});
const control = http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(evidence()));}); control.listen(0,'127.0.0.1');await once(control,'listening');
fs.writeFileSync(path.join(output,'providers-local-cloud.json'),JSON.stringify({root,server:`http://127.0.0.1:${server.address().port}`,upstream:custom.url,control:`http://127.0.0.1:${control.address().port}`,pid:process.pid}));
console.log('PROVIDERS_LOCAL_READY');
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await harness.close(); await server.browserRoutes?.close();
  for (const client of server.ws?.clients || []) client.terminate();
  server.closeAllConnections(); server.close(); control.closeAllConnections(); control.close();
  await builtin.close(); await custom.close();
  fs.writeFileSync(path.join(output,'providers-local-evidence.json'),JSON.stringify(evidence(),null,2));process.exit(0);
}
process.on('SIGTERM',close); process.on('SIGINT',close);
