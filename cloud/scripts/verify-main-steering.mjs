import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fakeAnthropic} from '../test/fake-anthropic.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'doudou-main-steering-'));
Object.assign(process.env,{AGENT_ROOT:root,AGENT_TOKEN:'local-steering-test',AGENT_PORT:'14442',OPENCLAW_PORT:'18792'});
let releaseTool,toolStarted;
const entered=new Promise(r=>toolStarted=r),gate=new Promise(r=>releaseTool=r);
const fake=await fakeAnthropic((body,index)=>{
 if(index===0)return {stop_reason:'tool_use',content:[{type:'tool_use',id:'synthetic_wait',name:'doudou_call',input:{name:'probe.wait',args_json:'{}'}}]};
 assert.ok(JSON.stringify(body.messages).includes('STEER_ORIGINAL_INPUT'),'main conversation was replaced');
 return {content:[{type:'text',text:'SYNTHETIC_ORIGINAL_ANSWER; SYNTHETIC_PROGRESS_ANSWER; SYNTHETIC_CORRECTION_ACK'}]};
});
Object.assign(process.env,{MODEL_BASE_URL:fake.url,MODEL_API_KEY:'local-fixture-model-key'});
const [{initialize},{Harness},{DeviceHub},{ConnectorManager},{startServer},{defineTool}]=await Promise.all([
 import('../src/initialize.mjs'),import('../src/agent.mjs'),import('../src/devices.mjs'),import('../src/connectors.mjs'),import('../src/server.mjs'),import('../src/product-tools.mjs')]);
initialize(root);const events=[],bus={emit:e=>events.push(e),on(){}};
const connectors=new ConnectorManager({root,definitions:[]}),h=new Harness({hub:new DeviceHub(),bus,connectors});
const groups=h.groups.bind(h);
h.groups=()=>({...groups(),probe:[defineTool('wait','Synthetic slow tool',{},async()=>{
 toolStarted();await gate;return {content:[{type:'text',text:'Synthetic tool finished'}]};
})]});
const server=startServer({harness:h,hub:h.hub,bus,connectors,log(){}});
const until=async predicate=>{for(let i=0;i<250;i++){if(predicate())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Native steering fixture timed out');};
try{
 await h.startMain();const accepted=new Set(),respond=h.runtime.respond.bind(h.runtime);
 h.runtime.respond=(input,options)=>respond(input,{...options,onAccepted:ack=>{accepted.add(options.id);options.onAccepted?.(ack);}});
 const original=await h.send('STEER_ORIGINAL_INPUT investigate a synthetic topic');
 await Promise.race([entered,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Tool did not start')),25000);timer.unref();})]);
 const second=await h.send('STEER_PROGRESS_INPUT reply with progress first');
 const third=await h.send('STEER_EXTRA_INPUT include this correction');
 await until(()=>accepted.has(second)&&accepted.has(third));
 assert.equal(fake.requests.length,1,'steering must be accepted while the first tool is still running');
 assert.equal(h.running.size,1);assert.ok([second,third].every(id=>h.speech.history().find(m=>m.id===id).activityId===original));
 assert.equal(h.taskHistory(original).items.filter(i=>i.kind==='prompt').length,3);
 releaseTool();await h.waitForMain();
 assert.ok(fake.requests.slice(1).some(r=>JSON.stringify(r.messages).includes('STEER_PROGRESS_INPUT')));
 assert.ok(fake.requests.slice(1).some(r=>JSON.stringify(r.messages).includes('STEER_EXTRA_INPUT')));
 const answers=h.speech.history().filter(m=>m.role==='assistant');assert.equal(answers.length,1);
 for(const expected of ['SYNTHETIC_ORIGINAL_ANSWER','SYNTHETIC_PROGRESS_ANSWER','SYNTHETIC_CORRECTION_ACK'])assert.ok(answers[0].text.includes(expected),'a generated answer never reached visible chat');
 await h.send('STEER_IDLE_INPUT continue the same conversation');await h.waitForMain();
 assert.equal(h.busy,false);assert.equal(h.running.size,0);
 assert.ok(events.some(e=>e.t==='activity_step'&&e.item.messageId===second));
 console.log(JSON.stringify({ok:true,kernel:'openclaw',version:JSON.parse(fs.readFileSync(new URL('../node_modules/openclaw/package.json',import.meta.url),'utf8')).version,busyInputsAcceptedDuringTool:true,nextModelSeesBothInputs:true,allAnswersVisible:true,sameMainSession:true,oneRunningActivity:true,promptsVisibleInActivity:true,idleContinuation:true,modelRequests:fake.requests.length}));
}finally{
 releaseTool();await h.close();server.closeSockets();server.closeAllConnections();await new Promise(r=>server.close(r));await fake.close();fs.rmSync(root,{recursive:true,force:true});
}
