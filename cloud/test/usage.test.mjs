import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageService, tavilyUsage, totalUsage } from '../src/usage.mjs';
import { ConnectorManager } from '../src/connectors.mjs';
import { Providers, readProviders } from '../src/providers.mjs';
import { speechProvider } from '../src/transcribe.mjs';

const body = (used, limit = 1000) => ({ account: { plan_usage: used, plan_limit: limit, paygo_usage: 0, paygo_limit: 0 }, key: { usage: used, limit: null } });
const ok = data => new Response(JSON.stringify(data));

test('remaining credits are summed with a weighted ratio; a missing account stays visibly partial', () => {
  const a = tavilyUsage(body(250)), b = tavilyUsage(body(1000, 2000));
  const sum = totalUsage([a,b]);
  assert.equal(sum.items[0].remaining, 1750); assert.equal(sum.items[0].limit,3000);
  assert.equal(sum.items[0].fraction,1750/3000);
  const partial = totalUsage([a,{status:'error',message:'unavailable',items:[]}]);
  assert.equal(partial.status,'partial'); assert.match(partial.message,/1\/2/);
  assert.equal(partial.items[0].remaining,750);
  assert.throws(()=>tavilyUsage({account:{plan_usage:5}}));
  assert.equal(tavilyUsage(body(1200)).items[0].remaining,0);
});

test('concurrent readers share requests; rotation invalidates cache; upstream errors never leak credentials', async () => {
  let requests=0;
  const usage = new UsageService({request:async()=>{requests++; await new Promise(r=>setTimeout(r,5)); return ok(body(300));}});
  const account={id:'a',values:{apiKey:'synthetic-tavily-a'}};
  const [a,b]=await Promise.all([usage.connector('tavily',account),usage.connector('tavily',account)]);
  assert.equal(requests,1); assert.deepEqual(a,b);
  await usage.connector('tavily',account); assert.equal(requests,1);
  await usage.connector('tavily',{...account,values:{apiKey:'synthetic-tavily-b'}}); assert.equal(requests,2);
  usage.request=async()=>{throw new Error('synthetic-secret-in-upstream-error');};
  const error=await usage.connector('tavily',{id:'bad',values:{apiKey:'synthetic-key'}});
  assert.equal(error.status,'error'); assert.doesNotMatch(JSON.stringify(error),/synthetic/);
});

test('unsupported connector quotas make no network calls and known Wind exhaustion remains explicit', async () => {
  const usage=new UsageService({connectors:{readState:()=>({})},request:()=>assert.fail('no billing endpoint')});
  for(const name of ['wind','amap']) {
    const result=await usage.connector(name,{id:'a',values:{apiKey:'synthetic'}});
    assert.equal(result.status,'unsupported'); assert.equal(result.items.length,0);
  }
});

test('provider balances use official fixed hosts and never forward a key from a custom proxy', async () => {
  const seen=[];
  const usage=new UsageService({request:async(url,options)=>{seen.push([url,options.headers.authorization]);return ok({balance_infos:[{currency:'CNY',total_balance:'12.34'}]});}});
  const p={id:'d',baseUrl:'https://api.deepseek.com/v1',apiKey:'synthetic-model-key'};
  assert.equal((await usage.provider(p)).items[0].remaining,12.34);
  assert.equal(seen[0][0],'https://api.deepseek.com/user/balance');
  const unsupported=await usage.provider({...p,id:'custom',baseUrl:'https://example.com/v1'});
  assert.equal(unsupported.status,'unsupported'); assert.equal(seen.length,1);
  assert.equal((await usage.provider({...p,id:'z',baseUrl:'https://zenmux.ai/api/v1'})).status,'credentials');
  assert.equal(seen.length,1);
});

test('management credentials persist privately, stay out of model/public data, and are not sent for inference', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'doudou-usage-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const connectors=new ConnectorManager({root,definitions:[]}); const probes=[];
  const providers=new Providers({root,connectors,selected:()=>({provider:'other'}),probe:async input=>{probes.push(input);return {ok:true};}});
  const saved=await providers.create({name:'Sample ZenMux',protocol:'openai',baseUrl:'https://zenmux.ai/api/v1',apiKey:'synthetic-inference-key',managementKey:'synthetic-management-key',models:[{id:'sample',name:'Sample'}]});
  assert.equal(saved.hasManagementKey,true); assert.doesNotMatch(JSON.stringify(saved),/synthetic-/);
  assert.equal(probes[0].managementKey,undefined);
  const patched=await providers.patch(saved.id,{managementKey:''});
  assert.equal(patched.hasManagementKey,true);
  await providers.patch(saved.id,{name:'Renamed',baseUrl:saved.baseUrl,protocol:saved.protocol,models:saved.models.map(({id,name})=>({id,name})),managementKey:'synthetic-rotated-management-key'});
  assert.equal(probes.length,1,'editing billing credentials must not call an exhausted inference account');
  assert.equal(fs.statSync(path.join(root,'system/providers.json')).mode&0o777,0o600);
  assert.equal(connectors.redact('synthetic-management-key'),'••••');
});

test('the former built-in account migrates once and can be edited/deleted without reappearing or retaining speech access', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'doudou-provider-migration-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const connectors=new ConnectorManager({root,definitions:[]});
  const providers=new Providers({root,connectors,selected:()=>({provider:'another'}),probe:async()=>({ok:true})});
  assert.equal(readProviders(root).filter(p=>p.id==='zenmux').length,1);
  await providers.patch('zenmux',{apiKey:'synthetic-updated-key',managementKey:'synthetic-management-key',name:'My ZenMux'});
  assert.equal(speechProvider(root).apiKey,'synthetic-updated-key');
  await providers.remove('zenmux');
  assert.equal(readProviders(root).length,0);
  assert.equal(readProviders(root).length,0);
  assert.throws(()=>speechProvider(root),/请先添加/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'system/providers.json'),'utf8')).version,2);
});

test('deleting the active card selects a configured replacement, while deleting the final configured account is refused', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'doudou-active-card-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let selected={provider:'zenmux',id:'anthropic/claude-haiku-5.5'};
  const providers=new Providers({root,connectors:new ConnectorManager({root,definitions:[]}),selected:()=>selected,select:m=>{selected=m;},probe:async()=>({ok:true})});
  await providers.patch('zenmux',{apiKey:'synthetic-default-key'});
  const added=await providers.create({name:'Sample',baseUrl:'https://api.deepseek.com/v1',apiKey:'synthetic-sample-key',protocol:'openai',models:[{id:'sample',name:'Sample'}]});
  assert.deepEqual(selected,{provider:added.id,id:'sample'});
  selected={provider:'zenmux',id:'anthropic/claude-haiku-5.5'};
  await providers.remove('zenmux');
  assert.deepEqual(selected,{provider:added.id,id:'sample'});
  await assert.rejects(providers.remove(added.id),/至少保留/);
  assert.equal(readProviders(root).length,1);
});
