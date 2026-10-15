import fs from "node:fs";
import path from "node:path";
import { localFile } from "./local-paths.mjs";

const TYPES = {
  ".png": ["image", "image/png"], ".jpg": ["image", "image/jpeg"], ".jpeg": ["image", "image/jpeg"],
  ".gif": ["image", "image/gif"], ".webp": ["image", "image/webp"],
  ".mp4": ["video", "video/mp4"], ".m4v": ["video", "video/x-m4v"],
  ".mov": ["video", "video/quicktime"], ".webm": ["video", "video/webm"],
  ".mp3": ["audio", "audio/mpeg"], ".m4a": ["audio", "audio/mp4"], ".aac": ["audio", "audio/aac"],
  ".wav": ["audio", "audio/wav"], ".ogg": ["audio", "audio/ogg"], ".opus": ["audio", "audio/ogg"], ".flac": ["audio", "audio/flac"],
  ".html": ["file", "text/html; charset=utf-8"], ".md": ["file", "text/markdown; charset=utf-8"], ".json": ["file", "application/json"],
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
