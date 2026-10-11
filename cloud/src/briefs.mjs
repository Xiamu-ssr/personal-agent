// Each API card is an independent offline HTML document. JSON is migration input only.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseDocument } from "htmlparser2";
import render from "dom-serializer";
import { dateIn } from "./store.mjs";

export const BRIEF_MAX_BYTES = 80 * 1024;
export const BRIEF_MAX_HEIGHT = 560;
const BASE_CSS = fs.readFileSync(new URL("./brief-base.css", import.meta.url), "utf8");
const BUTTON_SCRIPT = fs.readFileSync(new URL("./brief-button.js", import.meta.url), "utf8");
const SCRIPT_HASH = crypto.createHash("sha256").update(BUTTON_SCRIPT).digest("base64");
export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const hasClass = (n, c) => (n.attribs?.class || "").split(/\s+/).includes(c);
const elements = (n) => (n.children || []).filter((c) => c.name);
function allNodes(n) { return [n, ...(n.children || []).flatMap(allNodes)]; }
function textOf(n) { return n.type === "text" ? n.data : ["style","script"].includes(n.name) ? "" : (n.children || []).map(textOf).join(""); }
const chars = (s) => [...s.replace(/\s+/g," ").trim()].reduce((n,c) => n + (/[^\x00-\x7f]/.test(c) ? 1 : .5),0);
const cssText = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\\([\da-f]{1,6})\s?|\\([^\r\n])/gi, (_,hex,c) => hex ? String.fromCodePoint(Math.min(parseInt(hex,16),0x10ffff)) : c);

// Horizontal groups share a row; prose and repeated elements add height. App measures the real layout.
export function estimateCardHeight(node, width=312) {
  const children=elements(node), count=chars(textOf(node));
  const lines=(size=14) => Math.max(1,Math.ceil(count / Math.max(6,width/size)));
  let h;
  if (hasClass(node,"chip")) h=32;
  else if (hasClass(node,"title") || node.name==="h1") h=lines(21)*29+10;
  else if (node.name==="h2" || node.name==="h3") h=lines(node.name==="h2"?17:13)*(node.name==="h2"?24:19)+6;
  else if (hasClass(node,"summary")) h=lines(13)*22+16;
  else if (hasClass(node,"note")) h=lines(12)*20+32;
  else if (node.name==="button") h=lines(12)*18+24;
  else if (["svg","img"].includes(node.name)) h=Number(node.attribs?.height)||120;
  else if (["timeline","tiles","metrics"].some((c)=>hasClass(node,c))) {
    const w=Math.max(50,(width-(children.length-1)*8)/Math.max(1,children.length));
    h=Math.max(0,...children.map((c)=>estimateCardHeight(c,w)))+28;
  } else if (hasClass(node,"metric")) h=88+Math.max(0,lines(11)-6)*17;
  else if (hasClass(node,"tile")) h=children.reduce((n,c)=>n+estimateCardHeight(c,width-20),0)+24;
  else if (["p","li"].includes(node.name) || !children.length || children.every((c)=>["span","b","strong","em","small","br","a"].includes(c.name))) h=lines()*22+(node.name==="li"?18:node.name==="p"?10:0);
  else {
    h=children.reduce((n,c)=>n+estimateCardHeight(c,width),0);
    const direct=(node.children||[]).filter((n)=>n.type==="text").map(textOf).join("").trim();
    if (direct) h+=Math.ceil(chars(direct)/24)*22;
  }
  const explicit=cssText(node.attribs?.style||"").match(/(?:^|;)\s*(?:min-)?height\s*:\s*(\d+(?:\.\d+)?)px/i);
  return Math.ceil(Math.max(h,Number(explicit?.[1])||0)+(hasClass(node,"card")?40:0));
}

// Height is checked when the agent writes a brief; serving skips it because the App scrolls inside tall cards.
export function validateBrief(html,{height=true}={}) {
  if (typeof html!=="string") return {error:"简报必须是 HTML 文本"};
  if (Buffer.byteLength(html,"utf8")>BRIEF_MAX_BYTES) return {error:"简报文件超过 80KB，请缩短内容"};
  const doc=parseDocument(html,{decodeEntities:true}), nodes=allNodes(doc);
  const root=nodes.find((n)=>n.name==="body")||doc;
  const cards=elements(root).filter((n)=>n.name==="section"&&hasClass(n,"card"));
  if (cards.length<1||cards.length>6) return {error:"简报需要 1–6 个顶层 section.card"};
  if (nodes.filter((n)=>n.name==="section"&&hasClass(n,"card")).length!==cards.length) return {error:"section.card 不能嵌套，也不能包在其他元素里"};
  if (elements(root).some((n)=>!cards.includes(n)&&!["style","head","title","meta"].includes(n.name))) return {error:"卡片必须是顶层 section.card，公共样式放在 style 中"};
  for (const node of nodes) {
    if (["script","iframe","object","embed","link","base","form"].includes(node.name)||Object.keys(node.attribs||{}).some((k)=>/^on/i.test(k))) return {error:"简报不能包含脚本、外部页面、表单或事件属性；按钮只用 data-prompt"};
    for (const [key,value] of Object.entries(node.attribs||{})) {
      if (key==="srcset" && /https?:|\/\//i.test(value)) return {error:"简报不能加载外部图片资源"};
      if (["src","href","xlink:href","srcset","poster","action"].includes(key)&&value&&!/^(?:data:|#)/i.test(value.trim())) return {error:"简报不能加载外部资源，图片请用内联 SVG 或 data URI"};
    }
    const css=cssText(node.name==="style"?(node.children||[]).map((n)=>n.data||"").join(""):node.attribs?.style||"");
    if (/@import\b/i.test(css)||/url\(\s*["']?\s*(?!data:|#)[^\s)"']/i.test(css)) return {error:"简报样式不能含外部 url() 或 @import"};
  }
  const styles=nodes.filter((n)=>n.name==="style").map((n)=>render(n,{encodeEntities:"utf8"})).join("\n");
  for (let i=0;i<cards.length;i++) {
    const h=estimateCardHeight(cards[i]);
    if (height&&(h>BRIEF_MAX_HEIGHT||allNodes(cards[i]).filter((n)=>n.name).length>120)) return {error:`第 ${i+1} 张卡片内容过高（粗估 ${h}px，上限 560px），请精简文字、减少元素或拆成两张卡片`};
  }
  const meta=(key)=>nodes.find((n)=>n.name==="meta"&&n.attribs?.name===key)?.attribs?.content;
  const time=meta("brief-time");
  if (time&&(!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(time)||!Number.isFinite(Date.parse(time)))) return {error:"brief-time 必须是带时区的 ISO 时间"};
  return {brief:{name:meta("brief-name"),time,cards:cards.map((n)=>({html:cardDocument(render(n,{encodeEntities:"utf8"}),styles)}))}};
}

function cardDocument(card,styles) {
  const csp=`default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; connect-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${BASE_CSS}</style>${styles}</head><body>${card}<script>${BUTTON_SCRIPT}</script></body></html>`;
}

export const isBriefPath=(rel)=>/^data\/briefs\/\d{4}-\d{2}-\d{2}\/.+\.html$/.test(rel);
export const isOutputPath=(rel)=>isBriefPath(rel)||/^data\/sites\/.+\.html$/.test(rel);
export function readBrief(root,rel,options) {
  try {
    if (!isBriefPath(rel)) return {error:"简报路径必须是 data/briefs/<日期>/<任务名>.html"};
    const file=path.resolve(root,rel), dir=path.resolve(root,"data/briefs");
    if (!file.startsWith(dir+path.sep)||fs.lstatSync(file).isSymbolicLink()||!fs.realpathSync(file).startsWith(fs.realpathSync(dir)+path.sep)) return {error:"简报路径越出了 data/briefs/"};
    if (fs.statSync(file).size>BRIEF_MAX_BYTES) return {error:"简报文件超过 80KB，请缩短内容"};
    const result=validateBrief(fs.readFileSync(file,"utf8"),options);
    if (result.brief) { result.brief.name||=path.basename(file,".html"); result.brief.time||=fs.statSync(file).mtime.toISOString(); }
    return result;
  } catch {return {error:"简报 HTML 文件无法读取"};}
}

export function listBriefs(root,{days=7,timezone="Asia/Shanghai",now=new Date()}={}) {
  const today=dateIn(timezone,now), cutoff=new Date(Date.parse(today+"T00:00:00Z")-(days-1)*86400_000).toISOString().slice(0,10);
  const items=[], dir=path.join(root,"data/briefs");
  function walk(folder) {
    for (const entry of fs.readdirSync(folder,{withFileTypes:true})) {
      const file=path.join(folder,entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()&&entry.name.endsWith(".html")) {
        const rel=path.relative(root,file), date=rel.split("/")[2];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<cutoff||date>today) continue;
        const {brief}=readBrief(root,rel,{height:false});
        if (brief) items.push({date,name:brief.name,time:brief.time,path:rel,cards:brief.cards});
      }
    }
  }
  if (fs.existsSync(dir)&&!fs.lstatSync(dir).isSymbolicLink()) walk(dir);
  return items.sort((a,b)=>Date.parse(b.time)-Date.parse(a.time)||a.path.localeCompare(b.path));
}
