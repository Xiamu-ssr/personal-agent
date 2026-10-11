# 后台任务、排队消息与结构化简报（v0.4）

接口沿用现有 Bearer / cookie 鉴权。下面路径是云端服务路径；反向代理对外仍可加 `/agent`。现有字段保留，客户端忽略不认识的新增字段。

## 主会话忙闲与输入

WebSocket `status`：

```json
{"t":"status","busy":true,"reason":"user"}
{"t":"status","busy":true,"reason":"schedule"}
{"t":"status","busy":true,"reason":"task_result"}
{"t":"status","busy":false}
```

- `busy` 表示主线程正在处理当前回复，后台任务另计。`reason` 是可选展示信息，不能用来推断任务数量。
- 后台任务完成会由 CLI 原生通知开新回合，`reason: "task_result"`。这个回合可以直接出现 `delta`、`turn_end`，前面没有 App 的 `user` 事件。
- 每次新回合重置回复、失败、工具使用状态。结果仍保存为 `chat.jsonl` 的 assistant 记录，正常发 `turn_end`。
- **忙闲以 `status` 为准**。`turn_end` 是回复结果；CLI 原生 `idle` 才放行队列，两种信号先后都可能出现。用户在自发回合期间发送的消息按提交顺序排队，轮到派发时才写入 `chat.jsonl`。
- 自发回合发生上下文/压缩失败时，仍显示中文恢复提示并新建会话，保留 `data/` 和待办；不自动重放任务通知。

## 排队消息撤回、修改与重连

所有 `user` 事件都带服务端生成的 `id` 和提交时间 `ts`（毫秒）。客户端用 id 关联当前气泡、排队状态和历史记录：

```json
{"t":"user","id":"message-uuid","text":"帮我安排今天","source":"app","ts":1791580800000,"attachments":[]}
{"t":"unqueue","id":"message-uuid"}
{"t":"edit_queued","id":"message-uuid","text":"帮我安排明天"}
{"t":"queue_update","id":"message-uuid","state":"removed"}
{"t":"queue_update","id":"message-uuid","state":"edited","text":"帮我安排明天"}
{"t":"queue_update","id":"message-uuid","state":"too_late"}
```

- `removed` / `edited` 广播给所有在线 App；`too_late` 只发给请求方，提示「豆豆已经在看这条了」。已经派发、已经结束、不在队列里的 id 均返回 `too_late`。闹钟消息不可用用户撤回/修改操作处理。
- 修改只改 text（去首尾空白），保留附件、id、source、ts 和排队位置。没有附件时不接受空文本；字段错误返回 `{"t":"error","error":"中文原因"}`。
- 撤回不进历史；修改只把最终文本写入历史。上下文恢复自动重试同一条消息时，仍使用原 id，不重复写 user 记录。
- `POST /api/send` 成功返回 `{"ok":true,"id":"message-uuid"}`，WS `send` 的 id 从广播的 `user` 事件取得。
- WS 重连的 `hello` 新增 `queued`，只包含尚未派发的用户/闹钟 envelope；按提交顺序展示。先恢复 history，再按 id 合并 queued；实时收到 user 时加入，`status` 控制忙闲与派发后的展示。

```json
{"t":"hello","busy":true,"tasks":[],"devices":[],"history":[],"queued":[{"id":"message-uuid","text":"帮我安排明天","source":"app","ts":1791580800000,"attachments":[]}]}
```

队列属于当前服务进程，重建 SDK query 不会丢失；服务进程重启不恢复未派发队列。当前处理中的用户记录已进入 history，不出现在 queued。

## 当前后台任务

`GET /api/state` 和 WS 初始 `hello` 新增同名 `tasks` 字段：

```json
{"busy":false,"tasks":[{"id":"task-id","description":"报价简报","startedAt":1791580800000}]}
```

保留原来的 state / hello 字段。`startedAt` 是服务器首次收到该次运行的时间（毫秒）；任务原生事件没有开始时间字段。列表只含主查询中非 ambient 的 SDK 后台任务（包括 fork）；隔离补读/夜间整理仍使用原来的 `job` 协议。

任务总线继续使用 `t: "task"`：

| phase | 字段 | 客户端处理 |
| --- | --- | --- |
| `snapshot` | `tasks: [{id, description, startedAt}]` | **替换完整列表**；`[]` 清空 |
| `started` | `id, description, startedAt, background: true` | 按 id 幂等加入/更新 |
| `updated` | `id, patch, background: true` | 更新描述/状态；patch 的结束状态不能继续计数 |
| `progress` | `id, description, summary?, background: true` | 更新展示，不增加计数 |
| `notification` | `id, status, summary?, background: true` | `completed` / `failed` / `stopped` 都移除 id |

`updated.patch.status` 为 `completed`、`failed`、`killed` 时是结束状态。不要用 started 次数减 notification 次数计数；按 id 维护列表，以后续 `snapshot` 校准。SDK 规定 level 与 bookend 的相对顺序不保证。中文错误会替代 API/上下文错误摘要，原文经脱敏写日志。

服务/CLI 进程重建时发空 snapshot。运行列表不持久化，不从历史 task/card 记录还原，避免幽灵任务。新 CLI 只有收到新的原生活动列表才重新增加计数。显示“后台还有 N 个任务在跑”的 N 取当前列表长度，可与 `busy: false` 同时成立。

## 停止

现有 WS `{"t":"interrupt"}` 仅停止主查询的当前回复。主查询使用保持打开的流式输入，并声明 `perTaskStopAffordance: true`，后台子 agent / fork 继续运行。它不清空已排队的用户消息或闹钟。

按任务停止：

```json
{"t":"stop_task","id":"task-id"}
```

只向请求的 WS 回应：

```json
{"t":"task_stop","id":"task-id","ok":true}
{"t":"task_stop","id":"task-id","ok":false,"code":"task_ended","error":"任务已经结束"}
```

也可调用 `POST /api/tasks/<URL 编码的 id>/stop`，无需 body。成功 200：`{"ok":true,"id":"task-id"}`；错误：`{"error":"中文说明","code":"..."}`。

| HTTP 状态 | code | 意义 |
| --- | --- | --- |
| 400 | `invalid_task_id` | 缺少/无效 id，或 URL 编码不对 |
| 401 | 现有鉴权错误 | 未登录 |
| 404 | `task_not_found` | 不存在，或不属于当前运行中的主查询后台任务 |
| 409 | `task_ended` / `task_stopping` | 已结束 / 已有停止请求 |
| 502 | `task_stop_failed` | SDK 控制请求失败，可重试 |
| 503 | `session_unavailable` | 主查询暂不可用 |

成功响应表示 SDK 已接受停止控制。最终停止及计数更新以 `task.notification`（`status: "stopped"`）和 snapshot 为准，不根据按钮点击预先删除别的任务。已结束 id 的详细状态只保留最近 256 个，更早的可能返回 404。输入流关闭的一次性 SDK 调用不具有 interrupt 保留后台任务的保证；App 的控制对象是长期保持打开的主查询。

## 简报闹钟与卡片

cron 和 `POST /api/run`（body 沿用 `{"id":"schedule-id"}`）对普通任务/`kind: "brief"` 都调用主会话 send：

```text
[定时] 该出「报价简报」了

任务说明
```

记录与事件沿用 user 形状，新增/使用 `source: "schedule"`：

```json
{"role":"user","id":"message-uuid","source":"schedule","text":"[定时] 该出「报价简报」了\n\n任务说明","ts":1791580800000}
{"t":"user","id":"message-uuid","source":"schedule","text":"[定时] 该出「报价简报」了\n\n任务说明","ts":1791580800000,"attachments":[]}
```

App 可隐藏 schedule 的用户气泡，仍接收随后 assistant 的确认和完成回复。HTTP 手动运行返回 202，保留 `ok: true`，增加 `mode: "alarm"`（维护为 `"isolated"`）；表示已经排队，不表示简报完成。

提示词让主 agent 用 Agent `subagent_type: "fork", run_in_background: true` 派出任务，简短确认；fork 完成的原生通知再次唤醒主会话转述结果并给路径。Write/Edit 写简报 JSON 后，主会话、fork、隔离会话共用 PostToolUse 校验；中文错误返回模型修正。按 `agent_id` 收集有效 JSON outputs，站点继续收集 HTML。完成时发送卡片：

```json
{"role":"card","label":"报价简报","title":"报价简报","path":"data/briefs/2026-10-10/报价简报.json","outputs":["data/briefs/2026-10-10/报价简报.json"],"ok":true,"ts":1791580800000,"taskId":"task-id"}
{"t":"job","phase":"done","role":"card","label":"报价简报","title":"报价简报","path":"data/briefs/2026-10-10/报价简报.json","outputs":["data/briefs/2026-10-10/报价简报.json"],"ok":true,"ts":1791580800000,"taskId":"task-id"}
```

历史回看用 card，实时用 `job.done`；`taskId` 是可选关联字段，`path` 指向这次任务的第一份有效简报 JSON。只产出站点时没有 path。App 用 path 在「今日」定位简报，从 `/api/briefs` 或鉴权 `/files/<path>` 取得 JSON，聊天卡片画第一张卡的 chip/title/summary。失败/停止但有有效产出时 `ok: false`，标题标“未完成”；无有效产出时 fork 不发空卡片。主会话文字回复仍保存/显示，完成通知之后可以继续改简报。

卡片自动收集覆盖 Write/Edit/MultiEdit/NotebookEdit 的文件 hook；Bash 等绕过这些 hook 的写入不会自动产生卡片，所以提示词明确要求简报用 Write。`compact`、`cleanup` 保持原行为；`[补读]`、`[夜间整理]` 保持隔离执行，包括维护任务的手动运行。

## v0.4 HTTP 与设备图片格式

所有路径使用现有 Bearer/cookie 鉴权；外部地址可能有 `/agent` 前缀。新接口的校验错误为 `{error:"中文原因"}`。

| 接口 | 格式 |
| --- | --- |
| `GET /api/briefs?days=7` | `{items:[{date,name,time,path,brief}]}`；date 是 YYYY-MM-DD，time 是 JSON 的 ISO 时间，brief 是完整结构化简报。按 time 倒序，默认近 7 个本地自然日（含今天），days 为 1–365 的整数；无简报返回空 items。无效 JSON/不合 schema 的文件、符号链接不列出。 |
| `GET /api/profile` | `{avatar:{shape:"bean",palette:"mist"}}`；无配置时返回默认值。 |
| `PUT /api/profile` | body 和成功回包都是 `{avatar:{shape,palette}}`。shape: bean/girl/boy/cat；palette: mist/dusk/mint/sakura。两项同时提供；无效值 400，不覆盖原设置。原子保存 `system/app-profile.json`，权限 600。 |
| `GET /api/state` | `{busy,devices,tasks,schedule,firstChat,userCall,agentName}`；删除 model，firstChat 仍为毫秒或 null。 |
| `GET /api/connectors` | `{cloud:{id:"cloud",name:"云电脑",kind:"cloud",online:true,catalog:[...],installed:[...]},devices:[...]}`。每项 `{name,title,description,icon,fields,multiAccount,status}`；installed 另带 `accounts:[{id,label,status,error,checkedAt,values}]`，secret 为 `••••`。删除 builtin/custom。 |
| `GET /api/connectors/<name>/icon` | 图片二进制，正确的 Content-Type，`Cache-Control: private, max-age=2592000`。catalog/installed 的 icon 就是 `/api/connectors/<name>/icon`，App 用云端地址拼接。 |

连接器账号 CRUD/test 继续使用 `POST /api/connectors/<name>/accounts {values}`（201）、`PUT .../accounts/<id> {values}`（200）、`DELETE .../accounts/<id>`（200 `{ok:true}`）和 `POST .../accounts/<id>/test`。添加/修改验证成功返回 `{id,label,status,error,checkedAt}`；失败 400 `{error}` 不保存。重新测试失败为 400，仍返回账号状态 `{id,label,status:"error",error,checkedAt}`。secret 省略或为 `••••` 保留原值。

稳定连接器 id：qq-mail、netease-163、netease-126、gmail、exmail、aliyun-mail、imap、tavily、weread。邮箱 values 为 `{address,password,label?}`，imap 另需 `{host,port?}`（默认 993）；没有 preset。Tavily/微信读书为 `{apiKey}`，各支持一个账号。

设备的 WS result 在 data 中返回一个或多个 `{image:base64,mime}`，可以带 width/height 等元数据：

```json
{"t":"result","id":"call-id","ok":true,"data":{"image":"BASE64","mime":"image/png","width":1200,"height":800}}
{"t":"result","id":"call-id","ok":true,"data":[{"image":"BASE64","mime":"image/png"},{"image":"BASE64","mime":"image/jpeg"}]}
```

云端转换为 MCP `{content:[{type:"image",data:base64,mimeType:mime},...]}`；元数据另外作为 text 内容。单张解码后上限 5 MiB，超出返回中文 isError，不把 base64 文本送给模型。支持 PNG/JPEG/WebP/GIF。Mac computer_use/browser 截图共用这条链路。
