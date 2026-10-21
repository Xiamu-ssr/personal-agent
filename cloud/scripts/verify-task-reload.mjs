import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fakeAnthropic} from '../test/fake-anthropic.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'doudou-task-reload-'));
Object.assign(process.env,{AGENT_ROOT:root,AGENT_TOKEN:'local-reload-test',AGENT_PORT:'14446',OPENCLAW_PORT:'18795'});
let entered,release;
const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
const fake=await fakeAnthropic(async(body,index)=>{
 if(index===0){entered();await gate;return {stop_reason:'tool_use',content:[{type:'tool_use',id:'after_reload',name:'doudou_call',input:{name:'probe.finish',args_json:'{}'}}]};}
 return {content:[{type:'text',text:'Synthetic content update completed'}]};
});
Object.assign(process.env,{MODEL_BASE_URL:fake.url,MODEL_API_KEY:'local-fixture-model-key'});
const [{initialize},{Harness},{DeviceHub},{ConnectorManager},{startServer},{defineTool},{getAppSettings,putAppSettings}]=await Promise.all([
 import('../src/initialize.mjs'),import('../src/agent.mjs'),import('../src/devices.mjs'),import('../src/connectors.mjs'),import('../src/server.mjs'),import('../src/product-tools.mjs'),import('../src/app-settings.mjs')]);
initialize(root);const logs=[],bus={emit(){},on(){}};
const connectors=new ConnectorManager({root,definitions:[]}),h=new Harness({hub:new DeviceHub(),bus,connectors,log:(...args)=>logs.push(args.join(' '))});
let calls=0;const groups=h.groups.bind(h);
h.groups=()=>({...groups(),probe:[defineTool('finish','Synthetic content publication',{},async()=>{calls++;return {content:[{type:'text',text:'Synthetic publication stored'}]};})]});
const server=startServer({harness:h,hub:h.hub,bus,connectors,log(){}});
const until=async fn=>{for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Native reload fixture timed out');};
try{
 await h.startMain();
 const task=h.runIsolated('Synthetic feed','RELOAD_BACKGROUND preserve this content update while the model selection changes');
 await started;
 const settings=getAppSettings(root),provider=settings.providers.find(p=>p.id===settings.model.provider);
 const alternative=provider.models.find(m=>m.id!==settings.model.id);assert.ok(alternative);
 putAppSettings(root,{model:{provider:provider.id,id:alternative.id}});await h.settingsChanged();
 await until(()=>logs.some(line=>line.includes('config hot reload applied')));
 release();const result=await task;
 assert.equal(result.ok,true,result.error);assert.equal(calls,1);
 assert.ok(h.history.recent().some(r=>r.summary==='Synthetic content update completed'));
 await h.send('RELOAD_MAIN continue the same main conversation');await h.waitForMain();
 assert.equal(h.busy,false);assert.equal(h.running.size,0);
 console.log(JSON.stringify({ok:true,kernel:'openclaw',modelChangedDuringTask:true,backgroundCompleted:true,toolCallsAfterReload:calls,resultReturnedToMain:true,modelRequests:fake.requests.length}));
}finally{
 release();await h.close();server.closeSockets();server.closeAllConnections();await new Promise(r=>server.close(r));await fake.close();fs.rmSync(root,{recursive:true,force:true});
}
