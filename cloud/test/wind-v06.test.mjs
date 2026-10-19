import {testRoot} from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import {once} from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import {z} from "zod";
import {c as tar} from "tar";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {createWindConnector,WIND_SERVERS} from "../connectors/wind/index.mjs";
import {WindSkills,CORE_SKILLS,rewriteSkillMarkdown} from "../connectors/wind/skills.mjs";
import {ConnectorManager,SECRET_MASK} from "../src/connectors.mjs";
import {callTool,toolResult} from "./tool-call.mjs";

const FAKE_KEY="fake-wind-local-api-key";
async function archive(root) {
  const source=path.join(root,"archive-source");
  for(const name of [...CORE_SKILLS,"valuation-demo"]) {
    const dir=path.join(source,"repo-main/skills",name);fs.mkdirSync(path.join(dir,"scripts"),{recursive:true});
    fs.writeFileSync(path.join(dir,"SKILL.md"),`---\nname: ${name}\ndescription: >-\n  ${name} 的一句话描述。更多说明。\n---\n\n# 保留金融规则\n只按返回数据判断。\n\n## 一次性配置\n读取 ~/.wind-aifinmarket/config 或 WIND_API_KEY。\n\n## 取数\n\n\`\`\`bash\nnode scripts/cli.mjs call stock_data quote '{"symbol":"600519.SH"}'\n\`\`\`\n\n## 路由规则\n工作流规则保留，用 references/skills-catalog.md 查目录。\n`);
    fs.writeFileSync(path.join(dir,"scripts/cli.mjs"),"const key=process.env.WIND_API_KEY;\n");
    fs.writeFileSync(path.join(dir,"scripts/update-check.mjs"),"// update installer\n");
    fs.mkdirSync(path.join(dir,"references"));fs.writeFileSync(path.join(dir,"references/stock.md"),"# 股票参数\nsymbol 是证券代码。\n");
  }
  fs.symlinkSync("/tmp/should-not-install",path.join(source,"repo-main/skills/wind-mcp-skill/escape"));
  const file=path.join(root,"fixture.tgz");await tar({gzip:true,file,cwd:source},["repo-main"]);return fs.readFileSync(file);
}
async function mock(t,root) {
  const data=await archive(root),requests=[];
  const server=http.createServer(async(req,res)=> {
    if(req.url==="/archive"){res.writeHead(200,{"Content-Type":"application/gzip"});return res.end(data);}
    if(req.headers.authorization!=="Bearer "+FAKE_KEY){res.writeHead(401,{"Content-Type":"application/json"});return res.end(JSON.stringify({error:"invalid api key"}));}
    if(req.method!=="POST"){res.writeHead(405);return res.end();}
    let raw="";for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push({route:req.url,body});
    if(req.url==="/skills/alice") {
      res.writeHead(200,{"Content-Type":"text/event-stream"});
      const event={jsonrpc:"2.0",id:body.id,result:{kind:"artifact-update",artifact:{name:"agentResult",parts:[{kind:"data",data:{data:"Alice 本地模拟分析正文"}}]}}};
      res.write("data: "+JSON.stringify(event)+"\n\n");return res.end();
    }
    const mcp=new McpServer({name:"wind-mock",version:"1.0.0"});
    mcp.registerTool("quote",{description:"查询证券价格（本地假数据）",inputSchema:{symbol:z.string()}},async({symbol})=>({content:[{type:"text",text:JSON.stringify({symbol,price:100,key:FAKE_KEY})}]}));
    mcp.registerTool("large",{description:"测试截断",inputSchema:{}},async()=>({content:[{type:"text",text:"文".repeat(100_000)}]}));
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});await mcp.connect(transport);
    res.on("close",()=>{mcp.close().catch(()=>{});});await transport.handleRequest(req,res,body);
  });server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(async()=>{server.closeAllConnections();await new Promise((r)=>server.close(r));});
  const url="http://127.0.0.1:"+server.address().port;return {url,requests};
}

test("Wind mock initializes/lists/tests seven services, forwards calls privately, truncates and handles Alice SSE with the same Key",async(t)=> {
  const root=fs.mkdtempSync(path.join(testRoot,"wind-mock-")),api=await mock(t,root),connector=createWindConnector({baseUrl:api.url,archiveUrl:api.url+"/archive"});
  const manager=new ConnectorManager({root,definitions:[connector]});
  await assert.rejects(manager.addAccount("wind",{apiKey:"invalid-local-key"}),/API Key 不对或已失效/);
  assert.equal(manager.accounts.get("wind").length,0);
  const added=await manager.addAccount("wind",{apiKey:FAKE_KEY});assert.equal(added.status,"ok");assert.equal(manager.list().installed[0].accounts[0].values.apiKey,SECRET_MASK);
  await assert.rejects(manager.addAccount("wind",{apiKey:FAKE_KEY}),/已经添加过/);
  const tools=connector.tools(manager.accounts.get("wind"),manager.context("wind",manager.accounts.get("wind")));
  assert.deepEqual(tools.map((t)=>t.name),["call","list_tools","list_skills","install_skill","ask_alice"]);
  for(const server of WIND_SERVERS) {
    const listing=await callTool(tools,"list_tools",{server});assert.equal(listing.tools[0].name,"quote");assert.equal(listing.tools[0].inputSchema.properties.symbol.type,"string");
    const data=await callTool(tools,"call",{server,tool:"quote",args:{symbol:"600519.SH"}});assert.match(data.content[0].text,/600519.SH/);assert.ok(!JSON.stringify(data).includes(FAKE_KEY));
  }
  assert.ok(api.requests.some((r)=>r.body.method==="initialize"));assert.ok(api.requests.some((r)=>r.body.method==="tools/list"));
  const large=await callTool(tools,"call",{server:"stock_data",tool:"large",args:{}});assert.equal(large.truncated,true);assert.match(large.notice,/截断/);
  const alice=await callTool(tools,"ask_alice",{question:"原问题：核验这份报告"});assert.equal(alice.text,"Alice 本地模拟分析正文");const request=api.requests.find((r)=>r.route==="/skills/alice");assert.equal(request.body.method,"message/stream");assert.equal(request.body.params.message.parts[0].text,"原问题：核验这份报告");assert.equal(request.body.params.message.parts[1].data.chatMode,"12");
  const cache=await callTool(tools,"list_skills");assert.equal(cache.skills.length,4);assert.ok(cache.skills.every((s)=>s.description.includes("一句话描述")));
  const installed=await callTool(tools,"install_skill",{name:"valuation-demo"});assert.equal(installed.path,"skills/wind-valuation-demo/SKILL.md");
  assert.equal((await toolResult(tools,"install_skill",{name:"../escape"})).isError,true);
  await manager.removeAccount("wind",added.id);assert.equal(fs.existsSync(path.join(root,installed.path)),false);assert.equal((await toolResult(tools,"call",{server:"stock_data",tool:"quote",args:{symbol:"1"}})).isError,true);
});

test("Wind install rewrites credential/CLI/discovery instructions, keeps domain references, marks ownership, protects own skills and checks version on startup",async(t)=> {
  const root=fs.mkdtempSync(path.join(testRoot,"wind-install-")),api=await mock(t,root),ctx={root,version:"0.6.0"},cache=new WindSkills({ctx,archiveUrl:api.url+"/archive"});
  const own=path.join(root,"skills/wind-own/SKILL.md");fs.mkdirSync(path.dirname(own),{recursive:true});fs.writeFileSync(own,"豆豆自己写的技能");
  await cache.install();
  for(const name of CORE_SKILLS) {
    const dir=path.join(root,"skills",name),text=fs.readFileSync(path.join(dir,"SKILL.md"),"utf8");
    assert.match(text,/wind.call/);assert.doesNotMatch(text,/WIND_API_KEY|\.wind-aifinmarket|一次性配置/);assert.equal(fs.existsSync(path.join(dir,"scripts/cli.mjs")),false);assert.equal(fs.existsSync(path.join(dir,"scripts/update-check.mjs")),false);assert.equal(fs.existsSync(path.join(dir,"escape")),false);assert.equal(fs.existsSync(path.join(dir,".connector-managed.json")),true);
    assert.match(fs.readFileSync(path.join(dir,"references/stock.md"),"utf8"),/symbol 是证券代码/);
  }
  const discovery=fs.readFileSync(path.join(root,"skills/wind-find-finance-skill/SKILL.md"),"utf8");assert.match(discovery,/wind.list_skills/);assert.match(discovery,/wind.install_skill/);
  cache.installSkill("valuation-demo");await cache.install();assert.equal(fs.existsSync(path.join(root,"skills/wind-valuation-demo/SKILL.md")),true);
  const connector=createWindConnector({baseUrl:api.url,archiveUrl:api.url+"/archive"}),manager=new ConnectorManager({root,definitions:[connector]});const added=await manager.addAccount("wind",{apiKey:FAKE_KEY});
  const restarted=new ConnectorManager({root,definitions:[connector]});assert.deepEqual(await restarted.initialize(),[]);await restarted.removeAccount("wind",added.id);assert.equal(fs.readFileSync(own,"utf8"),"豆豆自己写的技能");
  const conflict=path.join(root,"skills/wind-valuation-demo/SKILL.md");fs.mkdirSync(path.dirname(conflict),{recursive:true});fs.writeFileSync(conflict,"自己写的同名技能");assert.throws(()=>cache.installSkill("valuation-demo"),/未覆盖/);cache.uninstall();assert.equal(fs.readFileSync(conflict,"utf8"),"自己写的同名技能");
  const rewritten=rewriteSkillMarkdown("---\nname: wind-demo\ndescription: demo\n---\n\n## 一次性配置\n读取 WIND_API_KEY\n\n## 业务规则\n只用可验证数据。",{name:"wind-demo"});assert.match(rewritten,/name: wind-demo/);assert.match(rewritten,/只用可验证数据/);assert.doesNotMatch(rewritten,/WIND_API_KEY/);
});
