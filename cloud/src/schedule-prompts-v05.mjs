// Frozen prompt baseline from dfb3262~1:cloud/seed/system/schedule.json (v0.5).
// Startup migration compares exact strings; it never reads git or normalizes user edits.
export const V05_SCHEDULE_PROMPTS=Object.freeze({
  "morning": "给用户做今天的晨报。内容按这个顺序，读不到的写「暂不可读」和原因：\n1. 今天的日程（设备日历或日历连接器）\n2. 天气：用记忆里的常住城市搜索今天的天气，提醒带伞/加衣\n3. 昨晚到现在的重要消息和通知（只挑需要用户处理的）\n4. 你从记忆里想到的今天该提醒的事（生日、截止日、承诺过的事）\n先读总档。写到 data/briefs/<YYYY-MM-DD>/<任务名>.html。",
  "evening": "给用户做今天的晚报：今天发生了什么（日程、消息、你帮忙做过的事）、还没处理完的事、明天要注意的。先读总档。写到 data/briefs/<YYYY-MM-DD>/<任务名>.html。",
  "health-weekly": "做本周的健康周报：睡眠、步数、心率等能从设备读到的数据，和上周对比，给一条最值得改的建议。数据读不到就写读不到，不要编。顺手更新 data/memory/health/ 里对应的文件。写到 data/briefs/<YYYY-MM-DD>/<任务名>.html。顺手写 data/memory/health/latest.json，格式 {updated,metrics:[{key,label,value,unit}]}，updated 用 ISO 时间；只写实际读到的睡眠、静息心率、步数、心率变异性，没有数据就用空 metrics。",
  "night": "[夜间整理]\n按系统提示词里「系统发起的会话 · 夜间整理」的四步做：检查记忆、重写总档、整理工作区、写日记。"
});
