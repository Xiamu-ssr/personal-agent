// Real OpenClaw + native file/image tools; local synthetic model and uploads only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fakeAnthropic} from '../test/fake-anthropic.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'doudou-upload-policy-'));
process.env.AGENT_ROOT=root;process.env.AGENT_TOKEN='upload-policy-fixture';process.env.AGENT_PORT='14453';process.env.OPENCLAW_PORT='18795';
const imageBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const imagePaths=['data/uploads/fixture/first.png','data/uploads/fixture/second.png'],file='data/uploads/fixture/reference.txt',marker='sapphire-text-marker';
let stage=0,sawImages=false,sawText=false;
function imageCount(value){if(!value||typeof value!=='object')return 0;return (value.type==='image'?1:0)+Object.values(value).reduce((sum,v)=>sum+(Array.isArray(v)?v.reduce((n,x)=>n+imageCount(x),0):imageCount(v)),0);}
const fake=await fakeAnthropic(body=>{
 const names=body.tools.map(t=>t.name);assert.ok(names.includes('view_image')&&names.includes('read'));assert.ok(!names.includes('nodes')&&!names.includes('mobile_ui'));
 if(stage++===0){
  assert.equal(imageCount(body.messages),0,'uploaded images must not enter the initial model request');
  const request=JSON.stringify(body.messages);assert.ok(imagePaths.every(p=>request.includes(p))&&request.includes(file));assert.ok(!request.includes(marker));
  return {stop_reason:'tool_use',content:[{type:'tool_use',id:'view-uploaded-images',name:'view_image',input:{paths:imagePaths}},{type:'tool_use',id:'read-uploaded-file',name:'read',input:{path:file}}]};
 }
 sawImages=imageCount(body.messages)>=2;sawText=JSON.stringify(body.messages).includes(marker);
 assert.ok(sawImages,'native view_image did not supply both images to the vision model');assert.ok(sawText,'native read did not supply the uploaded text');
 return {content:[{type:'text',text:'附件按需读取完成'}]};
});
process.env.MODEL_BASE_URL=fake.url;process.env.MODEL_API_KEY='upload-fixture-only-key';
const [{initialize},{Harness},{DeviceHub},{ConnectorManager},{startServer},{Content},{Schedules}]=await Promise.all([
 import('../src/initialize.mjs'),import('../src/agent.mjs'),import('../src/devices.mjs'),import('../src/connectors.mjs'),import('../src/server.mjs'),import('../src/content.mjs'),import('../src/scheduler.mjs')]);
initialize(root);fs.mkdirSync(path.join(root,'data/uploads/fixture'),{recursive:true});for(const p of imagePaths)fs.writeFileSync(path.join(root,p),imageBytes);fs.writeFileSync(path.join(root,file),marker);
const listeners=new Set(),bus={on:f=>listeners.add(f),emit:e=>listeners.forEach(f=>f(e))},log=(...s)=>console.log(...s);
const hub=new DeviceHub(),connectors=new ConnectorManager({root,definitions:[]}),h=new Harness({hub,bus,connectors,log}),content=new Content({root,bus}),schedules=new Schedules({harness:h,content,log});
const server=startServer({harness:h,hub,bus,connectors,content,schedules,log});
try{
 await h.startMain();const attachments=[...imagePaths.map(p=>({kind:'image',name:path.basename(p),path:p})),{kind:'file',name:'reference.txt',path:file}];
 await h.send('请查看这些附件。','fixture',attachments);await h.mainChain;
 const task=[...h.history.records.values()].at(-1);assert.equal(task.status,'done',task.summary);assert.ok(sawImages&&sawText);
 console.log(JSON.stringify({ok:true,kernel:'openclaw',syntheticModel:true,initialInputReferencesOnly:true,nativeImageRead:true,nativeFileRead:true,images:2,mixedAttachments:true,modelRequests:fake.requests.length,singleDeviceEntry:true}));
}finally{await h.close();server.closeSockets();server.closeAllConnections();await new Promise(r=>server.close(r));await fake.close();}
