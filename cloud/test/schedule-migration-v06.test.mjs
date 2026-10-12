import {testRoot} from "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {CODE} from "../src/config.mjs";
import {migrateV06} from "../src/migrate-v06.mjs";
import {V05_SCHEDULE_PROMPTS} from "../src/schedule-prompts-v05.mjs";

const seedDir=path.join(CODE,"seed");
const seedJobs=JSON.parse(fs.readFileSync(path.join(seedDir,"system/schedule.json"),"utf8"));
const oldJobs=()=>seedJobs.filter((j)=>j.id!=="health-sync").map((j)=>({
  ...j,...(Object.hasOwn(V05_SCHEDULE_PROMPTS,j.id)&&{prompt:V05_SCHEDULE_PROMPTS[j.id]}),
}));
function fixture(jobs) {
  const root=fs.mkdtempSync(path.join(testRoot,"schedule-migration-")),file=path.join(root,"system/schedule.json");
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(jobs));
  return {root,file};
}

test("v0.5 default schedule upgrades morning/health-weekly prompts, adds health-sync and is idempotent",()=> {
  const before=oldJobs(),{root,file}=fixture(before);
  assert.equal(before.length,6);assert.match(before.find((j)=>j.id==="health-weekly").prompt,/latest\.json/);
  migrateV06({root,seedDir});
  const after=JSON.parse(fs.readFileSync(file,"utf8"));
  assert.deepEqual(after,seedJobs);
  const changed=after.slice(0,6).filter((j,i)=>j.prompt!==before[i].prompt).map((j)=>j.id);
  assert.deepEqual(changed,["morning","health-weekly"]);
  for(let i=0;i<before.length;i++) {
    const {prompt:oldPrompt,...oldFields}=before[i],{prompt:newPrompt,...newFields}=after[i];
    assert.deepEqual(newFields,oldFields);
  }
  assert.doesNotMatch(after.find((j)=>j.id==="health-weekly").prompt,/latest\.json/);
  const content=fs.readFileSync(file,"utf8"),mtime=fs.statSync(file,{bigint:true}).mtimeNs;
  assert.deepEqual(migrateV06({root,seedDir}),[]);
  assert.equal(fs.readFileSync(file,"utf8"),content);assert.equal(fs.statSync(file,{bigint:true}).mtimeNs,mtime);
});

test("user-edited prompt stays byte-for-byte unchanged while matching prompts migrate without changing cron/enabled or custom tasks",()=> {
  const before=oldJobs();
  // Even whitespace alone is a user edit; do not trim or normalize before comparing.
  const morning=before.find((j)=>j.id==="morning");Object.assign(morning,{prompt:morning.prompt+"\n",cron:"5 9 * * *",enabled:false,extra:{user:true}});
  const weekly=before.find((j)=>j.id==="health-weekly");Object.assign(weekly,{cron:"15 19 * * 1",enabled:false});
  const custom={id:"user-custom",name:"用户任务",cron:"0 6 * * *",prompt:V05_SCHEDULE_PROMPTS.morning,enabled:true};before.push(custom);
  const {root,file}=fixture(before);migrateV06({root,seedDir});
  const after=JSON.parse(fs.readFileSync(file,"utf8"));
  assert.deepEqual(after.find((j)=>j.id==="morning"),morning);
  assert.deepEqual(after.find((j)=>j.id==="user-custom"),custom);
  assert.deepEqual(after.find((j)=>j.id==="health-weekly"),{...weekly,prompt:seedJobs.find((j)=>j.id==="health-weekly").prompt});
  assert.equal(after.filter((j)=>j.kind==="health-sync").length,1);
  assert.deepEqual(migrateV06({root,seedDir}),[]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,"utf8")),after);
});
