# 0.8 SDK 活动运行

主聊天使用长期打开的 AsyncIterable prompt，忙时输入直接 push，同轮下一次模型请求可见；不使用应用消息队列。SDK 可能将插话放到工具结果的提醒中。可复现实验是 `test/sdk-interjection.test.mjs`，完整 HTTP/WS 演示是 `scripts/verify-v08.mjs`。

主线程 busy 的释放仍以 `session_state_changed.idle` 为准，result 可能先于后续原生通知回合。原生 `background_tasks_changed` 是完整集合，和主线程 busy 分开；保持 `perTaskStopAffordance:true`，interrupt 不停止别的 fork。独立定时会话不使用主线程分派，后台需要说话时调用同一个 `mcp__doudou__say`。

活动索引与主聊天步骤持久化至 `system/activity-index.json`；原生 SDK transcript 限定在此数据根的 system/sessions 中读取。重建查询时清运行集合，索引中未结束记录改为 stopped，续聊使用 SendMessage、resume 或保存的活动上下文。权限、200K 和内置压缩沿现有策略，详细 App 协议见 [v08-cloud.md](v08-cloud.md)。
