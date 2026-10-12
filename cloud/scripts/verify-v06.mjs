// Starts an authenticated loopback instance with a temporary data root and fake model factory.
// No model, real device, connector account or production server is contacted.
import fs from "node:fs";
import path from "node:path";
import {once} from "node:events";
import {fileURLToPath} from "node:url";
import {compareCard,stepsCard} from "../test/v06-fixtures.mjs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
const root=fs.mkdtempSync("/tmp/doudou-v06-verification-");
process.env.AGENT_ROOT=root;process.env.AGENT_TOKEN="fake-loopback-v06-verification-token";
const {Harness}=await import("../src/agent.mjs"),{DeviceHub}=await import("../src/devices.mjs"),{startServer}=await import("../src/server.mjs");
const {validateBrief}=await import("../src/briefs.mjs");
const dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../verification/v0.6");fs.mkdirSync(dir,{recursive:true});
const guide=fs.readFileSync(new URL("../../spec/prompts/brief-guide.md",import.meta.url),"utf8"),example=guide.match(/```html\n([\s\S]*?)```/)[1];
const sample=example.replace("农历八月廿二","农历九月初三")+compareCard+stepsCard;
const validation=validateBrief(sample);if(validation.error)throw new Error(validation.error);
const rel="data/briefs/2026-10-12/新组件样例.html";fs.mkdirSync(path.dirname(path.join(root,rel)),{recursive:true});fs.writeFileSync(path.join(root,rel),sample);fs.writeFileSync(path.join(dir,"sample.html"),sample);
const hub=new DeviceHub(),harness=new Harness({hub,bus:{emit(){}},log(){},queryFactory:()=>{throw new Error("本地验证禁止调用模型");}});
const server=startServer({harness,hub,bus:{on(){}},log(){},listen:{host:"127.0.0.1",port:0}});await once(server,"listening");
const client=new Client({name:"local-v06-verification",version:"0.6.0"});const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();const page=harness.pages.mcpServer();
try {
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/briefs/item?path=${encodeURIComponent(rel)}`,{headers:{Authorization:"Bearer "+process.env.AGENT_TOKEN}});
  const item=await response.json();if(response.status!==200||item.cards.length!==3)throw new Error("简报单项接口验证失败");
  await page.instance.connect(serverTransport);await client.connect(clientTransport);
  const files=[];
  for(const skin of ["silver","paper","night"]) {
    const result=await client.callTool({name:"screenshot",arguments:{path:rel,skin}});if(result.isError)throw new Error(result.content[0].text);
    const image=result.content.find((c)=>c.type==="image"),data=Buffer.from(image.data,"base64"),file=path.join(dir,skin+".jpg");fs.writeFileSync(file,data);
    files.push({skin,file:path.basename(file),bytes:data.length,...JSON.parse(result.content.find((c)=>c.type==="text").text)});
  }
  fs.writeFileSync(path.join(dir,"result.json"),JSON.stringify({root,briefItem:true,tool:"mcp__page__screenshot",cards:3,files},null,2)+"\n");
  console.log(JSON.stringify({root,verification:dir,files:files.map(({skin,file,bytes,width,height})=>({skin,file,bytes,width,height}))},null,2));
} finally {
  await client.close();await page.instance.close();server.closeAllConnections();await new Promise((r)=>server.close(r));
}
