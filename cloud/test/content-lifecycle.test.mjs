import {testRoot} from './environment.mjs';
import fs from 'node:fs';import path from 'node:path';import test from 'node:test';import assert from 'node:assert/strict';
import {Content} from '../src/content.mjs';import {initialize} from '../src/initialize.mjs';import {migrateLibrary} from '../scripts/migrate-library.mjs';import {GatewayChat} from '../src/gateway-chat.mjs';
const put=(root,rel,text)=>{fs.mkdirSync(path.dirname(path.join(root,rel)),{recursive:true});fs.writeFileSync(path.join(root,rel),text)};
test('one-way library migration preserves local site assets and rewrites product references',()=>{
 const root=fs.mkdtempSync(path.join(testRoot,'library-migration-')),backup=path.join(testRoot,'library-backup.tgz');
 put(root,'data/library/artifacts/看板/index.html','<h1>看板</h1>');put(root,'data/library/artifacts/报告.md','# 报告');put(root,'data/library/artifacts/海报.html','<link href="theme.css">');put(root,'data/library/artifacts/theme.css','body{color:red}');
 put(root,'system/chat.jsonl',JSON.stringify({cards:[{type:'file',path:'data/library/artifacts/海报.html'}]})+'\n');put(root,'system/pending-results.json','[{"label":"old"}]');
 const result=migrateLibrary({root,backup});assert.equal(result.migrated,true);initialize(root);
 assert.equal(fs.existsSync(path.join(root,'data/library/artifacts')),false);assert.equal(fs.existsSync(path.join(root,'system/pending-results.json')),false);
 assert.equal(fs.readFileSync(path.join(root,'data/library/sites/海报/theme.css'),'utf8'),'body{color:red}');
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'system/chat.jsonl'),'utf8')).cards[0].path,'data/library/sites/海报/index.html');
 const c=new Content({root}),lib=c.library();assert.equal(lib.artifacts.filter(a=>a.kind==='site').length,2);assert.equal(lib.artifacts.filter(a=>a.kind==='document').length,1);
 assert.equal(migrateLibrary({root,backup}).migrated,false);
});
test('publish validates the same file the app reads, and exposes invalid feed entries',()=>{
 const root=fs.mkdtempSync(path.join(testRoot,'publish-'));initialize(root);const events=[],c=new Content({root,bus:{emit:e=>events.push(e)}});
 const rel='data/feed/2026-10-21/1000-demo.md';c.write(rel,'---\nsource: 示例\n---\n正文');assert.throws(()=>c.publish(rel));assert.equal(c.feed().errors[0].path,rel);
 c.write(rel,'---\ntitle: 示例\n---\n正文');assert.equal(c.publish(rel).published,true);assert.equal(c.feed().items[0].body,'正文');assert.ok(events.some(e=>e.t==='feed_updated'));
 c.write('data/ideas/点子.md','## 好点子\n- 💡 **试试看**：说明\n  > 具体请求');assert.equal(c.publish('data/ideas/点子.md').groups,1);assert.equal(c.ideas().groups[0].items[0].reply,'具体请求');
 c.write('data/library/misplaced/report.html','<h1>Invisible</h1>');assert.throws(()=>c.publish('data/library/misplaced/report.html'));
});
test('gateway reconnect observes the accepted run without resending or guessing from the newest chat',async()=>{
 let sends=0,waits=0;const chat=new GatewayChat({request:async(method,args)=>{if(method==='chat.send'){sends++;return {runId:'one'}}assert.equal(method,'agent.wait');assert.equal(args.runId,'one');waits++;return {status:'ok',terminalReply:{disposition:'visible',text:'真实完成结果'}}}});
 const done=chat.respond('只执行一次',{id:'one',sessionKey:'main'});await Promise.resolve();chat.disconnect();assert.equal(chat.pending.size,1);chat.recover();assert.equal((await done).text,'真实完成结果');assert.equal(sends,1);assert.equal(waits,1);
});
