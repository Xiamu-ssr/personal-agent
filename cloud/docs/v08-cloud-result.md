# v08-cloud result

第二轮已完成权限调整、浏览器接线和内存隔离，最新结果见 [v08-cloud-browser-result.md](v08-cloud-browser-result.md)。下文保留第一轮验收记录；其中动态说明只读、浏览器待接入及 155 个测试是当时状态，已由第二轮结果更新。

本地实现已完成，版本 0.8.0；等待 lead 集成审阅。当前 App 对接依据为 [v08-cloud.md](v08-cloud.md)。未 commit、push、tag 或部署，未访问服务器、真实账号或密钥文件；未改 spec、Android、Mac、头像素材或 browser worker 的文件。

## 0. 轮中插话实验

结论：锁定的 Claude Agent SDK **0.3.295 支持**向正在进行的一轮追加 AsyncIterable 用户输入。按要求先完成这个实验，再实现云端功能，没有改用其他方案。

`test/sdk-interjection.test.mjs` 启动真实 SDK CLI 与本地假 Anthropic 服务。在第一个 Read 的 PreToolUse 尚未结束时追加消息，接着执行第二个 Read。下一次模型请求已经含有新消息，而且尚无 result：

```json
[
  {"request":1,"seesInterjection":false,"resultsBeforeRequest":0},
  {"request":2,"seesInterjection":true,"resultsBeforeRequest":0},
  {"request":3,"seesInterjection":true,"resultsBeforeRequest":0}
]
```

完整 Harness/HTTP/WS 演示也验证了这一点。SDK 有时把插话嵌在 tool_result 的提醒中；不能只在顶层 user 文本里查找。插话不取消已经发出的模型请求或正在执行的工具，在下一次请求中生效。

## 1–7. 改动摘要

1. **说话**：新增进程内 MCP server `doudou` / 工具 `say`，模型实际工具名 `mcp__doudou__say`。每次调用独立持久化、广播一个气泡，支持一次性 options 和所有规定卡片。整组选项消费状态持久化，并发点击只有一次成功，重复点击 409。普通正文仍形成气泡；delta 与完成后的 say 共用 id。工具与中间步骤只进入活动。原生 fork 的 say 通过 MCP 的 `claudecode/toolUseId` 精确关联自己的活动，有真实 SDK 回归验证。
2. **忙时插话**：HTTP 和 WS 都直接交给当前 Inbox/AsyncIterable，立即记录用户消息。删除用户消息排队、撤回、修改接口与状态。保留的 inputChain 只用于串行准备输入，后台 jobChain 用于限制独立模型进程数量，均不是忙时用户队列。
3. **头像与活动**：支持 idle/working/waiting/happy/error，working 从工具推导中文状态，happy 约三秒。主聊天、后台模型运行、原生 fork 和健康/清理等维护均记录活动；聊天插话归入同一活动。详情含原交代、工具、说话和结果，保存在 `system/activity-index.json`。支持活动停止、续聊、附件及重启后的恢复；父会话仍在时可继续原生 fork，否则用持久化上下文隔离续聊。
4. **目录与迁移**：新建 feed、ideas、goals/done、library/artifacts、library/media、soul/diary 等目录；角色迁至 soul。启动运行 `migrate-v08.mjs`，先备份源文件、聊天和安排，再移动；写入一次性 marker，不留旧路径别名。聊天补消息 id、移除旧结果卡片、重写旧交付链接；原活动索引也迁移。冲突、损坏配置、源符号链接会在迁移前报错。守卫增加 health/uploads 和动态说明只读。
5. **删除简报**：移除晨报、晚报、健康周报、「今日」对应的简报实现、渲染器、skin/CSS、按钮脚本、briefGuideFile 引用、简报接口及专用测试。截图改为只处理 library/artifacts 内页面，继续保留离线截图、尺寸/体积和路径限制。
6. **定时安排**：动态默认 07:00–23:00、每 30 分钟，支持 15/30/60、跨午夜时段和开关；单次运行锁涵盖等待执行阶段；固定 Haiku 5.5，上次时间只在成功后更新。目标 cadence 自动扫描，下一次检查生效；点子周一 08:00；night 保留 id、22:30；健康每三小时。动态/目标/点子每次读取 spec/prompts。所有独立后台模型运行不占主聊天，后台需要告知用户时调用 say。
7. **App 接口与协议**：提供动态分页/详情/反馈/设置/刷新、点子解析/点击/换批、目标列表/详情、资源库及缩略图、活动、定时和记忆接口；空聊天 first-chat 按设备发固定触发消息，并发只启动一次。每条 say 沿用在线设备通知通道。完整字段、JSON 示例、文件格式和删除列表已写入 v08-cloud.md。package 与 lock 版本均为 0.8.0。

## 删除项

- HTTP：`/api/briefs`、`/api/briefs/item`、`/api/jobs`、`/api/tasks/<id>/{history,send,stop}`、`/api/run`、`/api/profile`。
- WS/状态：unqueue、edit_queued、queue_update、stop_task、task_stop、hello.queued、hello.tasks、旧 job/结果卡片。当前协议改用 activities、activity、background_activities。
- 源码：`src/briefs.mjs`、`brief-base.css`、`brief-button.js`、`profile.mjs`、`migrate-v06.mjs`、`schedule-prompts-v05.mjs`。
- 旧脚本：`scripts/migrate-0.5.mjs`、`verify-v06.mjs`。
- 专用测试/fixture：`briefs.test.mjs`、`migrate-0.5.test.mjs`、`schedule-fork.test.mjs`、`schedule-migration-v06.test.mjs`、`prompt-v05.test.mjs`、`v06-fixtures.mjs`；混合测试中同步移除简报、排队、旧头像设置用例。
- 迁移后删除旧运行目录 briefs/sites/files/diary、旧角色路径、旧 profile 设置、jobs.jsonl、旧健康 latest.json；备份中保留原件。
- 历史 `docs/v04`、`v05`、`v06` 保留为历史资料，不作为当前协议；旧 App 协议入口已指向 0.8。没有修改 lead 负责的 `spec/prompts/brief-guide.md`。

## 验证

| 检查 | 结果 |
| --- | --- |
| `cd cloud && npm test` | 155 个测试，155 通过，0 失败、取消、跳过 |
| 全部 `.mjs` 的 `node --check` | 92/92 通过，排除 node_modules 和 Git 元数据 |
| `git diff --check -- cloud` | 通过 |
| `node cloud/scripts/verify-v08.mjs` | 真实 SDK + 假模型 + HTTP/WS 演示通过 |

测试覆盖 say 事件、选项消费和重启、工具期间插话、头像转换及维护失败、旧目录备份迁移/幂等/冲突、动态窗口/间隔/跳过/模型/上次时间、目标 cadence 增删改、点子点击、反馈与讨论、首次聊天；同时保留连接器、健康、附件、模型配置、压缩、原生 fork 的停止/重建/续聊、活动分页和文件服务等回归。全量测试包含工作区里 browser worker 已提供的测试；本 worker 未修改浏览器模块。

提示词测试断言结构、文件读取与占位符替换，不锁定 lead 正在修改的具体措辞。

## 本地演示

可复现命令（仓库根目录）：

```sh
node cloud/scripts/verify-v08.mjs
```

只使用独立临时数据根和本地假模型，不使用正在运行的用户数据根。日志位于 `/tmp/v08-cloud-demo/`：

- `demo.log`：关键断言；`events.jsonl`：HTTP/WS 交互事件。
- `requests.json`：请求序号、model、插话可见性、先前 result 数，不保存完整模型请求。
- `summary.json`：结构化验收结果。
- `npm-test.log`、`node-check.log`：最终测试与语法检查结果。

关键输出：

```text
busy interjection accepted while Read is running; results=0
say #1: 我先看一下，稍后再跟你说。
say #2: 补充已经收到了，要继续吗？; options=继续/先等一下
avatar: working -> waiting
option click=200; repeat click=409; reply=DEMO_OPTION_REPLY
ordinary assistant prose preserved as bubble #3
activities: 2 chat rounds; first activity steps=7; interjection and Read recorded
chat model=Opus 5.5; feed wire model=Haiku 5.5; new post event received; main busy=false
```

最终 summary：`ok:true`，SDK 0.3.295，3 个聊天气泡、2 轮聊天活动，第一轮 7 个步骤；插话在 result 前进入模型请求；选项点击状态 `[200,409]`；收到 feed_new；动态 wire model 为 `anthropic/claude-haiku-5.5`。其中 Opus 指演示时已保存的聊天配置；此段演示没有再发一轮普通 Opus 请求，实际聊天模型映射由独立 SDK 模型测试覆盖。

## 变更文件

以下均相对 `cloud/`；删除文件已完整列在上文，不包含其他 worker 的文件。

- 新增模块：`src/say.mjs`、`avatar.mjs`、`content.mjs`、`cron.mjs`、`migrate-v08.mjs`。
- 修改模块：`src/agent.mjs`、`config.mjs`、`conversation-recovery.mjs`、`data-guard.mjs`、`health.mjs`、`main.mjs`、`media.mjs`、`page-screenshot.mjs`、`scheduler.mjs`、`server.mjs`、`task-history.mjs`。
- 配置和种子：`package.json`、`package-lock.json`、`seed/system/schedule.json`；角色种子由 `seed/data/memory/role/角色.md` 移至 `seed/data/soul/角色.md`，新增 `seed/data/feed/动态说明.md`。
- 新增验证：`scripts/verify-v08.mjs`、`test/sdk-interjection.test.mjs`、`sdk-say.test.mjs`、`sdk-v08.test.mjs`、`migrate-v08.test.mjs`、`prompt-v08.test.mjs`、`v08-content.test.mjs`、`query-fixture.mjs`。
- 修改测试/fixture：`test/attachments.test.mjs`、`harness.test.mjs`、`http-tasks.test.mjs`、`media.test.mjs`、`native-fixture.mjs`、`page-screenshot.test.mjs`、`runtime-v04.test.mjs`、`scheduler.test.mjs`、`sdk-tasks.test.mjs`、`sdk-v05.test.mjs`、`sdk-v06.test.mjs`、`settings-history.test.mjs`、`v06.test.mjs`。
- 文档：新增 `docs/v08-cloud.md`、`v08-cloud-result.md`；更新 `docs/app-protocol-media.md`、`app-protocol-tasks.md`、`task-runtime.md`。

## 限制与 lead 提醒

1. **系统提示词需对齐动态说明的写权限。** 当前系统提示词的目录表、动态一节及首次聊天第 5 步仍要求豆豆修改 `data/feed/动态说明.md`。本次任务明确要求只有 App 可改，云端已严格拒绝 agent 写入；请把相应流程改成引导用户在 App 编辑，避免模型不断尝试被守卫拒绝的写操作。
2. 模型工具实际名称为 `mcp__doudou__say`。首次聊天触发 `[第一次聊天] 设备：android|mac`；动态首行 `[动态]` 或 `[动态] 上次：YYYY-MM-DD HH:MM`；目标 `[目标跟进] <目标名>`；点子 `[点子]`。trigger 文件实时读取；system-prompt 在会话创建/重建时读取。点子提示词现在已使用新路径，无需再改云端。
3. `turn_end` 是生命周期/普通正文摘要，不能再据此新增结果气泡；App 需按消息 id 合并 delta/say，消费 options_used。释放忙状态仍以 SDK session_state_changed.idle 为准，不能以 result 推断 idle。
4. browser 卡片及 `system/browser/` 已预留。浏览器 MCP、控制端点和页面接管由 browser worker/lead 接入，本 worker 未挂载或改动那些模块；App 的实时画面对接未在本任务验证。
5. 没有真实生产数据、真实模型网关、Android/Mac 设备、通知权限或线上部署验收。迁移验证使用模拟旧目录；真实数据启动前应由 lead 检查备份和冲突。迁移没有中断自动回滚，异常时可依据完整备份人工恢复；旧媒体按原结构移入 library/media，不伪造缺失日期。
6. agent 文件守卫是工具层约束，Bash 为保守命令检查，不是 OS 沙箱。独立后台模型会话受现有内存边界串行执行，但与主聊天独立；等待阶段即持有单次安排锁。
7. 健康等非模型维护活动可以列出和查看，但执行中不支持单独中断，停止返回 409。手机离线时保留数据，并在活动结果中记录实际原因。设备在线通知沿用现有通道，没有新增独立离线推送服务。
