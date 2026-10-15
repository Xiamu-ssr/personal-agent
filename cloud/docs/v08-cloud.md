# 豆豆 0.8.0 云端协议

本文是 Android、Mac 对接的当前协议。0.8 是破坏性更新，不提供旧接口别名。以下都是服务内路径；反向代理可统一加 `/agent` 前缀。例子的域名均为测试域名。

## 通用约定

- 除 `GET /health`、`POST /api/pair` 外，需要 `Authorization: Bearer <配对取得的 token>`，或现有 `pa_token` cookie。WS 升级也使用相同鉴权，不使用 URL token。
- JSON 为 UTF-8。错误通常为 `{ "error": "中文原因", "code": "可选代码" }`；未登录 401、输入错误 400、没有资源 404、重复操作 409、不支持的方法 405。SDK 停止失败 502、主会话不可用 503。
- `ts`、`started`、`startedAt` 是 Unix 毫秒数；`time`、`nextRun`、`nextCheckin` 为 ISO 8601 字符串。定时按服务 `AGENT_TZ`，默认 `Asia/Shanghai`。
- 文件路径是相对数据根的 `data/...`，不是 URL。下载用 `/files/` 后拼完整路径，每一段做 URL 编码。查询参数也须 URL 编码，尤其中文目标名和包含 `:` 的安排 id。
- 消息、活动、选项均按服务端 id 合并。不要按事件到达次数推断活动数量。

## 主聊天和首次使用

`GET /api/state` 示例：

```json
{
  "version":"0.8.0",
  "busy":false,
  "avatar":{"state":"idle"},
  "devices":[],
  "activities":[],
  "schedule":[],
  "firstChat":null,
  "chatEmpty":true,
  "userCall":"用户",
  "agentName":"豆豆"
}
```

`busy` 只表示主聊天在运行。后台活动可与 `busy:false` 同时存在；头像综合主聊天与后台活动。`firstChat` 是主聊天第一条记录的毫秒时间或 null，`chatEmpty` 表示还没有聊天记录。名字读取 `data/soul/角色.md`。

| HTTP | 请求 | 返回 |
| --- | --- | --- |
| `GET /api/history?n=200` | n 为 1–1000 | `{items:[消息...]}`，按聊天顺序；默认最近 200 条 |
| `POST /api/send` | `{text,attachments?}` | 200 `{ok:true,id:"用户消息 id"}` |
| `POST /api/first-chat` | `{device:"android"}` 或 `{device:"mac"}` | 200 `{started:true,id}`；已经有聊天记录则 `{started:false}` |
| `POST /api/options/choose` | `{messageId,optionId}` | 200 `{ok:true,id,messageId,optionId}`；id 是发出的用户消息 id |

首次聊天接口只在主聊天为空时触发。并发调用合并为同一次，提交给模型的原文为 `[第一次聊天] 设备：android` 或 `[第一次聊天] 设备：mac`，source 为 `onboarding`。介绍、起名、推荐连接应用由系统提示词决定。

文字与附件不能同时为空，文字 UTF-8 最多 32KiB。上传继续使用 `POST /api/upload?name=<文件名>`，原始二进制 body，最多 20MiB，返回 `{path,name,size}`，路径为 `data/uploads/<YYYY-MM-DD>/<HHMMSS>-<文件名>`，重名自动加序号。随后发送：

```json
{"text":"看看这张图","attachments":[{"path":"data/uploads/2026-10-15/090000-image.png","name":"image.png","kind":"image"}]}
```

附件 kind 为 `image|file|voice`；size 由服务端实测，客户端可省略，伪造 size 不改变限制。只接受 uploads 内的已有文件；图片转换成 SDK image 块，voice 保留语音笔记流程。按住说话的转写仍为 `POST /api/transcribe?format=aac`，支持 wav/mp3/aac/ogg/flac/m4a。

忙时发送的消息立即持久化、广播，并交给正在运行的 SDK AsyncIterable；模型在下一次请求中能看到，通常位于工具结果内的提醒中。正在进行的 HTTP 模型请求和工具不会被强行终止。没有忙时消息队列、修改或撤回操作。设置改变在下一轮主聊天生效，忙时插话沿当前模型继续。

## say：模型对用户说话

进程内 MCP server 名 `doudou`，工具名 `say`，模型实际调用 **`mcp__doudou__say`**。每次调用独立创建一条 assistant 气泡，立刻广播、保存并通知在线设备。主聊天、独立后台会话、原生 fork 共用这一个说话出口。

```json
{
  "text":"查到了。你想继续哪一个？",
  "options":[{"label":"继续","reply":"继续刚才的工作"},{"label":"先等等"}],
  "cards":[{"type":"connector","id":"qq-mail"},{"type":"goal","name":"每周运动"}]
}
```

- `text` 为 Markdown，最多 40000 字符；可为空，但 text/options/cards 至少有一个非空。
- `options` 可省略，最多 12 个。label 非空、最多 200 字符；reply 非空、最多 8000 字符，省略时等于 label。服务端为每项生成本气泡内的字符串 id，例如 `"0"`。
- 一组选项中任何一个被点击后，**整组永久失效**。先持久化消费记录，再发用户回复；跨 App 并发点击只有一次成功，后续 409。历史中带 `optionsUsed`，重启后仍失效。
- `cards` 可省略，最多 20 张；每张的格式如下。
- 工具本身返回 `{id:"气泡 id"}`，不把正文重新作为工具结果显示到聊天。
- 模型直接输出的普通正文仍显示，标记 `fallback:true`。正文不能因忘记调用 say 而消失。多个 assistant 消息分别形成气泡；`turn_end` 不再负责创建气泡。
- 工具、thinking、中间步骤都不进入聊天气泡。工具摘要只在活动页显示。

| type | 字段 | App 行为 |
| --- | --- | --- |
| `connector` | `id`：已支持的连接器 id | 打开该连接器详情/连接账号 |
| `goal` | `name`：目标文件名，不含 `.md` | 打开目标详情 |
| `link` | `url`：HTTP(S)；可选 `title,description,image`，image 为 HTTP(S) 图片 URL | 网页预览；无标题时显示 URL，点击打开网页 |
| `image` / `video` / `audio` / `file` | `path`：data 内已有文件；可选 `name` | 按类型预览/播放/下载，无法播放时显示文件卡片 |
| `browser` | 无其他字段 | 打开当前共享云端浏览器会话；状态 `/api/browser/state`，实时画面 `/ws/browser`，接管及输入见下节和 [browser.md](browser.md) |
| `device` | 可选 `capability`，如 `health` | 打开当前设备的本机能力授权；省略时显示能力列表 |

媒体卡片只允许 data 内的普通文件，解析符号链接后仍须在 data 内。MD 正文中的 `data/...` 链接也会抽成 `media`（按出现顺序去重，最多 20 个），字段为 `{path,name,kind,mime,size}`。卡片可以与 Markdown 共存，客户端按 path 去重展示。

assistant 历史/WS say 的结构：

```json
{
  "t":"say","role":"assistant","id":"bubble-id","text":"要继续吗？","ts":1792029600000,
  "activityId":"activity-id",
  "options":[{"id":"0","label":"继续","reply":"继续刚才的工作"}],
  "cards":[{"type":"browser"}]
}
```

历史没有 `t`，有选项时额外带 `optionsUsed:false|true`。`activityId`、`options`、`cards`、`media`、`fallback`、`error` 只有适用时出现。

## WebSocket

连接 `/ws?role=app`。连接后先收：

```json
{"t":"hello","version":"0.8.0","busy":false,"avatar":{"state":"waiting"},"activities":[],"devices":[],"history":[]}
```

客户端发：

```json
{"t":"send","text":"还有一件事","attachments":[]}
{"t":"choose_option","messageId":"bubble-id","optionId":"0"}
{"t":"interrupt"}
{"t":"stop_activity","id":"activity-id"}
```

`interrupt` 只停止当前主聊天回复；主 SDK 查询声明 per-task stop affordance，原生后台 fork 保持运行。单独停止某个活动用 stop_activity，回包 `{t:"activity_stop",id,ok:true}`，失败为 `ok:false,error,code?`。成功代表已接受停止请求，最终以活动状态为准。

| 服务端事件 | 关键字段 | 处理 |
| --- | --- | --- |
| `user` | `role:"user",id,text,source,ts,attachments` | 立即显示用户气泡；source 可能是 app/http/option/feed/idea/onboarding/maintenance |
| `say` | 上述 assistant 消息 | 新增或按 id 完成气泡 |
| `delta` | `id,text` | 只为普通正文的暂存流式文本，按 id 拼接；say 到来后用完整正文替换 |
| `options_used` | `messageId,optionId` | 禁用该气泡的全部按钮 |
| `status` | `busy,reason?` | 主聊天运行情况；reason 如 user/task_result/activity_continuation |
| `avatar` | `state,text?` | 更新头像和工作状态文字 |
| `turn_end` | `activityId,text,error?,media?` | 主轮完成信号。text/media 是普通正文的本轮摘要；不要据此重复创建气泡，也不要据此推断 SDK 已 idle |
| `activity` | `phase:"started"|"done",id,title?,status?,ts,outputs?` | 刷新活动列表；状态以 history/list 为准 |
| `activity_step` | `id,item:{kind,text,time,tool?,from?,attachments?}` | 活动详情增量，放在控制台；不显示在主聊天 |
| `background_activities` | `phase:"snapshot",items:[{id,description,startedAt}]` | 替换原生后台活动集合；空数组清空 |
| `background_activities` | phase 为 started/updated/progress/notification，带 id/description/status/patch/summary 等 | 原生 SDK 活动明细；结束通知后移除，后续 snapshot 校准 |
| `feed_new` | `items:[{path,title,date}]` | 动态红点；进入栏目后客户端本地清除红点 |
| `feed_settings` | 完整动态设置 | 两端同步更新 |
| `files_changed` / `memory_updated` | `path` | 按需重新读取资源或记忆 |
| `connectors_changed` | `name` | 重读连接器目录 |
| `devices` | `devices` | 更新在线设备列表 |
| `error` | `error,status?` | 本次 WS 输入/选项失败，显示中文说明 |

原生后台活动不含后台 shell 和 ambient agent。原生 snapshot 是运行集合的来源，不能用 started 次数减完成次数计算。进程重建会发空 snapshot；持久化的未结束活动标为 stopped，后续恢复会更新。

在线设备仍使用 `/ws?role=device`，register/result/call 的协议保持。每条说话会向设备发 `{t:"event",kind:"reply",messageId,text}`，text 最多 300 字符；设备按前台状态和本机通知设置决定是否发系统通知。后台完成本身不再生成聊天结果卡片或重复通知；后台需要告知用户时调用 say。没有设备在线时不提供独立离线推送。

## 头像

| state | 含义 |
| --- | --- |
| `idle` | 空闲 |
| `working` | 主聊天或后台活动正在工作；带一行 text |
| `waiting` | 正在等用户交还浏览器，或工作结束且最后一条说话有尚未点击的选项 |
| `happy` | 一轮成功结束且没有待答选项；约 3 秒后 idle |
| `error` | 一轮失败；新工作开始时转 working |

working 文案从当前工具推导，如「在看你的邮件」「在浏览网页」「在写动态」「在想点子」「在跟进目标」「在整理记忆」，默认「努力工作中」。用户接管浏览器时 waiting 优先；其余情况还有活动运行时优先 working。不要把主聊天 busy:false 渲染为空闲。

## 云端浏览器

浏览器已经接入主聊天、原生 fork 和独立后台会话的 MCP，工具前缀 `mcp__browser__`。每个 query 使用独立 MCP transport，底下共用同一个控制器、持久 profile 和唯一标签页。创建会话、列工具、查询状态和订阅 WS 都不启动 Chrome，第一次真正使用时才启动。

`say` 的 `{ "type":"browser" }` 卡片始终指向这个当前共享会话，没有新增卡片字段或 sessionId。点击卡片先查状态，再订阅画面；旧卡片也打开当前浏览器，不恢复历史页面。鉴权与主 App 完全相同，Bearer / pa_token；不使用 URL token。以下路径均沿用 browser worker 已发布的协议：

| HTTP | 请求 | 返回 |
| --- | --- | --- |
| `GET /api/browser/state` | 无 | browser_state，不启动 Chrome |
| `POST /api/browser/open` | `{}` | 启动并返回 browser_state |
| `POST /api/browser/takeover` | `{reason?:"我来操作"}` | 用户接管并返回 browser_state |
| `POST /api/browser/input` | 坐标/文字/按键/对话框事件 | `{ok:true}` |
| `POST /api/browser/return` | `{}` | 交还并返回 browser_state；重复交还不再次唤醒模型 |
| `POST /api/browser/close` | `{}` | 等清理后返回 closed 状态 |

`/ws/browser` 发送 `browser_state`、`browser_frame`，客户端可发 `{t:"browser_watch",watch:false}` 暂停画面；重新进入时传 true。state 的 control=user 表示接管权归用户，state=closed 也可能仍保留用户控制权。帧为 base64 JPEG、1280×800，输入必须带有效 frameId 和当前显示尺寸，不能用整张屏幕的坐标。完整字段、输入缩放/拖动/对话框、错误码和示例见 [browser.md 的 App 鉴权与 HTTP、WS 实时画面、用户输入](browser.md#app-鉴权与-http)。

调用浏览器工具时头像 working，text 为「在浏览网页」；请求接管后 waiting。用户接管期间模型的浏览器工具返回普通 blocked 结果，不操作网页。交还后，云端自动将内部消息 `[浏览器交还] 用户已交还浏览器，请重新读取页面后继续原来的工作。不要重复已经完成的点击或提交。` 送回发起接管的 SDK 会话，不创建用户聊天气泡，只记入活动步骤。

主聊天使用原 AsyncIterable 输入流；独立后台会话在接管期间保留输入流和活动，交还后继续同一个 query，主聊天仍可使用。若在该轮 result 之前交还，内部唤醒等该 result 后送入同一流，避免关闭查询时丢失。原生 fork 通过原父会话的 SendMessage 路径继续；会话已结束或已重建时使用原活动的持久上下文恢复。单独停止该活动会取消这次自动续聊。浏览器当前正在执行的工具决定交还归属，其他排队/被挡的浏览器调用不会抢走它。

`[动态]` 也有浏览器工具，说明明确限制为读取用户已登录的网站；不需要时不启动 Chrome。未登录、验证码或确认操作跳过，动态的 request_takeover 返回 blocked，不唤起用户接管；登录状态是否可用仍由模型读取页面判断。

部署使用独立用户 unit 和浏览器 slice，Chrome/Xvfb 与构件缩略图合计上限 450M，本体保留 900M。配置和目标机验证步骤见 [browser-memory.md](browser-memory.md)。此限制是保守预算，未做目标机实测；浏览器崩溃后下次使用可重开。

## 动态

| HTTP | 参数/请求 | 返回 |
| --- | --- | --- |
| `GET /api/feed?days=7&before=2026-10-15` | days 为 1–31 个有帖日期；before 可省略，排除这个日期及更新的日期 | `{days:[日期...],items:[帖子...],next:下一页日期游标或null}` |
| `GET /api/feed/item?path=<data/feed/...md>` | 完整帖子路径 | 单条帖子，不限制日期；没有则 404 |
| `POST /api/feed/feedback` | `{path,action:"like"|"dislike"|"discuss",text?:"讨论的话"}` | `{ok:true}`；讨论另有发起聊天的用户消息 id |
| `GET /api/feed/settings` | 无 | 完整设置 |
| `PUT /api/feed/settings` | 下面设置的任意子集 | 校验后返回完整设置 |
| `POST /api/feed/refresh` | 无 | 202 `{mode:"isolated",id}`；已有运行则 `{mode:"skipped",reason:"running"}` |

帖子按日期/HHMM 文件名倒序，分页不拆开同一天。单条帖子：

```json
{"path":"data/feed/2026-10-15/0900-新品.md","date":"2026-10-15","title":"一句话事实","source":"来源 · 文章名","url":"https://example.test/news","published":"2026-10-15 08:30","icon":"📰","image":"data/feed/2026-10-15/cover.jpg","body":"Markdown 正文。"}
```

image 可省略。缺少有效 frontmatter 的帖子不列出；配图必须在该帖子目录且真实存在。设置：

```json
{"enabled":true,"interval":30,"start":"07:00","end":"23:00","instructions":"用户的动态偏好 Markdown"}
```

interval 只接受 15/30/60；时段是 HH:MM，包含开始、不包含结束，可跨午夜，起止不能相同。每隔 interval 分钟从 start 起对齐检查。instructions 最多 40000 字符；App 接口可改，豆豆也可按用户要求在主聊天、首次聊天或其他会话中修改。只有 `[动态]` 后台运行拒绝修改；此限制由运行上下文决定，用户在主聊天提到「动态」不改变权限。模型写入后发 files_changed，App 可据此重读设置。控制台停用动态与 enabled 是同一个开关。

动态固定使用 `anthropic/claude-haiku-5.5`，即使聊天选了 Opus 或 GLM；从 `spec/prompts/feed.md` 读取触发正文，首行时间替换为上次成功完成的本地时间，首次去掉整个「上次：」片段。成功运行但没有新帖也更新时间；失败不更新。已有一次动态在排入后台或运行时跳过下一次，手动刷新也遵守此锁。

反馈写入 `data/feed/反馈.jsonl`，每行例如：

```json
{"path":"data/feed/2026-10-15/0900-新品.md","title":"一句话事实","action":"讨论","text":"这个对我有什么影响？","ts":1792029600000}
```

讨论把标题、来源、URL、正文与用户问题作为 `[讨论动态]` 消息送入主聊天，source 为 feed。普通赞/踩不启动模型。

## 点子

- `GET /api/ideas` 返回 `{revision,groups:[{name,items:[{id,icon,title,description,reply}]}]}`。
- `POST /api/ideas/click {id,revision?}`：记录点击，把原文引用的 reply 作为用户消息发出，source 为 idea；200 `{ok:true,id:"用户消息 id"}`。
- 旧 revision 返回 409；已经不存在的 id 返回 404。App 应同时传 revision，避免换批时误点。
- `POST /api/ideas/refresh`：202 `{mode:"isolated",id}`，同一安排已运行时返回 skipped。
- 每周一 08:00 独立后台运行，从 `spec/prompts/ideas.md` 读取；手动换批也是同一安排。

`data/ideas/点子.md`：

```markdown
## 调研
- 🔎 **研究一个方向**：我来查资料。说明为什么适合用户。
  > 帮我研究一下这个方向
```

领域可用规划、调研、目标、钱、健康、家、学习、人际、文件、娱乐、连接应用。没有引用回复的条目不出现在列表。点击记录 `data/ideas/点击.jsonl`：`{id,revision,group,title,reply,ts}`。

## 目标

- `GET /api/goals`：`{items:[目标...],errors:[{name,error}]}`；只读 goals 根目录。
- `GET /api/goals?done=true`：读取 goals/done。
- `GET /api/goals/item?name=<不含.md的目标名>&done=true|false`：单个目标。
- 每项目标返回 `{name,path,title,domain,cadence,due?,status,progress,body,nextCheckin}`。nextCheckin 为 ISO 时间，暂停/完成/放弃/停用跟进时为 null。
- 创建或修改目标通过主聊天，例如发送「我想定一个健康目标，帮我聊清楚计划和跟进频率」，不提供创建目标接口。

文件 `data/goals/<目标名>.md`：

```markdown
---
title: 每周运动
domain: 健康
cadence: "0 8 * * 1"
due: 2026-12-31
status: 追踪中
progress: 25
---
## 计划
每周运动三次。
## 步骤
- [x] 定好时间
- [ ] 完成第一次运动
## 记录
记录实际进展和日期。
```

domain 为 健康/人际/金融/事业/兴趣/效率/其他；status 为 追踪中/暂停/完成/放弃；progress 为 0–100；due 可省略。cadence 为五段 cron，支持 `*`、逗号、范围、步长；星期 0/7 均为周日，日期和星期都有限制时用标准 cron 的“或”语义。frontmatter 是单行标量，cron 推荐双引号。

每次调度检查重新扫描 goals 根目录，不需要重启；增删改在下次检查生效，最长约 15 秒，运行判断按分钟去重。只有追踪中的目标生成 `goal:<目标名>` 安排；提示词取 `goal-checkin.md`，替换全部 `<目标名>`，在独立后台运行。完成或放弃的文件移至 `goals/done/`。

## 资源库和文件

`GET /api/library`：

```json
{
  "artifacts":[{"name":"报告","directory":"data/library/artifacts/报告","path":"data/library/artifacts/报告/index.html","kind":"page","mtime":1792029600000,"thumbnail":"/api/library/thumbnail?path=data%2Flibrary%2Fartifacts%2F%E6%8A%A5%E5%91%8A%2Findex.html","files":[{"path":"data/library/artifacts/报告/index.html","name":"index.html","size":1234,"mtime":1792029600000,"kind":"file","mime":"text/html; charset=utf-8"}]}],
  "media":[{"path":"data/library/media/2026-10-15/image.png","name":"image.png","size":1234,"mtime":1792029600000,"kind":"image","mime":"image/png"}]
}
```

两组都按 mtime 倒序。构件根目录有 index.html 是 page，否则为 document。document 的 path 优先 index.md，再取一个已有文件，files 可用于展示多文件；空目录没有可打开文件。media 递归列出所有交付文件，kind 为 image/video/audio/file。

`GET /api/library/thumbnail?path=<构件HTML>` 返回 JPEG，390px、最多三屏、≤300KiB；鉴权不变。沿用本地截图能力，阻止公网 HTTP、WebSocket、弹窗及越界文件访问，一次只截图一个页面。浏览器不可用时返回中文错误，App 用占位缩略图。模型也可以用 `mcp__page__screenshot({path})` 自查构件页面；不再有 skin 参数。

`GET|HEAD /files/<data/...>` 提供原文件；目录自动找 index.html。支持 Bearer/cookie、Content-Type、Accept-Ranges、单段 `Range: bytes=...`、206/416，流式发送。文件和目录的真实路径都必须在 data 内，禁止符号链接逃逸。`GET /api/tree?dir=data/memory` 返回 `{dir,entries:[{name,dir,size,mtime}]}`，只用于数据浏览。

## 控制台：活动

| HTTP | 请求/返回 |
| --- | --- |
| `GET /api/activities?limit=30&before=<毫秒>` | `{running:[{id,label,title?,started}],recent:[{id,label,title,status,ok,ts,outputs}],next:<毫秒或null>}` |
| `GET /api/activities/<id>/history` | `{id,title,status,items:[{kind,text,time,from?,tool?,attachments?,media?}]}` |
| `POST /api/activities/<id>/send` | `{text,attachments?}`，200 `{ok:true,id:"原活动id"}` |
| `POST /api/activities/<id>/stop` | 无 body，200 `{ok:true,id}` |

每轮聊天、独立后台运行和原生后台 fork 均记录活动；聊天轮中的插话进入同一活动步骤。recent 默认 30 条、limit 1–100，before 排除该毫秒及更新的记录。相同毫秒整组返回，可能略超 limit；next 是末条时间，null 表示没有下一页。只有首页带 running。状态为 running/done/error/stopped，输出文件在 outputs。标题和时间均持久化。

items.kind 为 prompt/text/tool/result。prompt 的 from 区分 user/agent；tool 仅返回短摘要，隐藏 thinking、原始工具结果、base64 和凭据。运行中可每 3 秒刷新详情，结束后停止轮询。主聊天步骤直接持久化；原生任务仍可从本数据根内 SDK transcript 读取或回填。

续聊保持原活动 id。原生任务父会话还在且没有附件时使用 SDK SendMessage；其他情况使用原目标、交代、步骤、结果和用户后续交代，在隔离会话续聊，有原独立会话可恢复时 resume。图片使用真实 SDK image 块。切换为隔离会话前会停止同一原生 worker，避免并发写同一活动；重启后无需旧运行对象也能继续。详情/索引在 system/activity-index.json，权限 600。

## 控制台：定时、权限、记忆

`GET /api/schedules` 返回 `{items:[{id,name?,kind?,cron?,enabled,running,nextRun,prompt?,goal?,interval?,start?,end?,error?}]}`。

- `POST /api/schedules/<URL编码id>/run`：202 `{mode:"isolated",id:"活动id"}`；同一安排已有运行则 `{mode:"skipped",reason:"running"}`。手动运行可执行已停用的安排。
- `PUT /api/schedules/<id> {enabled:false|true}`：返回该安排完整条目。目标停用状态独立保存在 system/schedule-overrides.json，修改目标正文不清掉停用状态。
- feed 无 cron，按窗口与间隔；ideas 为 `0 8 * * 1`；night 保留原 id，`30 22 * * *`；health-sync 为 `0 */3 * * *`，直接同步设备、不调用模型；compact/cleanup 保留。
- 动态、目标、点子、夜间整理和补读都不占住主聊天。受现有机器内存约束，独立后台模型会话串行执行；在等待执行时也算该安排已运行，不重复积压。不同后台安排可在主聊天期间执行。
- 夜间整理继续使用 seed 的 prompt；动态/目标/点子每次从 spec/prompts 读取当前文件。system-prompt 使用分隔线后的正文和占位符替换。

`GET /api/settings` 与 `PUT /api/settings {model?,permissionMode?}` 返回 `{model,permissionMode,models:[{id,label,note}],permissionModes:[{id,label,note}]}`。模型为 `anthropic/claude-haiku-5.5`（默认）、`anthropic/claude-opus-5.5`、`z-ai/glm-5.3-flash`、`z-ai/glm-5.3-flashx`；权限为 auto（默认）或 bypassPermissions。两种都不向 App 发权限审批弹窗；关键对外动作由提示词要求先发 say 选项。模型/权限下一轮主聊天生效，独立后台会话在启动时取最新设置，动态固定 Haiku。上下文仍为统一 200K、内置压缩、max effort，压缩期间临时 low。

`GET /api/memory` 返回：

```json
{"soul":{"path":"data/soul/角色.md","name":"豆豆","personality":"靠谱","voice":"简洁","diary":[{"name":"2026-10-15","path":"data/soul/diary/2026-10-15.md"}]},"profile":"data/memory/profile/总档.md","categories":[{"name":"work","items":[{"name":"项目","path":"data/memory/work/项目.md"}]}],"health":"data/health/days.json"}
```

- `GET /api/memory/item?path=<路径>`：`{path,text,readOnly}`。
- `PUT /api/memory/item?path=<路径> {text}`：200 `{ok:true}`，最多 40000 字符。允许 soul/角色.md、soul/diary/*.md、memory/分类/*.md；health/days.json 只读，PUT 返回 405。
- `GET /api/health` 打开时同步，`POST /api/health/sync` 手动同步，返回 `{syncedAt,device,note,days,records}`。days 含今天的最近七天，指标缺失为 null；records 为健康 Markdown 记忆。离线/未授权/超时保留已有数据，note 说明原因。最多等待 20 秒；不再有 weekly 字段。
- 连接器列表、图标、账号 CRUD/test、设备删除、配对、技能列表和上传/转写协议保持。连接器仍通过 `/api/connectors`、`/api/connectors/<id>/accounts...`，权限设置通过 `/api/settings`。

## 保留的连接、配对和设备接口

配对码仍由云端生成：`POST /api/pair/new`（已鉴权）返回 `{code}`；新设备用 `POST /api/pair {code}` 换 `{token}`。配对码一次性、会过期，连续五次错误作废；过期 410，错误 403。`POST /api/login {token}` 验证已有 token 并设置安全 cookie，返回 `{ok:true}`。`GET /health` 不需要 token，返回 `{ok:true}`，只表示 HTTP 存活。

`GET /api/connectors` 的结构：

```json
{"cloud":{"id":"cloud","name":"云电脑","kind":"cloud","online":true,"catalog":[{"name":"github","title":"GitHub","description":"读取仓库和通知","icon":"/api/connectors/github/icon","multiAccount":false,"status":"off","fields":[{"key":"token","label":"Token","type":"secret","required":true}]}],"installed":[]},"devices":[]}
```

catalog/installed 的每个连接器都有 name/title/description/icon/fields/multiAccount/status；实际 fields 以返回值为准，不在 App 中硬编码新增服务的表单。installed 还带 `accounts:[{id,label,status,error,checkedAt,values}]`，secret 值显示为 `••••`。当前内置 id：qq-mail、netease-163、netease-126、gmail、exmail、aliyun-mail、imap、tavily、weread、wind、github。`GET /api/connectors/<name>/icon` 返回图片，带正确 MIME 和 private 缓存。

| HTTP | 请求 | 成功 |
| --- | --- | --- |
| `POST /api/connectors/<name>/accounts` | `{values:{字段名:值}}` | 201 `{id,label,status,error,checkedAt}` |
| `PUT /api/connectors/<name>/accounts/<id>` | `{values:{待修改字段:值}}` | 200，同上；secret 省略或 `••••` 保留原值 |
| `POST /api/connectors/<name>/accounts/<id>/test` | 无 | 200，同上；验证失败 400 仍返回账号状态 |
| `DELETE /api/connectors/<name>/accounts/<id>` | 无 | 200 `{ok:true}` |
| `DELETE /api/devices/<id>` | 无 | 200 `{ok:true}`；在线设备不能删，409 |
| `GET /api/skills` | 无 | `{skills:[{name,description}]}` |

账号添加/修改验证失败不保存，错误为中文且不回传凭据。邮箱 values 通常为 address/password/label?，其他服务的实际字段见目录返回；账号设置与模型设置保存在各自 system 配置，不放 data 中。

设备列表由 `/api/connectors.devices` 提供：`{id,name,kind,online,lastSeen,capabilities:[{name,title,description,enabled}]}`。`/api/state.devices` 与 WS devices 只列在线设备：`{id,name,kind,capabilities:[已开启能力名...]}`。设备 WS 输入/输出：

```json
{"t":"register","device":{"id":"device-id","name":"我的设备","kind":"android","capabilities":[{"name":"health","enabled":true,"title":"健康"}]}}
{"t":"call","id":"call-id","capability":"health","args":{"from":"2026-10-08","days":7}}
{"t":"result","id":"call-id","ok":true,"data":{"items":[]}}
{"t":"result","id":"call-id","ok":false,"error":"本机能力未开启"}
```

设备截图 result.data 为 `{image:"BASE64",mime:"image/png",width?,height?}` 或这样的数组，也可与普通结果混合。单张解码最多 5MiB，支持 PNG/JPEG/WebP/GIF；云端转换为模型 image 块，元数据另作 text，不把 base64 当文本。健康 result.data.items 的原始字段为 date/sleep_minutes/resting_heart_rate_bpm/hrv_ms/steps。

## 数据目录与文件格式

以下路径均在 data 下。所有新写入只使用新路径：

| 路径 | 内容/归属 |
| --- | --- |
| `feed/动态说明.md` | 用户偏好；App、主聊天及其他会话可改，只有 `[动态]` 运行只读 |
| `feed/反馈.jsonl` | 赞/踩/讨论，格式见上 |
| `feed/YYYY-MM-DD/HHMM-短名.md` | 动态帖子；图片同目录 |
| `ideas/点子.md` | 当前分组点子 Markdown |
| `ideas/点击.jsonl` | id/revision/group/title/reply/ts |
| `goals/目标名.md`、`goals/done/目标名.md` | 目标 frontmatter、计划/步骤/记录 |
| `library/artifacts/名/` | 构件，index.html 表示页面 |
| `library/media/YYYY-MM-DD/` | 图片/视频/音频等交付文件 |
| `memory/分类/主题.md` | 一层主题文件，profile 只允许 总档.md |
| `soul/角色.md` | `- 名字：`、`- 性格：`、`- 口吻：` 和补充 Markdown |
| `soul/diary/YYYY-MM-DD.md` | 日记 Markdown |
| `health/` | 手机同步原始数据，豆豆只读 |
| `uploads/YYYY-MM-DD/` | 用户上传原件，豆豆只读 |
| `follow-ups.md` | 跟进清单 |

记忆分类为 profile/people/preferences/life/work/project/interests/history/health/finance/feedback/automation-prefs/voice-notes。角色已移至 soul，不再用 role 分类。workspace/任务名/ 是草稿区，七天未修改清理；检查子目录文件的实际更新时间，避免删掉仍更新的草稿。system 保留设置、会话、连接器、同步游标与浏览器登录数据，浏览器独占 system/browser。

帖子 frontmatter：

```markdown
---
title: 一句话事实
source: 渠道名 · 文章或节目名
url: https://example.test/news
published: 2026-10-15 08:30
icon: 📰
image: cover.jpg
---
两到四句正文，可带 Markdown 链接或小表格。
```

image 可省略。原始健康数据 `health/days.json` 为 `{syncedAt,device,note,days:[{date,sleepMinutes,restingHr,hrv,steps}]}`，只由同步代码更新；保留最近 90 天，部分指标缺失不抹除已存指标。

agent 的 PreToolUse 守卫始终拒绝修改 health、uploads 及连接器维护的技能；仅在 `[动态]` 后台运行中拒绝修改 feed/动态说明.md，含该运行的原生 fork。用户后来从活动页发起的普通续聊属于另一次运行，权限不因旧活动曾是动态而永久锁定。文件工具处理真实路径和符号链接；Bash 为保守命令检查，仍不是操作系统文件隔离。

## 启动迁移与移除项

首次启动在写入 `system/migrations/v08.json` 前执行一次迁移，先复制源数据与定时/聊天记录到 `backup/migrate-v08-<时间>/`，有 manifest。路径冲突、损坏配置或源符号链接会报错，不覆盖同名文件。旧根内容移到新根，不留下软链接：

- briefs 整体留在备份，运行目录删除；sites → library/artifacts；files → library/media；diary → soul/diary；memory/role/角色.md → soul/角色.md。
- task-index.json → activity-index.json；记录中的旧交付路径重写。聊天备份后移除旧完成卡片、补齐消息 id、重写旧交付链接。
- 移除晨报/晚报/健康周报安排、旧头像 shape/palette 设置、旧 jobs.jsonl、旧 memory/health/latest.json。保留自定义安排，补 feed/ideas/health-sync，night 的 id 不变、时间对齐 22:30。

已删除的 HTTP：`/api/briefs`、`/api/briefs/item`、`/api/jobs`、`/api/tasks/<id>/{history,send,stop}`、`/api/run`、`/api/profile`。旧 WS `unqueue`、`edit_queued`、`queue_update`、`stop_task`、`task_stop`、hello.queued、hello.tasks 和旧 job/结果卡片协议不再提供。

简报 HTML 校验/渲染、基础 CSS、按钮脚本、三种 skin、briefGuideFile、旧简报迁移脚本及相关测试全部删除。page.screenshot 只认 library/artifacts。旧 docs/v04、v05、v06 是历史记录，不作为 0.8 对接依据。

## 本地 SDK 实验与可复现验收

锁定 SDK 0.3.295。`test/sdk-interjection.test.mjs` 用真实 CLI、回环 fake Anthropic 服务和两个 Read 工具：第一个工具执行中向 AsyncIterable 填新消息；下一次模型请求已包含这条消息，且此前 result 数为 0。完整运行层下，SDK 也可能把插话放进 tool_result 内的提醒；应检查模型请求内容，不能只检查顶层 user 文本。

`node scripts/verify-v08.mjs` 会启动临时数据根、真实 SDK、假模型和 HTTP/WS 服务，日志在 `/tmp/v08-cloud-demo/`。覆盖两次 say、工具期间插话、带选项、首次/重复点击、普通正文保留、活动步骤，以及聊天选择 Opus 时动态的真实 wire model 仍为 Haiku。没有调用外部模型或真实设备，不代表线上/App 集成已验收。

`node scripts/verify-v08-browser.mjs` 用本机真 Chrome、假模型和本地测试页，验证主聊天与独立后台各自的接管→App 点击→交还→原输入流继续→say；包括鉴权、实时画面、waiting 和不使用浏览器的动态懒启动。日志在 `/tmp/v08-cloud-demo/browser/`。没有访问真实网站、个人 profile 或服务器；systemd/cgroup 隔离未在 macOS 上宣称实测。
