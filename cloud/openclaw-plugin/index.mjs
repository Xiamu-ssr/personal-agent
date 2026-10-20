import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
const object=(properties={},required=[])=>({type:"object",properties,required,additionalProperties:false});
async function bridge(route,body,sessionKey) {
 const res=await fetch(`http://127.0.0.1:${process.env.AGENT_PORT||4400}/internal/${route}`,{
  method:"POST",headers:{authorization:`Bearer ${process.env.AGENT_TOKEN}`,"content-type":"application/json"},body:JSON.stringify({...body,sessionKey}),signal:AbortSignal.timeout(180_000)});
 const value=await res.json();
 if(!res.ok)throw new Error(value.error||"豆豆工具暂不可用");
 return value;
}
export default definePluginEntry({id:"doudou",name:"豆豆",register(api) {
 for(const [hook,phase]of [['before_tool_call','before'],['after_tool_call','after']])api.on(hook,async(event,ctx)=>{
   try{await bridge('event',{phase,tool:event.toolName,error:!!event.error},ctx.sessionKey);}catch{ /* Observability cannot fail an agent tool. */ }
 });
 for(const [name,description,parameters,route] of [
  ["doudou_catalog","查看豆豆的设备、连接器、目标、定时和内容工具。传 group 获取该组的完整参数；省略列出分组。",object({group:{type:"string"}}),"catalog"],
  ["doudou_call","调用目录中的工具，先查看该组参数。name 如 tavily.search；args_json 是按目录字段组成的 JSON 对象字符串，如 {\"query\":\"搜索内容\"}。无参数传字符串 {}。",object({name:{type:"string"},args_json:{type:"string",description:"JSON 对象编码的字符串，字段遵循目录中的 parameters。"}},["name","args_json"]),"call"],
  ["doudou_say","向用户发送文字、选项和卡片。普通回复可直接输出文字；后台没有重要变化时不发送。卡片格式请查看 speech 组。",{type:"object",properties:{text:{type:"string"},options:{type:"array",items:object({label:{type:"string"},reply:{type:"string"}},["label"])},cards:{type:"array",items:{type:"object",additionalProperties:true}}},required:["text"],additionalProperties:false},"say"],
 ])api.registerTool(ctx=>({name,label:name,description,parameters,execute:async(_id,args)=>bridge(route,args,ctx.sessionKey)}),{names:[name]});
}});
