import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fakeAnthropic } from '../test/fake-anthropic.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'doudou-v1-native-'));
process.env.AGENT_ROOT=root;process.env.AGENT_TOKEN='local-native-test';process.env.AGENT_PORT='14441';process.env.OPENCLAW_PORT='18791';
const fake=await fakeAnthropic((body,index)=>{
 const names=body.tools?.map(t=>t.name)||[];
 assert.ok(names.includes('doudou_call') && !names.includes('tool_call'),'Doudou tools must expose one invocation layer');
 if(index===0)return {stop_reason:'tool_use',content:[{type:'tool_use',id:'tool_native_1',name:'doudou_call',input:{name:'goals.put',args:{name:'原生工具验证',title:'原生工具验证',status:'进行中',progress:10,body:'由真实 OpenClaw 工具循环写入'}}}]};
 if(index===4)return new Promise(resolve=>setTimeout(()=>resolve({content:[{type:'text',text:'延时运行'}]}),8000));
 if(index===1){assert.ok(JSON.stringify(body.messages).includes('tool_result'));return {content:[{type:'text',text:'原生执行完成，暗号青竹'}]};}
 assert.ok(JSON.stringify(body.messages).includes('暗号青竹'),'main session continuity lost');
 return {content:[{type:'text',text:'同一个主会话继续：青竹'}]};
});
process.env.MODEL_BASE_URL=fake.url;process.env.MODEL_API_KEY='local-fixture-model-key';
const [{initialize},{Harness},{DeviceHub},{ConnectorManager},{startServer},{Content},{Schedules}]=await Promise.all([
 import('../src/initialize.mjs'),import('../src/agent.mjs'),import('../src/devices.mjs'),import('../src/connectors.mjs'),import('../src/server.mjs'),import('../src/content.mjs'),import('../src/scheduler.mjs')]);
initialize(root);fs.writeFileSync(root+'/MEMORY.md','# Memory\n\nDoudou native recall marker emeraldorchidprobe.\n');const log=(...s)=>console.log(...s);const bus={emit(){},on(){}};
const hub=new DeviceHub(),connectors=new ConnectorManager({root,definitions:[]}),h=new Harness({hub,bus,connectors,log});
const content=new Content({root}),schedules=new Schedules({harness:h,content,log});
const server=startServer({harness:h,hub,bus,connectors,content,schedules,log});
try{
 await h.startMain();
 const recall=await fetch(h.runtime.url+'/tools/invoke',{method:'POST',headers:{authorization:`Bearer ${h.runtime.token}`,'content-type':'application/json'},body:JSON.stringify({tool:'memory_search',args:{query:'emeraldorchidprobe',maxResults:3},sessionKey:'agent:main:main'})});
 assert.equal(recall.status,200);const recallResult=await recall.json();assert.equal(recallResult.ok,true);const recalled=JSON.parse(recallResult.result.content.find(c=>c.type==='text').text);assert.ok(recalled.results.some(r=>r.path==='MEMORY.md'),'native memory did not index and recall the fixture');
 const first=await h.runMain('请建立原生工具验证目标，暗号青竹');assert.equal(first.ok,true,first.error);
 assert.equal(content.goal('原生工具验证').progress,10);
 const next=await h.runMain('继续上一次，暗号是什么？');assert.equal(next.ok,true,next.error);
 assert.equal(fake.requests.length,3);assert.ok(h.speech.history().some(m=>m.text.includes('青竹')));
 await h.runtime.close();h.runtime.closed=false;await h.runtime.start();
 const restart=await h.runMain('重启后继续');assert.equal(restart.ok,true,restart.error);
 assert.equal(fake.requests.length,4);
 for(let i=0;i<40&&!h.runtime.rpcReady;i++)await new Promise(r=>setTimeout(r,100));
 assert.equal(h.runtime.rpcReady,true,'native stop RPC not connected');
 const stopped=h.runMain('停止验证，请等待',{id:'stop-probe'});
 for(let i=0;i<80&&fake.requests.length<5;i++)await new Promise(r=>setTimeout(r,100));
 assert.equal(fake.requests.length,5);await h.stopTask('stop-probe');
 assert.equal((await stopped).ok,false);assert.equal(h.history.get('stop-probe').status,'stopped');assert.equal(h.busy,false);
 console.log(JSON.stringify({ok:true,kernel:'openclaw',version:'2026.10.4',nativeMemoryRecall:true,nativeToolRoundTrip:true,sameMainSession:true,restartContinuation:true,nativeStop:true,root,modelRequests:fake.requests.length}));
}finally{await h.close();server.closeSockets();server.closeAllConnections();await new Promise(r=>server.close(r));await fake.close();}
