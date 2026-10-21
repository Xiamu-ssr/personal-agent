import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { localFile, inside } from "./local-paths.mjs";

const TYPES = {
  ".png": ["image", "image/png"], ".jpg": ["image", "image/jpeg"], ".jpeg": ["image", "image/jpeg"],
  ".gif": ["image", "image/gif"], ".webp": ["image", "image/webp"],
  ".heic":["image","image/heic"],".heif":["image","image/heif"],".avif":["image","image/avif"],".bmp":["image","image/bmp"],".tif":["image","image/tiff"],".tiff":["image","image/tiff"],
  ".mp4": ["video", "video/mp4"], ".m4v": ["video", "video/x-m4v"],
  ".mov": ["video", "video/quicktime"], ".webm": ["video", "video/webm"],
  ".mkv":["video","video/x-matroska"],".3gp":["video","video/3gpp"],
  ".mp3": ["audio", "audio/mpeg"], ".m4a": ["audio", "audio/mp4"], ".aac": ["audio", "audio/aac"],
  ".wav": ["audio", "audio/wav"], ".ogg": ["audio", "audio/ogg"], ".opus": ["audio", "audio/ogg"], ".flac": ["audio", "audio/flac"],
  ".aif":["audio","audio/aiff"],".aiff":["audio","audio/aiff"],".alac":["audio","audio/mp4"],
  ".html": ["file", "text/html; charset=utf-8"],".htm":["file","text/html; charset=utf-8"], ".md": ["file", "text/markdown; charset=utf-8"], ".json": ["file", "application/json"],
  ".css": ["file", "text/css"], ".js": ["file", "text/javascript"], ".svg": ["file", "image/svg+xml"],
  ".txt": ["file", "text/plain; charset=utf-8"], ".csv": ["file", "text/csv; charset=utf-8"], ".ico": ["file", "image/x-icon"],
  ".pdf": ["file", "application/pdf"], ".zip": ["file", "application/zip"],
  ".docx": ["file", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".xlsx": ["file", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".pptx": ["file", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
};

export function fileType(file) {
  const [kind, mime] = TYPES[path.extname(file).toLowerCase()] || ["file", "application/octet-stream"];
  return { kind, mime };
}

export function mediaFile(root,rel,name) {
  const file=localFile(root,rel,"data");
  return {path:path.relative(root,file),name:name||path.basename(file),...fileType(file),size:fs.statSync(file).size};
}

// Native webchat media arrives as typed blocks, independently of its text.
// Store those bytes once and publish the same file envelope used by cards.
export function nativeReplyMedia(root,blocks=[]) {
  const media=[];
  for(const block of blocks.slice(0,20)) {
    const source=block.type==='input_image'?block.image_url:block.type==='image'?
      (block.source?.type==='base64'?`data:${block.source.media_type};base64,${block.source.data}`:block.url):block.attachment?.url;
    if(typeof source!=="string")continue;
    let rel,name=block.attachment?.label;
    const inline=source.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/);
    if(inline) {
      if(inline[2].length>28*1024*1024)throw new Error("返回图片超过 20MB");
      const bytes=Buffer.from(inline[2],"base64");
      if(!bytes.length||bytes.length>20*1024*1024)throw new Error("返回图片大小不正确");
      const ext=inline[1].split('/')[1].replace('jpeg','jpg'),hash=crypto.createHash('sha256').update(bytes).digest('hex');
      rel=`data/library/media/replies/${hash}.${ext}`;name=`图片.${ext}`;
      const dir=path.dirname(path.join(root,rel));fs.mkdirSync(dir,{recursive:true,mode:0o700});
      if(!inside(fs.realpathSync(dir),fs.realpathSync(path.join(root,'data'))))throw new Error("返回图片目录不正确");
      try{fs.writeFileSync(path.join(root,rel),bytes,{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;localFile(root,rel,'data');}
    } else {
      rel=path.isAbsolute(source)?path.relative(root,source):source;
      if(!rel.startsWith('data/'))throw new Error("返回附件不在 data/ 内");
    }
    const file=mediaFile(root,rel,name);
    if(!media.some(m=>m.path===file.path))media.push(file);
  }
  return media;
}

const unescape = (s) => s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");

function withoutCodeBlocks(text) {
  let fence;
  const lists = [];
  return text.split(/\r?\n/).map((line) => {
    const quoted = line.replace(/^(?: {0,3}>[ \t]?)+/, "");
    const content = quoted.replace(/^[ \t]*/, (s) => s.replace(/\t/g, "    "));
    if (fence) {
      const marker = content.slice(fence.indent).match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (marker && marker[1][0] === fence.run[0] && marker[1].length >= fence.run.length && !marker[2].trim()) fence = null;
      return "";
    }
    const indent = content.match(/^ */)[0].length;
    if (content.trim()) while (lists.length && indent < lists.at(-1)) lists.pop();
    const list = content.match(/^ *(?:[-+*]|\d+[.)])( +)(?=\S)/);
    if (list && indent - (lists.at(-1) || 0) < 4) lists.push(list[0].length - (list[1].length > 4 ? list[1].length - 1 : 0));
    const base = lists.at(-1) || 0, block = content.slice(base);
    const marker = block.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) { fence = { run: marker[1], indent: base }; return ""; }
    return /^ {4}/.test(block) ? "" : line;
  }).join("\n");
}

function linkAt(text, start) {
  let at = start + 1, depth = 1;
  for (; at < text.length; at++) {
    if (text[at] === "\\") { at++; continue; }
    if (text[at] === "[") depth++;
    if (text[at] === "]" && !--depth) break;
  }
  if (depth || text[at + 1] !== "(") return null;
  const name = unescape(text.slice(start + 1, at)).trim();
  at += 2;
  while (/\s/.test(text[at] || "")) at++;
  let destination = "";
  if (text[at] === "<") {
    const from = ++at;
    for (; at < text.length && text[at] !== ">"; at++) {
      if (text[at] === "\n" || text[at] === "<") return null;
      if (text[at] === "\\") at++;
    }
    if (text[at] !== ">") return null;
    destination = text.slice(from, at++);
  } else {
    const from = at;
    depth = 0;
    for (; at < text.length; at++) {
      if (text[at] === "\\") { at++; continue; }
      if (text[at] === "(") depth++;
      if (text[at] === ")") { if (!depth) break; depth--; }
      if (/\s/.test(text[at])) break;
    }
    if (depth) return null;
    destination = text.slice(from, at);
  }
  const spaced = /\s/.test(text[at] || "");
  while (/\s/.test(text[at] || "")) at++;
  if (spaced && ["\"", "'", "("].includes(text[at])) {
    const close = text[at] === "(" ? ")" : text[at];
    for (at++; at < text.length && text[at] !== close; at++) if (text[at] === "\\") at++;
    if (text[at++] !== close) return null;
    while (/\s/.test(text[at] || "")) at++;
  }
  return text[at] === ")" ? { name, destination: unescape(destination), end: at } : null;
}

function* links(text) {
  const body = withoutCodeBlocks(text);
  for (let at = 0; at < body.length; at++) {
    if (body[at] === "\\") { at++; continue; }
    if (body[at] === "`") {
      const run = body.slice(at).match(/^`+/)[0];
      let end = at + run.length;
      while ((end = body.indexOf(run, end)) >= 0) {
        if (body[end - 1] !== "`" && body[end + run.length] !== "`") break;
        end += run.length;
      }
      if (end >= 0) at = end + run.length - 1;
      else at += run.length - 1;
    } else if (body[at] === "[") {
      const link = linkAt(body, at);
      if (link) { yield link; at = link.end; }
    }
  }
}

export function replyMedia(root, text) {
  const media = [], seen = new Set();
  if (typeof text !== "string") return media;
  for (const link of links(text)) {
    try {
      const decoded = decodeURIComponent(link.destination);
      if (!decoded.startsWith("data/") || decoded.includes("\\")) continue;
      const file = localFile(root, decoded, "data"), rel = path.relative(root, file);
      if (seen.has(rel)) continue;
      media.push({ path: rel, name: link.name || path.basename(file), ...fileType(file), size: fs.statSync(file).size });
      seen.add(rel);
      if (media.length === 20) break;
    } catch {}
  }
  return media;
}
