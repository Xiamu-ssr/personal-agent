// Actual pinned OpenClaw, a local synthetic model, native outbound media and product cards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fakeAnthropic} from '../test/fake-anthropic.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'doudou-native-delivery-'));
Object.assign(process.env,{AGENT_ROOT:root,AGENT_TOKEN:'local-delivery-fixture',AGENT_PORT:'14457',OPENCLAW_PORT:'18797'});
const page='data/library/artifacts/poster.html',png='data/library/media/original.png';
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
let phase=0,exportPath;
const model=await fakeAnthropic(body=>{
 const call=(name,input)=>({stop_reason:'tool_use',content:[{type:'tool_use',id:'delivery-'+phase,name,input}]});
 switch(phase++) {
  case 0:return call('doudou_catalog',{group:'page'});
  case 1:assert.ok(JSON.stringify(body.messages).includes('export_image'));return call('doudou_call',{name:'page.export_image',args_json:JSON.stringify({path:page})});
  case 2:exportPath=JSON.stringify(body.messages).match(/data\/library\/media\/exports\/[a-f0-9]+\.jpg/)?.[0];assert.ok(exportPath,'export must return a durable file');return call('doudou_say',{text:'这是导出的海报',cards:[{type:'image',path:exportPath},{type:'file',path:page}]});
  case 3:return {content:[{type:'text',text:'交付已完成'}]};
  default:return {content:[{type:'text',text:'这是原生图片附件\nMEDIA:'+path.join(root,png)}]};
 }
});
process.env.MODEL_BASE_URL=model.url;process.env.MODEL_API_KEY='local-delivery-only-key';
const [{initialize},{Harness},{DeviceHub},{ConnectorManager},{startServer},{config}]=await Promise.all([
 import('../src/initialize.mjs'),import('../src/agent.mjs'),import('../src/devices.mjs'),import('../src/connectors.mjs'),import('../src/server.mjs'),import('../src/config.mjs')]);
initialize(root);fs.mkdirSync(path.dirname(path.join(root,png)),{recursive:true});fs.writeFileSync(path.join(root,png),bytes);
fs.writeFileSync(path.join(root,page),'<!doctype html><meta name="viewport" content="width=device-width"><body style="background:#4b7a91;color:white"><h1>合成海报</h1>');
const listeners=new Set(),bus={on:f=>listeners.add(f),emit:e=>listeners.forEach(f=>f(e))},hub=new DeviceHub(),connectors=new ConnectorManager({root,definitions:[]});
const h=new Harness({hub,bus,connectors,log:(...a)=>process.env.DOUDOU_VERIFY_VERBOSE&&console.log(...a)}),server=startServer({harness:h,hub,bus,connectors,content:h.content,log:()=>{}});
const auth={authorization:'Bearer '+config.token,'x-doudou-protocol':'2'};
try {
 await h.startMain();
 if(process.env.DOUDOU_VERIFY_VERBOSE){const event=h.runtime.chat.event.bind(h.runtime.chat);h.runtime.chat.event=e=>{if(['chat','agent'].includes(e.event))console.log('PROBE',JSON.stringify({event:e.event,runId:e.payload?.runId,state:e.payload?.state,stream:e.payload?.stream,data:e.payload?.data&&{...e.payload.data,delta:undefined,text:undefined},message:e.payload?.message&&{keys:Object.keys(e.payload.message),content:e.payload.message.content?.map(c=>({type:c.type,keys:Object.keys(c),urlLength:c.image_url?.length}))}}));return event(e);};}
 await h.send('请把页面导出为图片并发给我。','fixture');await h.waitForMain();
 let history=h.speech.history(),card=history.find(m=>m.cards?.some(c=>c.path===exportPath));assert.ok(card,'an actual image card must reach chat history');assert.equal(card.cards.find(c=>c.path===page).mime,'text/html; charset=utf-8');
 await h.send('现在用原生 MEDIA 指令给我图片。','fixture');await h.waitForMain();
 history=h.speech.history();const native=history.find(m=>m.media?.length);assert.ok(native?.media[0].path,'native webchat image blocks were dropped');
 const image=await fetch(`http://127.0.0.1:${config.port}/files/`+native.media[0].path,{headers:auth});assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),bytes);
 const file=await fetch(`http://127.0.0.1:${config.port}/files/`+page,{headers:auth});assert.equal(file.status,200);assert.ok((await file.text()).includes('合成海报'));
 assert.ok([...h.history.records.values()].every(t=>t.status==='done'));
 console.log(JSON.stringify({ok:true,kernel:'openclaw',syntheticModel:true,requests:model.requests.length,exportSaved:true,imageCardDelivered:true,htmlCardDelivered:true,nativeMediaDelivered:true,authenticatedDownloads:true,mainSessionPreserved:true}));
}finally {await h.close();server.closeSockets();server.closeAllConnections();await new Promise(r=>server.close(r));await model.close();fs.rmSync(root,{recursive:true,force:true});}
