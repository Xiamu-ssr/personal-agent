import "./environment.mjs";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {validateBrief} from "../src/briefs.mjs";
import {runScheduledTask} from "../src/scheduler.mjs";

test("business prompt keeps persona/memory, removes format and duplicate Agent instructions; guide is appended only to brief schedules",async()=>{
  const prompt=fs.readFileSync(new URL("../../spec/prompts/system-prompt.md",import.meta.url),"utf8");
  assert.match(prompt,/claude_code.*preset|claude_code.*预设/);
  assert.match(prompt,/data\/briefs\/<YYYY-MM-DD>\/<任务名>\.html.*简报写法/);
  assert.doesNotMatch(prompt,/简报最小示例|subagent_type|run_in_background|简报格式|子 agent 看不到|简报[^\n]*\.json/);
  assert.match(prompt,/data\/memory\/profile\/总档\.md/);assert.match(prompt,/只记事实/);
  const guide=fs.readFileSync(new URL("../../spec/prompts/brief-guide.md",import.meta.url),"utf8");
  assert.equal(validateBrief(guide.match(/```html\n([\s\S]*?)\n```/)[1]).error,undefined);
  for(const term of ["360px","320–480px","560px","mist","mint","dusk","chip","timeline","tiles","metrics","note","data-prompt"]) assert.ok(guide.includes(term));
  const jobs=JSON.parse(fs.readFileSync(new URL("../seed/system/schedule.json",import.meta.url),"utf8"));
  const sent=[];const h={send:async(...args)=>sent.push(args)};
  for(const id of ["morning","evening","health-weekly"]) {
    const job=jobs.find((j)=>j.id===id);assert.doesNotMatch(job.prompt,/JSON|简报格式|section|class=/);
    assert.match(job.prompt,/data\/briefs\/<YYYY-MM-DD>\/<任务名>\.html/);
    await runScheduledTask(h,job);assert.equal(sent.at(-1)[0],job.prompt+"\n\n"+guide.trim());
  }
  await runScheduledTask(h,{id:"custom",prompt:"用户写的定时消息"});assert.equal(sent.at(-1)[0],"用户写的定时消息");
});
