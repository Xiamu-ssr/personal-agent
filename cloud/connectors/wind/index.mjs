import crypto from "node:crypto";
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { apiKeyValues, privateResult } from "../_shared/http.mjs";
import { WindSkills } from "./skills.mjs";

export const WIND_SERVERS=["stock_data","fund_data","index_data","bond_data","financial_docs","economic_data","analytics_data"];
const SERVER=z.enum(WIND_SERVERS),MAX_RESULT=60*1024;
const chineseError=(e)=>/401|403|unauthori[sz]ed|invalid.*key|expired|forbidden/i.test(String(e.message))?"API Key 不对或已失效":
  /timeout|abort/i.test(String(e.message))?"Wind 请求超时，请稍后重试":`Wind 服务暂不可用：${e.message}`;
function bounded(value,values,ctx) {
  const safe=privateResult(value,[values.apiKey],ctx),serialized=JSON.stringify(safe);
  return Buffer.byteLength(serialized)<=MAX_RESULT?safe:{truncated:true,text:serialized.slice(0,18_000),notice:"Wind 返回结果过长，已截断；请缩小查询范围后再调用"};
}

// Read-only public endpoint injection is reserved for local mock tests, never account configuration.
export function createWindConnector({baseUrl="https://mcp.wind.com.cn",fetchImpl=fetch,archiveUrl,aliceUrl=baseUrl+"/skills/alice",timeoutMs=30_000}={}) {
  const withClient=async(values,server,fn)=> {
    const client=new Client({name:"doudou-wind",version:"0.6.0"},{capabilities:{}});
    const transport=new StreamableHTTPClientTransport(new URL(`${baseUrl}/vserver_${server}/mcp/`),{
      requestInit:{headers:{Authorization:`Bearer ${values.apiKey}`},signal:AbortSignal.timeout(timeoutMs),redirect:"error"},fetch:fetchImpl});
    try{await client.connect(transport,{timeout:timeoutMs});return await fn(client);}
    catch(e){throw new Error(chineseError(e));}
    finally{await transport.terminateSession().catch(()=>{});await client.close().catch(()=>{});}
  };
  const alice=async(values,question)=> {
    const response=await fetchImpl(aliceUrl,{method:"POST",headers:{Authorization:`Bearer ${values.apiKey}`,"Content-Type":"application/json",Accept:"text/event-stream, application/json"},
      redirect:"error",signal:AbortSignal.timeout(10*60_000),body:JSON.stringify({jsonrpc:"2.0",method:"message/stream",id:crypto.randomUUID(),params:{message:{messageId:crypto.randomUUID(),role:"user",kind:"message",
        parts:[{kind:"text",text:question},{kind:"data",data:{chatMode:"12",originalChatMode:"4",switchMode:"auto",timezone:"Asia/Shanghai"},metadata:{key:"Wind.WindSearch.ChatService.A2A",version:"1.0.0"}}],contextId:crypto.randomUUID(),taskId:crypto.randomUUID()}}})});
    if(!response.ok)throw new Error(chineseError(new Error(`HTTP ${response.status}`)));
    let result="",received=0,buffer="";
    const event=(ev)=> {
      if(ev.error)throw new Error(chineseError(new Error(ev.error.message||"Alice 返回错误")));
      if(ev.result?.isError)throw new Error(chineseError(new Error((ev.result.content||[]).map((p)=>p.text||"").join("\n")||"Alice 返回错误")));
      const artifact=ev.result?.artifact;
      if(ev.result?.kind==="artifact-update"&&artifact?.name==="agentResult") {
        const value=(artifact.parts||[]).filter((p)=>p.kind==="data").map((p)=>typeof p.data?.data==="string"?p.data.data:JSON.stringify(p.data?.data??p.data?.value??"" )).join("\n");
        result=ev.result.append?result+value:value;
      }
    };
    if((response.headers.get("content-type")||"").includes("text/event-stream")) {
      const decoder=new TextDecoder();
      const parse=(block)=> {const s=block.split(/\r?\n/).filter((l)=>l.startsWith("data:")).map((l)=>l.slice(5).trimStart()).join("\n");if(s&&s!=="[DONE]")event(JSON.parse(s));};
      for await(const chunk of response.body) {
        received+=chunk.length;if(received>4*1024*1024)throw new Error("Alice 响应过长，请缩小问题范围");
        buffer+=decoder.decode(chunk,{stream:true});const parts=buffer.split(/\r?\n\r?\n/);buffer=parts.pop();for(const part of parts)parse(part);
      }
      buffer+=decoder.decode();if(buffer.trim())parse(buffer);
    } else event(await response.json());
    if(!result.trim())throw new Error("Alice 未返回分析正文，请稍后重试");
    return {text:result};
  };
  const skills=(ctx)=>new WindSkills({ctx,fetchImpl,...(archiveUrl&&{archiveUrl})});
  return {
    name:"wind",title:"Wind AI",description:"万得股票、基金、指数、债券、公告研报、宏观和量化数据",icon:"icon.png",multiAccount:false,
    fields:[{key:"apiKey",type:"secret",label:"API Key",required:true,help:"在 Wind AI 金融市场（aifinmarket.wind.com.cn）登录后，用户中心 → API Key 复制"}],
    label:()=>"Wind AI",validate:apiKeyValues,
    test:(account)=>withClient(apiKeyValues(account),"stock_data",(client)=>client.listTools({}, {timeout:timeoutMs})),
    install:(ctx)=>skills(ctx).install(),uninstall:(ctx)=>skills(ctx).uninstall(),
    tools(accounts,ctx) {
      const account=accounts[0],values=account.values,cache=skills(ctx);
      const wrap=(fn)=>async(args)=> {
        try{ctx.assertCurrent?.(account.id);const result=bounded(await fn(args),values,ctx);return {content:[{type:"text",text:JSON.stringify(result)}],...(result.isError&&{isError:true})};}
        catch(e){return {isError:true,content:[{type:"text",text:JSON.stringify(privateResult({error:e.message},[values.apiKey],ctx))}]};}
      };
      return [
        tool("call","转发一个 Wind 工具调用。先用 list_tools 查指定服务的工具名与参数；结果过长会明确截断。",{server:SERVER,tool:z.string().min(1).max(200),args:z.record(z.string(),z.any()).default({})},
          wrap(({server,tool:name,args})=>withClient(values,server,(client)=>client.callTool({name,arguments:args},undefined,{timeout:timeoutMs})))),
        tool("list_tools","只查询一个 Wind 服务的工具名、说明和参数结构，不把全部远程工具常驻模型上下文。",{server:SERVER},wrap(async({server})=>withClient(values,server,async(client)=> {
          const tools=[];let cursor;
          do {const page=await client.listTools(cursor?{cursor}:{},{timeout:timeoutMs});tools.push(...page.tools.map(({name,description,inputSchema})=>({name,description,inputSchema})));cursor=page.nextCursor;
            if(tools.length>500)throw new Error("Wind 工具清单过长，请联系管理员检查");}while(cursor);
          return {server,tools};
        }))),
        tool("list_skills","列出已缓存的 Wind 官方技能名和一句话描述，按需选择。",{},wrap(()=>({skills:cache.list()}))),
        tool("install_skill","从连接器缓存安装一个 Wind 官方技能，自动改走连接器取数。只安装到当前豆豆，不需要配置 Key。",{name:z.string().min(1).max(101)},wrap(({name})=>cache.installSkill(name))),
        tool("ask_alice","把用户问题原文交给 Wind Alice（同一个 Key）。可能需要数分钟、消耗积分；返回原始分析正文。",{question:z.string().trim().min(1).max(10_000)},wrap(({question})=>alice(values,question))),
      ];
    },
  };
}
export default createWindConnector();
