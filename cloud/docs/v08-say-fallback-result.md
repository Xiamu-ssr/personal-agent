# v08-cloud：say 正文兜底规则 result

已修复 say 后的模型旁白进入聊天的问题。主聊天与旁聊都按各自当前轮次判定，不受另一会话的 say 影响；忙时插话和进入同一运行的选项回复不重置标记。没有修改 SDK 轮次边界、输入流或会话调度。

## 行为

- 通过 say 发出过气泡后，本轮普通正文只进活动记录，不进入聊天，包括 say 之前的正文和之后的收尾旁白。say 气泡仍立即发出，可连续多次调用，选项不被旁白覆盖。
- 完全没有使用 say 时，普通正文在轮结束后进入聊天，带 `fallback:true`。多个 assistant 消息仍分别生成气泡；下一轮重新判定。主聊天原有只有 result.result、没有 assistant 正文时的兜底也保留。
- 正文收到后立即写入活动步骤，同时暂存待判定的聊天内容。之后使用 say 会清空暂存，未使用则结束时发出兜底。这能避免先写正文、随后调用 say 时，前面的正文已经泄漏进聊天。
- `said` 仅记录真正的 say 气泡，fallback 和云端异常提示不计作工具说话。普通正文的活动步骤只记一次；异常提示仍按既有 error 规则处理。
- 旁聊的聊天消息仍只通过 activity_message 和该旁聊 messages 提供，不进入主聊天或主聊天通知。后台独立运行沿用同样的正文判定。

## 协议说明

已同步 [v08-cloud.md](v08-cloud.md) 的 say、WebSocket 和旁聊章节。没有增删 HTTP/WS 路径、事件名或字段，需注意以下行为更新：

- 主聊天普通正文不再边生成边发送 delta；确认整轮没有 say 后，发送完整正文 delta，再用同 id、`fallback:true` 的 say 完成气泡。用过 say 的轮次没有普通正文 delta。
- 用过 say 且没有异常的 turn_end 保留完成信号，text 为空、不带 media；内部收尾正文只留活动记录。没有 say 时保留兜底正文摘要。App 继续按既有约定处理 turn_end，不创建额外气泡。
- 旁聊 messages 中只保留正式 say 或没有 say 时的兜底；普通正文始终可在活动 items 中查看。

## 验证

| 检查 | 结果 |
| --- | --- |
| `cd cloud && npm test` | **189/189 通过**，0 失败、取消、跳过 |
| 主聊天、旁聊、真实 SDK、媒体相关定向测试 | **35/35 通过** |
| 全部 `.mjs` 的 `node --check` | **106/106 通过**，排除依赖目录 |
| `npm run check` | 通过 |
| `git diff --check -- cloud` | 通过 |

新增 5 个测试，更新已有相关断言。覆盖 say 前后正文不进聊天、流式正文不提前显示、忙时插话不重置、多个 say 保留独立气泡及 waiting 选项、下一轮无 say 恢复兜底、多个兜底气泡、result-only 兜底、活动持久记录无重复、主聊天与旁聊并发不串标记。真实 SDK 使用本地假模型复现“正文 → say → 收尾旁白”，并验证下一轮无 say 的回复；原有真实 SDK 旁聊测试也确认工具间插话后的旁白只留活动、下一次续聊可正常兜底。

验证日志在 `/tmp/v08-cloud-demo/say-fallback/`：`npm-test.log`、`targeted-tests.log`、`node-check.log`、`checks.log`。

## 文件与边界

- 实现：`src/agent.mjs`。
- 测试：`test/harness.test.mjs`、`side-chats.test.mjs`、`sdk-say.test.mjs`、`sdk-side-chats.test.mjs`。
- 文档：`docs/v08-cloud.md` 和本 result。
- 未删除功能或增加兼容层，未修改 spec、浏览器模块、Android、Mac 或其他 worker 输出。

本轮没有连接线上 GLM 5.3 Flash、服务器或真实账号，也没有读取密钥、部署、commit/push/tag。线上模型的复测由 lead 部署后执行；当前验证覆盖相同 SDK 消息与 MCP 工具链路。系统提示词仍可要求优先使用 say，本次保证由云端执行，不依赖模型遵守措辞。
