import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {fakeAnthropic} from '../test/fake-anthropic.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'doudou-reconnect-'));
Object.assign(process.env,{AGENT_ROOT:root,AGENT_TOKEN:'reconnect-local-fixture',AGENT_PORT:'14459',OPENCLAW_PORT:'18799'});
let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
const fake=await fakeAnthropic(async()=>{entered();await gate;return {content:[{type:'text',text:'Exactly once completion after reconnect'}]};});
Object.assign(process.env,{MODEL_BASE_URL:fake.url,MODEL_API_KEY:'reconnect-local-model'});
const [{initialize},{Harness},{DeviceHub},{ConnectorManager}]=await Promise.all([import('../src/initialize.mjs'),import('../src/agent.mjs'),import('../src/devices.mjs'),import('../src/connectors.mjs')]);
initialize(root);const h=new Harness({hub:new DeviceHub(),bus:{emit(){}},connectors:new ConnectorManager({root,definitions:[]}),log:()=>{}});
try {
 await h.startMain();const id=await h.send('Synthetic reconnect request');await started;
 let reconciliations=0;const request=h.runtime.client.request.bind(h.runtime.client);h.runtime.client.request=(method,...args)=>{if(method==='agent.wait')reconciliations++;return request(method,...args)};
 h.runtime.client.protocol.closeSocket(1012,'synthetic transport interruption');
 for(let i=0;i<100&&h.runtime.rpcReady;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(h.history.get(id).status,'running');release();
 await Promise.race([h.waitForMain(),new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('Reconnect did not reconcile the native run')),30000);t.unref();})]);
 assert.equal(h.history.get(id).status,'done');assert.ok(h.speech.history().some(r=>r.text==='Exactly once completion after reconnect'));assert.equal(fake.requests.length,1);assert.ok(reconciliations>0);
 const system=JSON.stringify(fake.requests[0].system);assert.ok(system.includes('AGENTS.md'));assert.ok(system.includes('data/library/sites'));assert.equal(fake.requests[0].max_tokens,128000);
 console.log(JSON.stringify({ok:true,kernel:'openclaw',version:JSON.parse(fs.readFileSync(new URL('../node_modules/openclaw/package.json',import.meta.url),'utf8')).version,disconnectedDuringInference:true,recoveredByNativeRunId:true,modelRequests:fake.requests.length,maxOutputTokens:fake.requests[0].max_tokens,duplicateExecution:false,resultDelivered:true,nativeSystemAndWorkspaceInstructions:true}));
}finally{release();await h.close();await fake.close();fs.rmSync(root,{recursive:true,force:true});}
