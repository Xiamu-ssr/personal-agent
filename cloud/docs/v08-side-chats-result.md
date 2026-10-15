# v08-cloud：旁聊补充 result

已补齐创建旁聊、独立记录和活动续聊。协议仅在 [v08-cloud.md](v08-cloud.md#08-补充新建旁聊) 文末新增「0.8 补充：新建旁聊」，原有正文逐字保留；没有破坏性协议变更。版本仍为 0.8.0。

## 实现和 App 对接

- `POST /api/side-chats {text,attachments?,title?}`：201 返回 `{ok:true,id,chatType:"side"}`，id 是活动 id。首次消息随创建请求发出，SDK 不恢复主聊天或其他旁聊的会话。
- 后续继续使用 `/api/activities/<id>/{history,send,stop}`。同一旁聊始终使用同一活动 id；运行中的补充送进自己的输入流，完成后续聊恢复自己的 SDK session。
- 活动列表、state/hello 的活动列表、activity 事件新增可选 `chatType:"side"`。App 筛选这个字段即可展示旁聊列表，沿用原分页。
- 详情保留原有 items，旁聊额外返回 messages，包含用户消息、say、普通正文、卡片和选项消费状态。工具和步骤仍在 items。
- 新增 WS `activity_message`，用 activityId 定位旁聊、消息 id 去重。旁聊的 say、普通正文和异常都进入自己的记录；主聊天 history、user/say/delta/turn_end、主聊天 reply 通知不接收它们。
- 原有 HTTP/WS 选项请求只新增可选 activityId，旁聊点选时填写。返回 id 仍是用户回复消息 id，另带 activityId/chatType。整组选项一次消费，跨 App 并发和重启后仍失效；省略 activityId 继续使用主聊天选项。
- `system/side-chats/<id>/chat.jsonl` 和 options.json 持久化旁聊气泡与选项；activity-index 和 SDK 会话继续按原机制保存。若 SDK 会话文件不可用，只从当前旁聊记录构建恢复上下文。
- 主聊天 busy、输入流和首次聊天判空保持原义。共享记忆、数据、权限和浏览器仍可使用；独立活动并发上限仍为一个，避免新增多个常驻 SDK 进程。

## 验证

- `cd cloud && npm test`：**175/175 通过**，0 失败、取消、跳过；含 browser 测试。新增 7 项：6 个 HTTP/WS/持久化测试和 1 个真实 SDK 测试。
- 全部项目 `.mjs` 的 `node --check`：**103/103 通过**，排除依赖、数据和备份目录。
- `git diff --check -- cloud` 通过；脚本比较确认当前协议以 HEAD 原文完整开头，仅追加补充。
- 校验覆盖创建鉴权/参数/附件、主聊天忙时另开旁聊、选项和卡片归属、重复点击、WS 路由、重启续聊、输入在 query 启动前及 result/idle 边界到达、异常仍在旁聊、主聊天空状态不受旁聊影响。

真实 SDK + 回环假模型的可复现演示：

```sh
cd cloud
node scripts/verify-v08-side-chats.mjs
```

日志：`/tmp/v08-cloud-demo/side-chats/demo.log`、events.jsonl、summary.json。请求证据只保存测试标记是否存在，不保存完整模型请求或环境变量。关键输出：

```json
{
  "ok": true,
  "independentSessions": 3,
  "sideMessages": 8,
  "sideOptionsUsed": true,
  "liveInputReachedModel": true,
  "resumedOwnSessionBeforeAndAfterRestart": true,
  "mainAndSiblingContextExcluded": true,
  "sideEmittedMainSay": false
}
```

3 个独立 session 分别是主聊天、旁聊 A、旁聊 B。模型请求 1/10 只带主聊天标记，2–5/7–9 只带旁聊 A 标记，6 只带旁聊 B 标记；请求 4 已包含工具执行期间送入的旁聊补充。点选和云端 Harness 重建后都恢复 A 原来的 session，主聊天后续请求仍不含 A/B 的标记。旁聊 A 的实际 MCP say 和普通正文都保存到自己的气泡记录。

## 改动文件与限制

修改：src/agent.mjs、src/say.mjs、src/server.mjs、src/task-history.mjs、docs/v08-cloud.md。

新增：test/side-chats.test.mjs、test/sdk-side-chats.test.mjs、scripts/verify-v08-side-chats.mjs、本 result。

没有修改 browser 模块、spec、Android、Mac 或其他 worker 文件；没有 commit/push/tag、部署、SSH 或密钥文件读取。本次是本地假模型与真实 SDK 验证，尚未连接真实 App 或线上模型服务。旁聊不新建专用后台系统通知协议；App 通过 activity_message 和活动列表更新旁聊。

给 lead / App worker：新增入口在旁聊创建时使用，随后沿用活动接口；旁聊聊天视图读取 history.messages，监听 activity_message；选项只在旁聊中带 activityId。工具仍叫 `mcp__doudou__say`，模型参数不变，云端负责归属，不需要模型填写会话 id。
