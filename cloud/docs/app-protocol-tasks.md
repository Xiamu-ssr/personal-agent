# 后台任务、主会话自发回合与简报（v0.3，第 3 轮）

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
- **忙闲以 `status` 为准**。`turn_end` 是回复结果；CLI 原生 `idle` 才放行队列，两种信号先后都可能出现。用户在自发回合期间发送的消息被保存并按提交顺序排队。
- 自发回合发生上下文/压缩失败时，仍显示中文恢复提示并新建会话，保留 `data/` 和待办；不自动重放任务通知。

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
{"role":"user","source":"schedule","text":"[定时] 该出「报价简报」了\n\n任务说明","ts":1791580800000}
{"t":"user","source":"schedule","text":"[定时] 该出「报价简报」了\n\n任务说明","attachments":[]}
```

App 可隐藏 schedule 的用户气泡，仍接收随后 assistant 的确认和完成回复。HTTP 手动运行返回 202，保留 `ok: true`，增加 `mode: "alarm"`（维护为 `"isolated"`）；表示已经排队，不表示简报完成。

提示词让主 agent 用 Agent `subagent_type: "fork", run_in_background: true` 派出任务，简短确认；fork 完成的原生通知再次唤醒主会话转述结果并给路径。fork 用 Write 输出 HTML 后，PostToolUse 按 `agent_id` 收集 outputs。完成时复用原有卡片：

```json
{"role":"card","label":"报价简报","title":"报价简报","outputs":["data/briefs/2026-10-10/报价简报.html"],"ok":true,"ts":1791580800000,"taskId":"task-id"}
{"t":"job","phase":"done","role":"card","label":"报价简报","title":"报价简报","outputs":["data/briefs/2026-10-10/报价简报.html"],"ok":true,"ts":1791580800000,"taskId":"task-id"}
```

历史回看用原来的 card，实时用原来的 `job.done`；`taskId` 是可选关联字段。仍通过现有鉴权 `/files/<outputs 中的路径>` 打开文件，不需要新简报端点。任务失败/停止时若已写出 HTML，卡片 `ok: false`，标题标“未完成”。没有 HTML 不发空卡片。主会话文字回复仍保存/显示。

卡片自动收集覆盖 Write/Edit/MultiEdit/NotebookEdit 的文件 hook；Bash 等绕过这些 hook 的写入不会自动产生卡片，所以提示词明确要求简报用 Write。`compact`、`cleanup` 保持原行为；`[补读]`、`[夜间整理]` 保持隔离执行，包括维护任务的手动运行。
