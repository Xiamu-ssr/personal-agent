import "./environment.mjs";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { validateBrief } from "../src/briefs.mjs";

test("v0.4 prompt keeps the schedule fork rule, has valid brief example/limits, site metadata, service onboarding, Tavily guidance and health snapshot", () => {
  const prompt = fs.readFileSync(new URL("../../spec/prompts/system-prompt.md", import.meta.url), "utf8");
  assert.match(prompt, /data\/briefs\/<YYYY-MM-DD>\/<任务名>\.json/);
  assert.doesNotMatch(prompt, /custom-connectors|自建连接器|briefs\/[^\n]*\.html|95K|100K/);
  const example = JSON.parse(prompt.match(/简报最小示例：`([^`]+)`/)[1]);
  assert.equal(validateBrief(example).error, undefined);
  for (const rule of ["1–5", "28", "80", "timeline", "tiles", "metrics", "list", "note", "ok/warn/info"]) assert.ok(prompt.includes(rule));
  assert.match(prompt, /<title>.*<meta name="description">/);
  assert.match(prompt, /connectors\.list\(\).*暂时还接不了/);
  assert.match(prompt, /fields.*help.*add_account/);
  assert.match(prompt, /在 App 里填表单更安全，聊天记录里会留下授权码/);
  assert.match(prompt, /日常搜索用内置网页搜索.*深入调研.*整篇网页正文.*Tavily/);
  assert.match(prompt, /data\/memory\/health\/latest\.json.*updated,metrics:\[\{key,label,value,unit\}\]/);
  const schedule = prompt.split("\n").find((line) => line.startsWith("- `[定时]"));
  assert.match(schedule, /subagent_type: "fork".*run_in_background: true.*用 Write.*\.json/);
  assert.match(schedule, /完成通知到达后/);
  assert.doesNotMatch(schedule, /不[能许得]改|禁止.*改|只.*转述.*不得/);
});
