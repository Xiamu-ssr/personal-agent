# 豆豆云端协议（v0.6）：后台任务、HTML 简报与设置

接口沿用现有 Bearer / cookie 鉴权。下面路径是云端服务路径；反向代理对外仍可加 `/agent`。本文是当前协议；简报只认 HTML，设置只接受以下三个模型和两种权限。

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

## 定时任务与 HTML 简报

cron 和 `POST /api/run {id}` 对普通任务和 `kind: "brief"` 都向主会话提交 schedule.json 中的 prompt 原文，`source: "schedule"`。晨报、晚报、健康周报在原文后面追加「简报写法」；其他任务不包装、不追加技术说明。

HTTP 手动运行返回 202 `{"ok":true,"mode":"alarm"}`，表示已经排队。`[补读]`、`[夜间整理]` 使用隔离 query，返回 `mode: "isolated"`。compact/cleanup 是运行层维护操作。

运行层通过 UserPromptSubmit 的短系统说明和现有 fork 守卫，要求定时任务派到后台。主会话仍可在完成通知后润色简报。

`GET /api/briefs?days=7`：

```json
{"items":[{"date":"2026-10-11","name":"晨报","time":"2026-10-11T07:30:00+08:00","path":"data/briefs/2026-10-11/晨报.html","cards":[{"html":"<!doctype html>..."}]}]}
```

- items 按 time 倒序；默认近 7 个本地自然日（含今天），days 是 1–365 的整数，错误 400；无简报是空 items。
- 只读 `data/briefs/<日期>/**/*.html`；JSON、无效 HTML、符号链接不列出。可选 `meta name="brief-name"` / `brief-time` 提供名称和 ISO 时间；未写时用文件名 / mtime。
- 每个 html 都是独立完整文档：基础 CSS、原文件公共 style、一张顶层 section.card，以及云端按钮脚本。客户端直接加载。
- App 在 document start 设置 html[data-skin=silver|paper|night]，默认 silver；每套皮肤都有 silver/mist/mint/dusk 四个卡片配色。paper 标题用宋体，其余正文用系统黑体。
- 按钮用 `<button data-prompt="用户消息">文案</button>`。脚本点击后跳到 `doudou://prompt?text=<urlencoded>`；App 拦截、解码，发送用户消息并切到聊天。
- App 拦掉其他一切跳转和网络请求。云端也注入离线 CSP；不执行模型提供的 script / 事件属性，不允许外部资源。
- 加载后 App 读取 document.documentElement.scrollHeight，卡片跟随内容高度，无内部滚动；安全上限为两倍屏高。

主会话、fork、隔离任务共用 Write/Edit 的 PostToolUse 校验：1–6 个顶层 section.card、80KB 上限、无外部资源/导入，依据文字量和元素粗估每卡 ≤960px、最多 240 个元素。错误用中文反馈模型；无效文件不计 outputs。Bash 等绕过文件 hook 的写入不会自动生成卡片。

完成事件与聊天历史：

```json
{"t":"job","phase":"done","role":"card","id":"task-id","taskId":"task-id","label":"晨报","title":"晨报","name":"晨报","time":"2026-10-11T07:30:00+08:00","path":"data/briefs/2026-10-11/晨报.html","outputs":["data/briefs/2026-10-11/晨报.html"],"ok":true,"ts":1791675000000}
```

id 是任务 id。path 是该次运行第一份有效 HTML 简报；name/time 来自这份简报。失败/停止且有有效产出时 ok=false，标题标「未完成」。没有有效文件的任务仍进入任务记录并发完成事件，不在聊天里插空卡片。聊天卡片显示简报名和时间，点击切到今日并滚到 path 对应简报。站点仍用 HTML，只有简报才提供 path。

## 模型与权限

`GET /api/settings` 与 `PUT /api/settings {model?,permissionMode?}` 返回同一结构：

```json
{"model":"anthropic/claude-haiku-5.5","permissionMode":"auto","models":[{"id":"anthropic/claude-haiku-5.5","label":"Claude Haiku 5.5","note":"消耗约 1×；输入超过 100K 后约 5×"},{"id":"z-ai/glm-5.3-flash","label":"GLM 5.3 Flash","note":"输入约 1.5×，输出约 1×；缓存读约 3×"},{"id":"z-ai/glm-5.3-flashx","label":"GLM 5.3 FlashX","note":"输入约 3.75×，输出约 2.5×；缓存读约 7.5×"}],"permissionModes":[{"id":"auto","label":"自动","note":"不问用户，自动拦下危险操作"},{"id":"bypassPermissions","label":"完全放行","note":"什么都不拦"}]}
```

- 原子保存 system/app-settings.json，权限 600。默认 Haiku 5.5 + auto。model/permissionMode 之外的字段及未知值 400，不修改原设置；JSON 格式错误 400。
- 从下一轮生效，当前回复继续完成；两端共享同一份设置。所有 query 都 max effort、200K 窗口，约 167K 压缩。
- 权限用 setPermissionMode。模型切换会在空闲时先 setModel，再以原 mainSessionId resume 新 query，以刷新 CLI 的分类器与子任务模型配置。正在跑的 fork 以原 id 恢复，不复制成新任务。
- 主、fork、独立会话用 claude_code preset + 同一份稳定业务 append。压缩使用内置模板，仅保留压缩时临时 low、结束恢复 max。
- auto 的判断模型与后台分类器通过 CLI 独立配置项指定为选中的模型。两种模式都不向 App 发权限弹窗。

## 任务记录与续聊

`GET /api/tasks/<URL 编码 id>/history`：

```json
{"id":"task-id","title":"报价简报","status":"running","items":[{"kind":"prompt","from":"agent","text":"整理今天的报价","time":"2026-10-11T07:30:00Z"},{"kind":"tool","tool":"Read","text":"读取 data/memory/work/报价.md","time":"2026-10-11T07:30:01Z"},{"kind":"text","text":"已找到两份报价。","time":"2026-10-11T07:30:02Z"}]}
```

status 只有 running/done/error/stopped；items.kind 只有 prompt/text/tool/result。记录取子任务 transcript（隔离维护取自己的 session transcript）；过滤 thinking 和原始工具输出。工具只返回一行摘要，所有文本走 redact。运行中 SendMessage 可能被 CLI 合并到工具回合，运行层保留用户提交原文的脱敏副本，补齐记录中的 prompt；不据此生成模型步骤或结果。

`POST /api/tasks/<id>/send {text,attachments?}` 成功 200 `{"ok":true,"id":"task-id"}`，表示已经接受续聊；text 去首尾空白，UTF-8 上限 32KB；text 和 attachments 不能同时为空，附件校验/图片消息块与主聊天共用。附件条目带 size（字节），由云端按实际文件填写，客户端发送时可省略。

- 原生后台任务使用 SendMessage，to=原任务 id，message=用户原文。运行中交给同一 agent；已结束任务由 CLI 自动恢复原 transcript，保持 task_id、产生新的 run_id，继续在后台执行并照常原生通知主会话。
- 运行层守卫只允许对指定任务发送原文，防止新建任务或由主会话代做。
- 独立维护任务以原 sessionId resume 自己的 query，沿原上下文执行；进行中的独立维护任务续聊会排在其当前回合之后。
- 任务元数据与 id 持久化在 system/task-index.json，600 权限。`/api/state.tasks` 是当前原生后台任务；`/api/jobs` 返回 `{running:[{id,label,started}],recent:[{id,label,title,status,ok,ts,outputs,path?}],next:<ts>|null}`，每项均有可查记录的 id。recent 通过 before 毫秒游标分页（默认 limit=30，范围 1–100），没有总条数上限；before 不传才返回 running；同一毫秒的记录整组返回，可能略超 limit，避免漏项。
- App 打开的任务若 status=running，每 3 秒刷新 history；结束后停止轮询。
- 查询进程重建时先清当前活动列表；未结束的记录标 stopped，恢复后的原生活动更新回 running，避免显示幽灵任务。

错误使用 `{error:"中文原因",code:"..."}`：id 格式错误 400，消息格式错误 400，不存在 404，其他 SDK 操作失败 502。原父会话不可用或消息有附件时，以隔离后台 query 带原标题、交代、步骤摘要和结果继续，图片直接作为消息块；所有续聊记录与完成事件仍挂原任务 id。隔离 transcript 会保留到任务索引中，不覆盖旧记录。

## 其他 HTTP 与设备图片格式

所有路径使用现有 Bearer/cookie 鉴权；外部地址可能有 `/agent` 前缀。新接口的校验错误为 `{error:"中文原因"}`。

| 接口 | 格式 |
| --- | --- |
| `GET /api/profile` | `{avatar:{shape:"bean",palette:"mist"}}`；无配置时返回默认值。 |
| `PUT /api/profile` | body 和成功回包都是 `{avatar:{shape,palette}}`。shape: bean/girl/boy/cat；palette: mist/dusk/mint/sakura。两项同时提供；无效值 400，不覆盖原设置。原子保存 `system/app-profile.json`，权限 600。 |
| `GET /api/state` | `{busy,devices,tasks,schedule,firstChat,userCall,agentName}`；删除 model，firstChat 仍为毫秒或 null。 |
| `GET /api/connectors` | `{cloud:{id:"cloud",name:"云电脑",kind:"cloud",online:true,catalog:[...],installed:[...]},devices:[...]}`。每项 `{name,title,description,icon,fields,multiAccount,status}`；installed 另带 `accounts:[{id,label,status,error,checkedAt,values}]`，secret 为 `••••`。删除 builtin/custom。 |
| `GET /api/connectors/<name>/icon` | 图片二进制，正确的 Content-Type，`Cache-Control: private, max-age=2592000`。catalog/installed 的 icon 就是 `/api/connectors/<name>/icon`，App 用云端地址拼接。 |

连接器账号 CRUD/test 继续使用 `POST /api/connectors/<name>/accounts {values}`（201）、`PUT .../accounts/<id> {values}`（200）、`DELETE .../accounts/<id>`（200 `{ok:true}`）和 `POST .../accounts/<id>/test`。添加/修改验证成功返回 `{id,label,status,error,checkedAt}`；失败 400 `{error}` 不保存。重新测试失败为 400，仍返回账号状态 `{id,label,status:"error",error,checkedAt}`。secret 省略或为 `••••` 保留原值。

稳定连接器 id：qq-mail、netease-163、netease-126、gmail、exmail、aliyun-mail、imap、tavily、weread、wind。邮箱 values 为 `{address,password,label?}`，imap 另需 `{host,port?}`（默认 993）；没有 preset。Tavily/微信读书/Wind AI 为 `{apiKey}`，各支持一个账号。

设备的 WS result 在 data 中返回一个或多个 `{image:base64,mime}`，可以带 width/height 等元数据：

```json
{"t":"result","id":"call-id","ok":true,"data":{"image":"BASE64","mime":"image/png","width":1200,"height":800}}
{"t":"result","id":"call-id","ok":true,"data":[{"image":"BASE64","mime":"image/png"},{"image":"BASE64","mime":"image/jpeg"}]}
```

云端转换为 MCP `{content:[{type:"image",data:base64,mimeType:mime},...]}`；元数据另外作为 text 内容。单张解码后上限 5 MiB，超出返回中文 isError，不把 base64 文本送给模型。支持 PNG/JPEG/WebP/GIF。Mac computer_use/browser 截图共用这条链路。

## 0.6 单项简报、健康和自查

- `GET /api/briefs/item?path=<data/briefs/...html>` 返回与列表里相同的单项 `{date,name,time,path,cards:[{html}]}`，不限定日期；没有或路径不合法返回 404。
- `GET /api/health`（打开页面时同步）与 `POST /api/health/sync`（手动同步）最多等待 20 秒，返回 `{syncedAt,device,note,days,weekly,records}`。days 为含今天的最近 7 天升序，缺失值 null；weekly 读取全部健康周报，records 读取健康 Markdown 文件。离线/未开启/超时仍返回已有数据和中文 note。每 3 小时的 health-sync 直接调用设备，不经过模型。
- 每条 history prompt 都有 from，首条 agent，其后 user；用户续聊附件是 `[{path,name,kind,size?}]`，不返回图片 base64。size 为云端填写的字节数，旧记录没有 size 也照常工作。
- 启动回填私有会话目录里缺失的子任务；已有索引不覆盖。启动时迁移旧模型、角色说话习惯、健康定时项，并删除旧指标文件。
- in-process `mcp__page__screenshot({path,skin?})` 仅截 data/briefs 的 HTML 和 data/sites 本地页面。390px，简报卡片依次拼接、站点最多三屏，JPEG ≤300KiB；全进程串行，30秒超时，浏览器每次启停。所有公网请求均被拦截，本地站点资源仅限站点目录。
- Wind 只常驻 call/list_tools/list_skills/install_skill/ask_alice，密钥只在连接器中；官方技能下载和缓存位于数据根，仓库不含技能正文。
