// Real product HTTP/WS, content indexing, delivery and renderer; synthetic files only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'doudou-content-ui-'));
Object.assign(process.env,{AGENT_ROOT:root,AGENT_TOKEN:'local-fixture',AGENT_PORT:'18770',AGENT_HOST:'127.0.0.1'});
const [{initialize},{Harness},{DeviceHub},{ConnectorManager},{startServer},{Content}]=await Promise.all([
 import('../src/initialize.mjs'),import('../src/agent.mjs'),import('../src/devices.mjs'),import('../src/connectors.mjs'),import('../src/server.mjs'),import('../src/content.mjs')]);
initialize(root);
const put=(rel,body)=>{const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);};
const colors=['#275c72','#7e4767','#b46e3c','#557746','#4658a0'];
const html=(name,color)=>`<!doctype html><html lang="zh"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="theme.css"><title>${name}</title><body style="background:${color};color:white;font:20px sans-serif;padding:24px"><h1>${name}</h1><p>页面完整打开</p><img src="mark.svg" width="96" height="96"><p id="counter">点击次数 0</p><button style="font:20px sans-serif;padding:16px" onclick="document.getElementById('counter').textContent='点击次数 1'">试试交互</button><div style="height:650px"></div><p>页面底部</p></body></html>`;
for(let i=0;i<5;i++) {
 const dir=`data/library/artifacts/演示页面 ${i+1}`;
 put(`${dir}/index.html`,html(`演示页面 ${i+1}`,colors[i]));put(`${dir}/theme.css`,'body{margin:0}');put(`${dir}/mark.svg`,'<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#f1d6a5"/></svg>');
}
const poster='data/library/artifacts/独立海报.html';put(poster,html('独立海报','#345676'));
put('data/library/artifacts/theme.css','body{margin:0}');put('data/library/artifacts/mark.svg','<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><circle cx="48" cy="48" r="44" fill="#f1d6a5"/></svg>');
put('data/library/artifacts/演示文档/index.md','# 演示文档\n\n文档完整打开。');
const image=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><path fill="#497aa7" d="M0 0h600v300H0z"/><path fill="#78a58c" d="M0 300h600v300H0z"/><path fill="#cf915c" d="M0 600h600v300H0z"/></svg>')).png().toBuffer();put('data/library/media/演示长图.png',image);
const listeners=new Set(),bus={on:f=>listeners.add(f),emit:e=>listeners.forEach(f=>f(e))},hub=new DeviceHub(),connectors=new ConnectorManager({root,definitions:[]});
const harness=new Harness({hub,bus,connectors,runtime:{ready:true,close:async()=>{}}});
harness.speech.emit({text:'HTML 已做好，可以直接点开。',cards:[{type:'file',path:poster,name:'HTML 海报'}]});
harness.speech.emit({text:'这张图片由原生附件通道交付。'},{nativeMedia:[{type:'input_image',image_url:'data:image/png;base64,'+image.toString('base64')}]});
const server=startServer({harness,hub,bus,connectors,content:new Content({root,bus}),log:()=>{}});
// Production is HTTPS under /agent behind nginx. This disposable host is HTTP
// at /, so adapt only the cookie transport attributes at the proxy boundary.
server.prependListener('request',(_req,res)=>{
 const set=res.setHeader.bind(res);
 res.setHeader=(name,value)=>set(name,name.toLowerCase()==='set-cookie'?String(value).replace('Path=/agent','Path=/').replace('; Secure',''):value);
});
console.log('Synthetic content UI host ready: 18770');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await harness.close();server.closeSockets();server.closeAllConnections();server.close(()=>{fs.rmSync(root,{recursive:true,force:true});process.exit(0);});});
