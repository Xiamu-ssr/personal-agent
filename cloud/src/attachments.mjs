import fs from "node:fs";
import path from "node:path";
import { localFile } from "./local-paths.mjs";
import { transcribe, audioFormat } from "./transcribe.mjs";

const IMAGE_TYPES={".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".gif":"image/gif",".webp":"image/webp"};
const KIND_LABEL={image:"图片",file:"文件",voice:"语音笔记"};
export function validateMessage(root,text="",attachments=[]) {
  if(typeof text!=="string"||Buffer.byteLength(text,"utf8")>32*1024) throw new Error("消息文字不能超过 32KB");
  if(!Array.isArray(attachments)||attachments.length>10)throw new Error("附件必须是列表，一次最多 10 个");
  const atts=attachments.map((a)=> {
    if(!a||typeof a!=="object"||!KIND_LABEL[a.kind])throw new Error("附件类型只能是 image、file 或 voice");
    let file;
    try{file=localFile(root,a.path,"data/uploads");}catch{throw new Error("附件必须是已经上传到 data/uploads/ 的文件，不能使用外部路径或符号链接");}
    const size=fs.statSync(file).size;
    if(size>20*1024*1024)throw new Error("附件超过 20MB");
    if(a.kind==="image"&&(!IMAGE_TYPES[path.extname(file).toLowerCase()]||size>5*1024*1024))throw new Error("图片只支持 JPG、PNG、GIF、WebP，不能超过 5MB");
    if(a.name!==undefined&&(typeof a.name!=="string"||a.name.length>200||/[\x00-\x1f]/.test(a.name)))throw new Error("附件名字格式不正确");
    return {path:path.relative(root,file),name:a.name||path.basename(file),kind:a.kind,size};
  });
  if(!text.trim()&&!atts.length)throw new Error("文字和附件不能同时为空");
  return {text:text.trim(),attachments:atts};
}
export async function prepareAttachments(root,atts) {
  for(const att of atts) if(att.kind==="voice") {
    const file=path.join(root,att.path);
    try {att.transcript=await transcribe(fs.readFileSync(file),audioFormat(file));fs.writeFileSync(file.replace(/\.[^.]+$/,"")+".txt",att.transcript+"\n");}
    catch {att.transcript="（语音转写暂不可用）";}
  }
  return atts;
}
// Images are message blocks; other uploads stay as explicit paths for Read.
const fileSize=(size)=>size<1024?`${size} B`:size<1024*1024?`${Number((size/1024).toFixed(1))} KB`:`${Number((size/(1024*1024)).toFixed(1))} MB`;
export function userContent(root,text,atts=[]) {
  if(!atts.length)return text;
  const lines=atts.map((a)=>a.kind==="voice"?`- ${a.path}（语音笔记，转写：${a.transcript||"空"}）`:
    a.kind==="image"?`- ${a.path}（图片，已附在本条消息里）`:`- ${a.path}（文件，${Number.isFinite(a.size)?fileSize(a.size)+"，":""}需要时自己读）`);
  const content=[{type:"text",text:`${text||(atts.every((a)=>a.kind==="voice")?"（一段语音笔记）":"（发来了附件）")}\n\n[附件]\n${lines.join("\n")}`}];
  for(const a of atts)if(a.kind==="image")content.push({type:"image",source:{type:"base64",media_type:IMAGE_TYPES[path.extname(a.path).toLowerCase()],data:fs.readFileSync(localFile(root,a.path,"data/uploads")).toString("base64")}});
  return content;
}
