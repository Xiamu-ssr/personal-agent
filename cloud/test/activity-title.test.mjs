import test from 'node:test';
import assert from 'node:assert/strict';
import { triggerTitle } from '../src/activity-title.mjs';
test('native scheduled triggers have concise product titles',()=>{
 assert.equal(triggerTitle('[Goal 推进] 运动'),'跟进目标：运动');
 assert.equal(triggerTitle('[点子]'),'想一批点子');
 assert.equal(triggerTitle('[心跳]'),'继续未完成的事');
 assert.equal(triggerTitle('普通消息'),null);
});
