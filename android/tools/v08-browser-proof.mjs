// Read only the temporary demo Chrome. Used to verify Android's remote inputs.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {root}=JSON.parse(fs.readFileSync('/tmp/v08-android-shots/demo-host.json','utf8'));
if(!root.startsWith('/tmp/v08-android-cloud-')) throw Error('Expected disposable demo root');
const port=Number(fs.readFileSync(path.join(root,'system/browser/profile/DevToolsActivePort'),'utf8').split('\n')[0]);
const require=createRequire(path.join(repo,'cloud/package.json'));
const {chromium}=require('playwright-core');
const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('http://127.0.0.1:18770/'));
if(!page) throw Error('Local demo form not found');
const result=await page.evaluate(()=>({input:document.querySelector('input').value,plan:document.querySelector('h2').textContent,rects:[...document.querySelectorAll('input,button')].map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,label:e.textContent,x:r.x+r.width/2,y:r.y+r.height/2}})}));
console.log(JSON.stringify(result));
// Disconnect this read-only verifier; leave ownership and the controller's browser intact.
process.exit(0);
