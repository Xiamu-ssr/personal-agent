// Isolated real HTTP/WS app checks. The model deliberately takes 20 seconds
// to acknowledge and 60 seconds to finish; no user data or external API calls.
import fs from 'node:fs';
import path from 'node:path';
const root=fs.mkdtempSync('/tmp/doudou-chat-lifecycle-');
process.env.AGENT_ROOT=root;process.env.AGENT_HOST='127.0.0.1';process.env.AGENT_PORT='18771';process.env.AGENT_TOKEN='local-fixture';process.env.AGENT_ACTIVITY_SUMMARIES='0';
const [{Harness},{DeviceHub},{ConnectorManager},{initialize},{startServer}]=await Promise.all([
 import('../../cloud/src/agent.mjs'),import('../../cloud/src/devices.mjs'),import('../../cloud/src/connectors.mjs'),import('../../cloud/src/initialize.mjs'),import('../../cloud/src/server.mjs')]);
initialize(root);
fs.writeFileSync(path.join(root,'system/chat.jsonl'),Array.from({length:1000},(_,i)=>JSON.stringify({id:'history-'+i,role:i%2?'assistant':'user',text:'Synthetic history '+i,ts:1_790_000_000_000+i})+'\n').join(''));
const pending=new Set(),listeners=new Set(),bus={on:fn=>listeners.add(fn),emit:e=>{for(const fn of listeners)fn(e);}},hub=new DeviceHub(),connectors=new ConnectorManager({root,definitions:[]});
const runtime={ready:true,start:async()=>{},respond:(text,options)=>new Promise(resolve=>{
 const accepted=setTimeout(()=>options.onAccepted?.({}),20_000),finished=setTimeout(()=>{pending.delete(stop);resolve({text:'Synthetic delayed answer'});},60_000);
 const stop=()=>{clearTimeout(accepted);clearTimeout(finished);resolve({text:''});};pending.add(stop);
}),close:async()=>{for(const stop of pending)stop();pending.clear();}};
const harness=new Harness({hub,connectors,bus,runtime}),server=startServer({harness,hub,connectors,bus,log(){}});
server.on('listening',()=>console.log('Isolated chat review ready on loopback 18771'));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await harness.close();server.closeSockets();server.closeAllConnections();server.close(()=>{fs.rmSync(root,{recursive:true,force:true});process.exit(0);});});
