import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { localFile, inside } from "./local-paths.mjs";
import { screenshotService } from "./screenshot-service.mjs";

const WIDTH=390,SCREEN=844,MAX_BYTES=300*1024;
let active=false; // Shared by all queries and instances: one browser for this entire process.
export function screenshotTarget(root,rel) {
  if (typeof rel !== "string" || !/^data\/library\/artifacts\/[^/]+(?:\/|$)/.test(rel)) throw new Error("页面截图只允许 data/library/artifacts/ 下的本地页面");
  if (rel.split(/[\\/]/).includes("..") || path.isAbsolute(rel)) throw new Error("页面截图路径不能越出构件目录");
  const candidate = path.resolve(root, rel);
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) rel = path.join(rel, "index.html");
  if (!/\.html?$/.test(rel)) throw new Error("页面截图请指定 HTML 页面或含 index.html 的目录");
  return { file: localFile(root, rel, "data/library/artifacts"), rel };
}

export function browserExecutable() {
  const candidates=[process.env.AGENT_SCREENSHOT_BROWSER,"/opt/personal-agent-browser/chrome-headless-shell-linux64/chrome-headless-shell","/usr/bin/google-chrome-stable","/usr/bin/google-chrome","/usr/bin/chromium","/usr/bin/chromium-browser"];
  if(process.platform==="darwin")candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",chromium.executablePath());
  return candidates.find((p)=>p&&fs.existsSync(p));
}
const TYPES={".html":"text/html; charset=utf-8",".css":"text/css",".js":"text/javascript",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".woff2":"font/woff2",".woff":"font/woff"};
export class PageScreenshot {
  constructor({root,executablePath,timeoutMs=30_000,service=!!process.env.AGENT_BROWSER_SERVICE,browserProvider,terminateBrowser}={}) {Object.assign(this,{root,executablePath,timeoutMs,service,browserProvider,terminateBrowser});}
  async screenshot({path:rel}) {
    const target=screenshotTarget(this.root,rel);
    if(active)throw new Error("已有页面正在截图，请等它结束后再试");
    if(this.service) {
      active=true;
      try {return await screenshotService({root:this.root,path:target.rel,timeoutMs:this.timeoutMs});}
      finally {active=false;}
    }
    const executablePath=this.executablePath??browserExecutable();
    if(!this.browserProvider&&(!executablePath||!fs.existsSync(executablePath)))throw new Error("页面截图暂不可用：浏览器尚未安装，请管理员运行 install-screenshot.sh");
    active=true;
    let browserServer,browser,context,timer,timedOut=false,closing;
    const deadline=Date.now()+this.timeoutMs;
    const cleanupBudget=Math.min(1000,this.timeoutMs/10);
    const killBrowser=()=> {
      if(this.browserProvider) { if(!closing)closing=Promise.resolve().then(()=>this.terminateBrowser?.()).catch(()=>{});return closing; }
      if(!browserServer)return Promise.resolve();
      if(!closing)closing=browserServer.kill().catch(()=>{});
      return closing;
    };
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=> {
      timedOut=true;void killBrowser();reject(new Error("页面截图超时（30 秒），请精简页面后再试"));
    },Math.max(1,this.timeoutMs-cleanupBudget));});
    const run=async()=> {
      if(this.browserProvider)browser=await this.browserProvider();
      else {
        browserServer=await chromium.launchServer({executablePath,headless:true,timeout:Math.max(1,deadline-Date.now()),
          args:["--disable-dev-shm-usage","--disable-gpu","--no-sandbox","--renderer-process-limit=1","--js-flags=--max-old-space-size=128","--no-proxy-server","--disable-background-networking"]});
        if(timedOut){void killBrowser();throw new Error("页面截图超时");}
        browser=await chromium.connect(browserServer.wsEndpoint());
      }
      if(timedOut){void killBrowser();throw new Error("页面截图超时");}
      context=await browser.newContext({viewport:{width:WIDTH,height:SCREEN},deviceScaleFactor:1,serviceWorkers:"block",acceptDownloads:false});
      await context.routeWebSocket("**/*",(socket)=>socket.close());
      const siteRoot=path.join(this.root,"data/library/artifacts",target.rel.split("/")[3]);
      // All requests are handled here; there is never a route.continue() to HTTP.
      // A synthetic origin maps relative site resources to local files without granting file:// access to system/.
      const localOrigin="https://page.localhost";
      let mainHtml;
      await context.route("**/*",async(route)=> {
        try {
          const url=new URL(route.request().url());
          if(url.protocol==="data:")return await route.continue();
          let file;
          if(siteRoot&&url.origin===localOrigin)file=localFile(this.root,decodeURIComponent(url.pathname).replace(/^\//,""),"data/library/artifacts");
          else if(siteRoot&&url.protocol==="file:")file=localFile(this.root,path.relative(this.root,fileURLToPath(url)),"data/library/artifacts");
          else return await route.abort();
          if(!inside(fs.realpathSync(file),fs.realpathSync(siteRoot))||fs.statSync(file).size>5*1024*1024)return await route.abort();
          const body=file===target.file&&mainHtml!==undefined?mainHtml:fs.readFileSync(file);
          return await route.fulfill({status:200,contentType:TYPES[path.extname(file)]||"application/octet-stream",body,
            headers:{"content-security-policy":`default-src data: ${localOrigin} file:; script-src 'unsafe-inline' data: ${localOrigin}; style-src 'unsafe-inline' data: ${localOrigin}; connect-src ${localOrigin}; frame-src 'none'; object-src 'none'; form-action 'none'`}});
        } catch {await route.abort().catch(()=>{});}
      });
      const page=await context.newPage();page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(8000);
      page.on("popup",(popup)=>popup.close().catch(()=>{}));
      await context.addInitScript(()=>{Object.defineProperty(window,"open",{value:()=>null});
        Object.defineProperty(window,"RTCPeerConnection",{value:undefined});
      });
      const captures=[];let height=0;
      if(fs.statSync(target.file).size>5*1024*1024)throw new Error("页面超过 5MB，请精简后再截图");
      mainHtml=fs.readFileSync(target.file,"utf8");
      await page.goto(localOrigin+"/"+target.rel.split("/").map(encodeURIComponent).join("/"),{waitUntil:"load"});
      await page.evaluate(()=>document.fonts.ready);
      height=Math.min(SCREEN*3,Math.max(SCREEN,Math.ceil(await page.evaluate(()=>document.documentElement.scrollHeight))));
      await page.setViewportSize({width:WIDTH,height});
      await page.evaluate(()=>new Promise((resolve)=> {
        const timer=setTimeout(resolve,160);
        requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));
      }));
      captures.push({input:await page.screenshot({type:"jpeg",quality:85,animations:"disabled",clip:{x:0,y:0,width:WIDTH,height}}),top:0,left:0});
      await context.close();context=null;
      if(browserServer){await browser.close();await browserServer.close();browserServer=null;}
      browser=null;
      sharp.cache(false);sharp.concurrency(1);
      const composite=await sharp({create:{width:WIDTH,height,channels:3,background:"#ffffff"}}).composite(captures).png().toBuffer();
      let data;
      for(const quality of [80,65,50,35,22]) {data=await sharp(composite).jpeg({quality,mozjpeg:true}).toBuffer();if(data.length<=MAX_BYTES)break;}
      if(data.length>MAX_BYTES)data=await sharp(composite).resize({width:300}).jpeg({quality:25,mozjpeg:true}).toBuffer();
      if(data.length>MAX_BYTES)throw new Error("页面截图内容过多，请拆分检查");
      const size=await sharp(data).metadata();
      return {data,width:size.width,height:size.height,path:target.rel};
    };
    try {return await Promise.race([run(),timeout]);}
    finally {
      clearTimeout(timer);
      if(context) {
        let cleanupTimer;
        await Promise.race([context.close().catch(()=>{}),new Promise((resolve)=>{cleanupTimer=setTimeout(resolve,500);})]);
        clearTimeout(cleanupTimer);
      }
      if(browserServer) {
        let cleanupTimer;
        await Promise.race([killBrowser(),new Promise((resolve)=>{cleanupTimer=setTimeout(resolve,Math.max(1,deadline-Date.now()));})]);
        clearTimeout(cleanupTimer);
        // launchServer owns a detached process group on Unix. Do not let a slow profile cleanup hold the tool open.
        const proc=browserServer.process();
        if(proc?.pid&&proc.exitCode===null&&proc.signalCode===null) {
          try{process.platform==="win32"?proc.kill("SIGKILL"):process.kill(-proc.pid,"SIGKILL");}catch{}
        }
      }
      active=false;
    }
  }
  tools() {
    return [tool("screenshot","按 390px 手机宽度检查资源库里的页面。仅本地构件，禁止联网，最多三屏。",{
      path:z.string().max(1024),
    },async(args)=> {
      try {const result=await this.screenshot(args);return {content:[{type:"image",mimeType:"image/jpeg",data:result.data.toString("base64")},{type:"text",text:JSON.stringify({path:result.path,width:result.width,height:result.height})}]};}
      catch(e){return {isError:true,content:[{type:"text",text:e.message}]};}
    })];
  }
  mcpServer(){return createSdkMcpServer({name:"page",version:"0.8.0",tools:this.tools()});}
}
