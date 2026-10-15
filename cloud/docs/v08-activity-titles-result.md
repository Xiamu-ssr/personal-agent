# v08-cloud：活动标题和首次聊天气泡 result

已修复新活动标题与首次聊天触发消息的展示。没有修改已有活动标题或迁移数据；版本仍为 0.8.0。

确认修复前云端确实会将 `[第一次聊天] 设备：mac|android` 作为 WS user 事件推给 App，聊天历史也会返回该用户记录。现在首次触发原文仍交给模型，并保留为 source 为 onboarding 的内部记录，用于去重和会话恢复；不再发送这个 user 事件，HTTP 聊天历史与 WS hello.history 也不返回它。正常用户输入和豆豆的 say、普通正文照常显示。首次聊天的设备校验、并发去重和重复调用行为保留。

## 活动标题

新活动在创建时统一转换触发首行，运行中列表、完成列表、详情和 activity 事件使用友好名称：

| 触发 | 标题 |
| --- | --- |
| `[第一次聊天]` | 第一次聊天 |
| `[动态]` | 看看有没有新动态 |
| `[目标跟进] X` | 跟进目标：X |
| `[点子]` | 想一批点子 |
| `[夜间整理]` | 夜间整理 |
| `[补读] X` | 补读 X |

设备信息、上次时间和后续提示词正文不进入标题。主聊天与独立后台均已接入；旁聊自动标题使用相同规则，显式指定标题保留。普通聊天仍取原来的消息摘要，未知方括号及正文中提到触发词不会被当作内部触发。旧活动读取、重启后读取和续聊均保留原标题。

协议仅在 [v08-cloud.md](v08-cloud.md) 文末追加「0.8 补充：活动标题与首次聊天」，HTTP/WS 路径及字段未变。App 继续直接使用服务端标题，无需自行解析触发词或隐藏 onboarding 气泡。

## 验证

- `cd cloud && npm test`：**180/180 通过**，0 失败、取消、跳过，包含 browser 与旁聊测试。
- 项目全部 `.mjs` 的 `node --check`：**105/105 通过**，排除依赖、数据与备份目录。
- `git diff --check -- cloud`：通过。
- 新增 5 项测试，覆盖六类触发在主聊天/后台各出口的标题、完整模型输入不变、普通摘要/未知方括号/旁聊自定义标题、旧标题读取和续聊、内部首次触发与可见消息区分。
- 补强既有首次聊天和 HTTP/WS 测试：模型仍收到原始 mac/android 触发；已有 WS 不收到 onboarding user；首次触发后的新 WS hello.history 与 HTTP history 都为空；豆豆第一句出现后可正常读取，chatEmpty 和重复触发保护仍有效。

完整测试日志：`/tmp/v08-cloud-demo/activity-titles/npm-test.log`。这次验证使用临时数据根、假模型及本地 HTTP/WS，不声称已经部署或重新验收安卓/Mac 截图。

## 本轮文件

- 新增 src/activity-title.mjs、test/activity-title.test.mjs、本 result。
- 修改 src/agent.mjs、src/say.mjs、test/harness.test.mjs、test/http-tasks.test.mjs、docs/v08-cloud.md。

保留上一轮尚未提交的旁聊改动，没有修改 spec、browser 模块、Android、Mac 或其他 worker 输出。没有 commit/push/tag、部署、SSH 或密钥文件读取。
