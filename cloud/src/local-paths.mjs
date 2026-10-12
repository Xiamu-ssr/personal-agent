import fs from "node:fs";
import path from "node:path";

export const inside=(file,dir)=>file===dir||file.startsWith(dir+path.sep);
export function resolvedPath(file) {
  let parent=path.resolve(file);const tail=[];
  while(!fs.existsSync(parent)&&parent!==path.dirname(parent)) {tail.unshift(path.basename(parent));parent=path.dirname(parent);}
  try {return path.join(fs.realpathSync(parent),...tail);}catch {return path.resolve(file);}
}
// Only files whose real path stays in a particular data subtree may be loaded.
export function localFile(root,rel,subtree) {
  if(typeof rel!=="string"||rel.includes("\0")||path.isAbsolute(rel)||rel.split(/[\\/]/).includes(".."))throw new Error("文件路径不在允许的目录内");
  const base=path.resolve(root,subtree),file=path.resolve(root,rel),realRoot=fs.realpathSync(root);
  if(!inside(file,base)||!inside(fs.realpathSync(file),path.join(realRoot,subtree))||!fs.statSync(file).isFile())throw new Error("文件路径不在允许的目录内");
  return file;
}
