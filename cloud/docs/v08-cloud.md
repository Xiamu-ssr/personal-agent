# 豆豆 0.8.1 云端协议

本文是 Android、Mac 对接的当前协议。0.8 是破坏性更新，不提供旧接口别名。以下都是服务内路径；反向代理可统一加 `/agent` 前缀。例子的域名均为测试域名。

## 通用约定

- 除 `GET /health`、`POST /api/pair` 外，需要 `Authorization: Bearer <配对取得的 token>`，或现有 `pa_token` cookie。WS 升级也使用相同鉴权，不使用 URL token。
- JSON 为 UTF-8。错误通常为 `{ "error": "中文原因", "code": "可选代码" }`；未登录 401、输入错误 400、没有资源 404、重复操作 409、不支持的方法 405。SDK 停止失败 502、主会话不可用 503。
- `ts`、`started`、`startedAt` 是 Unix 毫秒数；`time`、`nextRun`、`nextCheckin` 为 ISO 8601 字符串。定时按服务 `AGENT_TZ`，默认 `Asia/Shanghai`。
- 文件路径是相对数据根的 `data/...`，不是 URL。下载用 `/files/` 后拼完整路径，每一段做 URL 编码。查询参数也须 URL 编码，尤其中文目标名和包含 `:` 的安排 id。
- 消息、活动、选项均按服务端 id 合并。不要按事件到达次数推断活动数量。

## 0.8.1

### 聊天里只有 say，Stop 防止漏说

主聊天、旁聊、后台与委派任务的模型正文一律只进过程记录，`result.result` 也不生成聊天气泡。云端不再产生 fallback 气泡或正文 delta。给用户看的模型回复只由 `mcp__doudou__say` 发出，say 立即保存和广播，可以分几次说短句。系统错误仍可用带 `error:true` 的错误气泡提示。

主聊天和旁聊的 Stop hook 会检查最后一条 assistant 消息的非空正文；若经空白归一化后，与本轮某次 say 相同或被该次 say 包含，不提醒。否则每轮最多返回一次 `decision:"block"`，理由为：

> 你最后写的这段正文用户看不到。要告诉用户的话用 say 发出（短句，可以分几条）；如果只是旁白或总结，直接结束。

整轮没调用 say 但写过正文也会提醒一次。SDK 0.3.295 的长连接 AsyncIterable 实测支持 block 后继续：第二次 Stop 的 stop_hook_active 为 true，此时直接结束；下一轮恢复为 false。云端另有每轮 blocked 标记，忙时插话不重置它。后台会话不安装这个 Stop 检查。App 无需处理 hook 或显示提示理由。

### 自拼静态系统提示词与统一模型

配置新增 `basePromptFile`，指向 `spec/prompts/base.md`；原 `promptFile` 指向 `spec/prompts/system-prompt.md`。两文件各只取第一条独立 `---` 分隔线之后的正文，trim 后以一个空行连接，统一填入 `{名字}`、`{称呼}`、`{时区}`。本进程第一次使用时缓存整串，之后主会话、旁聊、后台及原生 fork 使用同一份；不按轮重新读文件或填充时间。SDK 的 `systemPrompt` 是字符串，已去掉 `claude_code` preset/append。文件更新需重启本体。

SDK 0.3.295 真请求核实：该字符串作为一个完整 text 块原样发送，没有附加 Claude Code 的整份默认提示词、身份句或环境段；SDK 仍另附一条通用身份句 `You are a Claude agent, built on Anthropic's Claude Agent SDK.` 和计费元数据块。云端保留这两条 SDK 自带元数据，因此实际 system 不是严格只有一个文本块。技能清单与 Skill 调用、Agent fork、内置压缩、hooks 和 MCP 均已用真实 SDK + 假 API 走通；抓包与前 300 字见 `v081-cloud-result.md`。

新会话及新任务使用 App 设置中的当前 model：动态、点子、夜间整理、补读、目标跟进、旁聊、自动旁聊标题及活动标题摘要都取消固定模型。SDK 的默认 Haiku/Sonnet/Opus、子代理和两个自动权限分类器也配置为当前选择。语音转文字仍使用已有音频模型，健康同步等无模型的任务照旧。

同一服务内切换模型，通过 SDK `setModel` 更新已打开的主会话和独立会话，从这些会话的下一次请求起生效；同时更新分类器及子代理模型的环境配置。更换服务、服务地址、Key 或可用模型清单时，主会话等当前轮结束，再用原 session id 重开；运行中的独立会话和 fork 使用启动时的服务、Key 和模型完成。新任务使用当前选择，标题概括在实际发起请求时读取设置。云端不设 ModelGateway，也不改写模型请求体；CLI 使用所选服务的地址和凭据，代理变量照常继承。

新建旁聊未显式指定 title 时，结束后使用同一当前模型异步补上 title/summary；显式标题和既有旁聊名称保持原样。

### 自定义模型服务（0.8.1 新增）

模型单选项改为 `{provider,id}`；原来的 model 字符串只在启动迁移中转为 `{provider:"zenmux",id}`，运行时和接口都不接受字符串。`GET /api/settings` 的旧平铺 `models` 数组改为 `providers` 分组，App 按服务分组、按 model.provider + model.id 判断选中项。权限字段沿用原约定。例：

```json
{
  "model":{"provider":"zenmux","id":"anthropic/claude-haiku-5.5"},
  "permissionMode":"auto",
  "providers":[
    {"id":"zenmux","name":"ZenMux","builtin":true,"protocol":"anthropic","models":[
      {"id":"anthropic/claude-haiku-5.5","name":"Claude Haiku 5.5","note":"消耗约 1×；输入超过 100K 后约 5×"},
      {"id":"anthropic/claude-opus-5.5","name":"Claude Opus 5.5","note":"消耗约 40×；缓存读约 20×"},
      {"id":"z-ai/glm-5.3-flash","name":"GLM 5.3 Flash","note":"输入约 1.5×，输出约 1×；缓存读约 3×"},
      {"id":"z-ai/glm-5.3-flashx","name":"GLM 5.3 FlashX","note":"输入约 3.75×，输出约 2.5×；缓存读约 7.5×"}
    ]},
    {"id":"019b640d-3800-40c1-8d83-a21a178d10bb","name":"我的服务","builtin":false,"protocol":"anthropic","baseUrl":"https://models.example.test/anthropic","keyHint":"2468","models":[{"id":"my-model-v1","name":"我的模型"}]}
  ],
  "permissionModes":[{"id":"auto","label":"自动","note":"不问用户，自动拦下危险操作"},{"id":"bypassPermissions","label":"完全放行","note":"什么都不拦"}]
}
```

内置 ZenMux 不返回 baseUrl 或 keyHint，不能编辑、删除。自定义服务的 id 由云端生成，协议固定为 `anthropic`，Key 从不在接口、事件或日志中返回。`keyHint` 是末四位；不足五位的 Key 用 `••••` 表示。

| 接口 | 请求与返回 |
|---|---|
| `GET /api/settings` | 返回上面的选中项、服务分组和权限选项。 |
| `PUT /api/settings` | `{model?:{provider,id},permissionMode?}`；模型必须属于已有服务，成功 200 返回完整设置。 |
| `POST /api/providers/test` | `{baseUrl,apiKey,model}`，model 是要测试的模型 ID 字符串；成功 200 `{ok:true,ms:123}`，失败 400 `{error:"HTTP 401：服务错误摘要"}`。只测试，不保存。 |
| `POST /api/providers` | `{name,baseUrl,apiKey,models:[{id,name}]}`；用第一个模型测试，通过后保存。200 `{provider:完整的公开服务对象}`，格式同 providers 数组里的项。 |
| `PATCH /api/providers/<id>` | name、baseUrl、apiKey、models 均可选；apiKey 缺省或空白时保留原 Key。修改 baseUrl、非空 apiKey 或 models 会重新测试；仅改名不测试。200 `{provider}`。 |
| `DELETE /api/providers/<id>` | 200 `{ok:true}`；删除当前选中模型所在服务返回 409 `{error:"先换到别的模型"}`。编辑模型清单时移除当前选中的模型也返回同样的 409。 |

校验：服务名和模型显示名各 1–40 字；模型 1–20 个、模型 ID 1–200 字，同一服务内 ID 不重复。名称和 ID 去除首尾空白，不接受换行；Base URL 必须是 http/https，不带账号、query 或 hash，去掉结尾 `/`。地址作为 API 根路径，云端和 SDK 会在其后拼接 `/v1/messages`。API Key 必填，不能带换行。未知字段、协议修改、内置项修改为 400；不存在的服务为 404。

设置选择、权限或服务清单成功变更后，向所有在线 App 推完整设置事件，其他设备用它更新设置页面。字段平铺，与 `GET /api/settings` 一致：

```json
{"t":"settings","model":{"provider":"019b640d-3800-40c1-8d83-a21a178d10bb","id":"my-model-v1"},"permissionMode":"auto","providers":[{"id":"zenmux","name":"ZenMux","builtin":true,"protocol":"anthropic","models":[{"id":"anthropic/claude-haiku-5.5","name":"Claude Haiku 5.5","note":"消耗约 1×；输入超过 100K 后约 5×"}]},{"id":"019b640d-3800-40c1-8d83-a21a178d10bb","name":"我的服务","builtin":false,"protocol":"anthropic","baseUrl":"https://models.example.test/anthropic","keyHint":"2468","models":[{"id":"my-model-v1","name":"我的模型"}]}],"permissionModes":[{"id":"auto","label":"自动","note":"不问用户，自动拦下危险操作"},{"id":"bypassPermissions","label":"完全放行","note":"什么都不拦"}]}
```

上例为篇幅省略了 ZenMux 的其余三个模型，实际事件始终包含完整分组。

服务保存在 `system/providers.json`，选择保存在 `system/app-settings.json`，均为 0600；启动迁移保存旧设置的 0600 备份，记录在 `system/migrations/v081-providers.json`。服务 Key 加入连接器的脱敏集合，退役 Key 在本进程内仍继续脱敏；模型不能直接读写服务私有文件。

选中自定义服务时，SDK 的 `ANTHROPIC_BASE_URL` 使用服务地址，`ANTHROPIC_AUTH_TOKEN` 使用 Key，子进程不传 `ANTHROPIC_API_KEY`；模型 ID 原样交给 SDK。原服务的自定义鉴权头、OAuth 和其他协议的选择变量不带入新服务，HTTP(S)_PROXY / ALL_PROXY / NO_PROXY 与 PATH 继续继承。已经运行的 fork 在原 query 中完成；原 query 结束后回收，结果交给当前主会话。新主会话仍续原 session id。

动态、点子、夜间整理、补读、目标跟进、旁聊及活动标题摘要都使用所选服务和模型；语音转文字例外。标题摘要和连接测试也读取代理环境。连接测试发送最小非流式 Messages 请求（max_tokens:8），携带 `anthropic-version:2023-06-01`，同时发送 `x-api-key` 与 `Authorization: Bearer`；超时 20 秒。不向 App 暴露服务的完整错误响应，只返回 HTTP 状态和脱敏后的 error.message（最多 200 字符）。连接失败或超时返回固定中文原因。

SDK 0.3.295 抓包实测：未知模型默认会发送 effort，并把部分消息作为 role:system 放进 messages。自定义服务用 SDK 自带的环境开关关闭 thinking、effort、1M、工具搜索、实验性 beta 和 mid-conversation system/tool change 能力，窗口保持 200K，普通输出上限 8192；主聊、fork、动态请求正文均不含 thinking、output_config 或 context_management，messages 只有标准 user/assistant 角色。标题摘要输出上限 1024，也不发 thinking/effort。SDK 仍附带 `claude-code-20250219` 这一条内置 beta 头，未为此增加转发层。本地只实现基础 Messages + SSE 的假服务已跑通，服务可忽略该头；内置模型保持 adaptive thinking / max effort，压缩临时 low。

### 主会话目标跟进与静默后台

`[目标跟进]` 使用主会话原输入流发起新一轮；正在忙时等原轮完成并收到 SDK idle，再投递，不作为插话。不写触发词用户气泡。用户回复时，同一会话已有跟进和 say 的上下文，无需游标或 additionalContext 补入后台说话。

动态、点子、夜间整理、补读、健康同步和委派执行保持后台运行，模型正文只进过程；这些后台及原生 fork 的 say 返回 `isError:true`，文字固定为「后台运行不能对用户说话」。目标跟进的重活可由主会话按原机制委派；任务回报由主会话处理、说话。旁聊 say 只进自己的聊天记录。

### 活动列表、标题与摘要

`GET /api/activities`、`GET /api/state` 的 activities、WS hello.activities 与 activity 事件按同一规则展示：

- 主聊天轮次只有调用过 say 之外的工具才进入列表；纯聊天过程仍保存，但不出现在列表。首次非 say 工具调用时发送 started；忙时插话归当前同一活动。
- 委派任务回报、浏览器交还等系统发起的主轮也遵守该规则。
- 目标跟进使用主会话，但作为定时跟进活动展示，临时标题如「跟进目标：增肌」，即使只询问进展也保留。
- 动态只有实际产生新帖子时展示；未发帖的运行保留过程，不进入列表或 activity 事件。
- 旁聊作为独立会话入口继续展示；其他独立后台、原生任务与系统维护活动照常展示。

主聊天普通工作轮进行中先用「处理中」，不显示用户原话。结束后异步用 App 当前选中的模型概括用户消息、工具步骤和 say，补上中文 title（≤14 字）与 summary（一句、≤40 字）。概括请求无工具、不进入主会话、不生成新活动；失败保留临时标题，summary 为空串。列表 running/recent 都有 summary 字段，初始可为空。

补全后推送：

```json
{"t":"activity","phase":"updated","id":"activity-id","title":"查询注册手机号","summary":"查阅注册要求并解释了虚拟号码限制"}
```

按 id 更新当前条目；updated 不表示又开了一轮。排序仍按原来的 started/ts，不因标题更新跳动。主聊天用户和 assistant 气泡带 activityId；所有 id（包括纯聊天、未发帖动态）均可用 `GET /api/activities/<activityId>/history` 查询过程。activity_step 不是加入列表的信号。主聊天忙碌及停止继续看 status.busy / interrupt。

### clientId：提交去重

以下四个 POST 请求新增可选的 `clientId`，为 1–64 个字符，建议每次用户提交生成一个 UUID，网络重试复用原值：

- `/api/send`：`{text,attachments?,clientId?}`。
- `/api/activities/<id>/send`：`{text,attachments?,clientId?}`。
- `/api/side-chats`：`{text,attachments?,title?,clientId?}`。
- `/api/feed/feedback` 的 discuss：`{path,action:"discuss",text?,clientId?}`。

四个接口共用 clientId 空间。鉴权和 JSON 解码成功后，自第一次接收起 10 分钟内，同一 id 的并发或重试直接返回第一次的 HTTP 状态和 JSON，包括业务校验错误；不再写记录或投递模型。不要把同一个 id 用于不同操作。省略时每次照常执行。去重仅驻留内存，服务重启后清空；等待中的首个请求仍共享同一次执行。赞、踩不参与此去重。

### 讨论动态的 quote

App 点讨论先把引用挂在输入框，发送时才提交：

```json
{"path":"data/feed/2026-10-16/0900-新品.md","action":"discuss","text":"对我有什么影响？","clientId":"discuss-request-id"}
```

用户气泡在主聊天历史、WS user 与重新连接的 hello.history 中统一为：

```json
{"role":"user","id":"user-message-id","activityId":"main-turn-id","text":"对我有什么影响？","source":"feed","ts":1792108800000,"quote":{"kind":"feed","path":"data/feed/2026-10-16/0900-新品.md","title":"新产品发布","emoji":"🚀","source":"测试发布站"}}
```

quote 的 kind 固定为 feed，path 是原帖路径，title/emoji/source 是发送当时的标题、图标和来源快照；emoji/source 没有值时为空串。App 用 text 渲染用户的话，用 quote 渲染小引用卡，不把整篇帖子拼进用户气泡。text 可为空串，引用卡仍显示；模型收到完整标题、来源、URL、正文和帖子路径，空评论以「聊聊这条动态。」作为模型侧问题。历史接口仍为 `GET /api/history`。

### 目标卡校验

say 的 `{type:"goal",name}` 必须指向 `data/goals/<name>.md` 中已存在且能通过目标解析器的文件。文件缺失、路径非法、frontmatter 或 cron 不合法时，整次 say 返回工具错误，不产生文字、选项、卡片、通知或消费记录：

```json
{"isError":true,"content":[{"type":"text","text":"data/goals/增肌.md 还没写好（或格式不对），先按系统提示词里的目标格式写好再发卡片。"}]}
```

先写目标文件，再发卡片；卡片仍只传 name，没有新增字段。版本号在 package.json、state 和 hello 中均为 0.8.1。

## 主聊天和首次使用

`GET /api/state` 示例：

```json
{
  "version":"0.8.1",
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
| `POST /api/send` | `{text,attachments?,clientId?}` | 200 `{ok:true,id:"用户消息 id"}` |
| `POST /api/first-chat` | `{device:"android"}` 或 `{device:"mac"}` | 200 `{started:true,id}`；已经有聊天记录则 `{started:false}` |
| `POST /api/options/choose` | `{messageId,optionId}` | 200 `{ok:true,id,messageId,optionId}`；id 是发出的用户消息 id |

首次聊天接口只在主聊天为空时触发。并发调用合并为同一次，提交给模型的原文为 `[第一次聊天] 设备：android` 或 `[第一次聊天] 设备：mac`，source 为 `onboarding`。介绍、起名、推荐连接应用由系统提示词决定。

文字与附件不能同时为空，文字 UTF-8 最多 32KiB。上传继续使用 `POST /api/upload?name=<文件名>`，原始二进制 body，最多 20MiB，返回 `{path,name,size}`，路径为 `data/uploads/<YYYY-MM-DD>/<HHMMSS>-<文件名>`，重名自动加序号。随后发送：

```json
{"text":"看看这张图","attachments":[{"path":"data/uploads/2026-10-15/090000-image.png","name":"image.png","kind":"image"}]}
```

附件 kind 为 `image|file|voice`；size 由服务端实测，客户端可省略，伪造 size 不改变限制。只接受 uploads 内的已有文件；图片转换成 SDK image 块，voice 保留语音笔记流程。按住说话的转写仍为 `POST /api/transcribe?format=aac`，支持 wav/mp3/aac/ogg/flac/m4a。

忙时发送的消息立即持久化、广播，并交给正在运行的 SDK AsyncIterable；模型在下一次请求中能看到，通常位于工具结果内的提醒中。正在进行的 HTTP 模型请求和工具不会被强行终止。没有忙时消息队列、修改或撤回操作。主会话和独立会话切换模型后，从各自下一次请求起生效；已经运行的 fork 保留启动模型，新 fork 使用当前选择。忙时插话不重置当前轮。

## say：模型对用户说话

进程内 MCP server 名 `doudou`，工具名 `say`，模型实际调用 **`mcp__doudou__say`**。每次调用独立创建一条 assistant 气泡，立刻广播、保存并通知在线设备。主聊天和旁聊使用这个出口，后台调用会返回工具错误。

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
- 模型正文与 result.result 均只进过程，不生成 fallback 气泡。主聊天与旁聊用 Stop 最多提醒一次补发 say，详见 0.8.1。
- 目标跟进由主会话发起，say 进入主聊天。后台独立会话及原生 fork 调用 say 返回「后台运行不能对用户说话」。`turn_end` 不负责创建气泡。
- 工具、thinking、中间步骤都不进入聊天气泡。工具摘要只在活动页显示。

| type | 字段 | App 行为 |
| --- | --- | --- |
| `connector` | `id`：已支持的连接器 id | 打开该连接器详情/连接账号 |
| `goal` | `name`：目标文件名，不含 `.md`，须已存在且能解析 | 展示已写好的目标并打开详情，卡片不创建目标；无有效文件则整次 say 工具错误 |
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

历史没有 `t`，有选项时额外带 `optionsUsed:false|true`。`activityId`、`options`、`cards`、`media`、`error` 只有适用时出现。

## WebSocket

连接 `/ws?role=app`。连接后先收：

```json
{"t":"hello","version":"0.8.1","busy":false,"avatar":{"state":"waiting"},"activities":[],"devices":[],"history":[]}
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
| `user` | `role:"user",id,activityId,text,source,ts,attachments,quote?` | 立即显示用户气泡和可选引用卡；source 可能是 app/http/option/feed/idea/onboarding/maintenance |
| `say` | 上述 assistant 消息 | 新增或按 id 完成气泡 |
| `options_used` | `messageId,optionId` | 禁用该气泡的全部按钮 |
| `status` | `busy,reason?` | 主聊天运行情况；reason 如 user/task_result/activity_continuation |
| `avatar` | `state,text?` | 更新头像和工作状态文字 |
| `turn_end` | `activityId,text,error?` | 主轮完成信号，成功时 text 为空，异常按 error 处理。不创建气泡，也不代表 SDK 已 idle |
| `activity` | `phase:"started"\|"done"\|"updated",id,title?,summary?,status?,ts?,outputs?` | 工作主轮、目标跟进、发帖动态及其他可见活动；updated 按 id 补 title/summary，状态以 history/list 为准 |
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

在线设备仍使用 `/ws?role=device`，register/result/call 的协议保持。每条说话会向设备发 `{t:"event",kind:"reply",messageId,text}`，text 最多 300 字符；设备按前台状态和本机通知设置决定是否发系统通知。后台完成本身不再生成聊天结果卡片或重复通知；委派任务回报交给主会话，主会话需要告知用户时调用 say。没有设备在线时不提供独立离线推送。

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

部署使用常驻的系统服务 `personal-agent-browser.service`（User=agent），兼容目标机 systemd 239 / cgroup v1。Chrome/Xvfb 按需启动、10 分钟空闲关闭，构件缩略图复用同一个 Chrome；浏览器服务 800M、允许 swap，本体单独保留 900M。配置和目标机验证步骤见 [browser-memory.md](browser-memory.md)。App HTTP/WS 与卡片字段不变；浏览器崩溃后下次使用可重开。

## 动态

| HTTP | 参数/请求 | 返回 |
| --- | --- | --- |
| `GET /api/feed?days=7&before=2026-10-15` | days 为 1–31 个有帖日期；before 可省略，排除这个日期及更新的日期 | `{days:[日期...],items:[帖子...],next:下一页日期游标或null}` |
| `GET /api/feed/item?path=<data/feed/...md>` | 完整帖子路径 | 单条帖子，不限制日期；没有则 404 |
| `POST /api/feed/feedback` | `{path,action:"like"\|"dislike"\|"discuss",text?:"讨论的话",clientId?}` | `{ok:true}`；讨论另有发起聊天的用户消息 id，clientId 仅讨论生效 |
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

动态使用 App 当前选中的模型，和主聊天一致；从 `spec/prompts/feed.md` 读取触发正文，首行时间替换为上次成功完成的本地时间，首次去掉整个「上次：」片段。成功运行但没有新帖也更新时间；失败不更新。已有一次动态在排入后台或运行时跳过下一次，手动刷新也遵守此锁。

反馈写入 `data/feed/反馈.jsonl`，每行例如：

```json
{"path":"data/feed/2026-10-15/0900-新品.md","title":"一句话事实","action":"讨论","text":"这个对我有什么影响？","ts":1792029600000}
```

讨论把标题、来源、URL、正文、帖子路径与用户问题作为 `[讨论动态]` 消息送入模型；聊天只存用户的话和 quote，source 为 feed，格式见 0.8.1 节。空评论在模型侧为「聊聊这条动态。」。普通赞/踩不启动模型。

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

每次调度检查重新扫描 goals 根目录，不需要重启；增删改在下次检查生效，最长约 15 秒，运行判断按分钟去重。只有追踪中的目标生成 `goal:<目标名>` 安排；提示词取 `goal-checkin.md`，替换全部 `<目标名>`，在主会话空闲后发起新一轮跟进。完成或放弃的文件移至 `goals/done/`。

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
| `GET /api/activities?limit=30&before=<毫秒>` | `{running:[{id,label,title,summary,started}],recent:[{id,label,title,summary,status,ok,ts,outputs}],next:<毫秒或null>}` |
| `GET /api/activities/<id>/history` | `{id,title,status,items:[{kind,text,time,from?,tool?,attachments?,media?}]}` |
| `POST /api/activities/<id>/send` | `{text,attachments?,clientId?}`，200 `{ok:true,id:"原活动id"}` |
| `POST /api/activities/<id>/stop` | 无 body，200 `{ok:true,id}` |

列表包括调用过非 say 工具的主轮、目标跟进、已发新帖的动态，以及其他后台和旁聊。纯聊天和无新帖的动态不列出，过程照留。标题/摘要更新事件见 0.8.1；聊天插话进入同一过程。recent 默认 30 条、limit 1–100，before 排除该毫秒及更新的记录。相同毫秒整组返回，可能略超 limit；next 是末条时间，null 表示没有下一页。只有首页带 running。状态为 running/done/error/stopped，输出文件在 outputs。标题和时间均持久化。

items.kind 为 prompt/text/tool/result；Stop 提示保存在 text 步骤，tool 为 Stop，speech:true 标记真实 say 的文字。prompt 的 from 区分 user/agent；tool 仅返回短摘要，隐藏 thinking、原始工具结果、base64 和凭据。运行中可每 3 秒刷新详情，结束后停止轮询。主聊天步骤直接持久化；原生任务仍可从本数据根内 SDK transcript 读取或回填。

续聊保持原活动 id。原生任务父会话还在且没有附件时使用 SDK SendMessage；其他情况使用原目标、交代、步骤、结果和用户后续交代，在隔离会话续聊，有原独立会话可恢复时 resume。图片使用真实 SDK image 块。切换为隔离会话前会停止同一原生 worker，避免并发写同一活动；重启后无需旧运行对象也能继续。详情/索引在 system/activity-index.json，权限 600。

## 控制台：定时、权限、记忆

`GET /api/schedules` 返回 `{items:[{id,name?,kind?,cron?,enabled,running,nextRun,prompt?,goal?,interval?,start?,end?,error?}]}`。

- `POST /api/schedules/<URL编码id>/run`：202 `{mode:"isolated",id:"活动id"}`，目标跟进为 `{mode:"main",id}`（可正在等主会话空闲）；同一安排已有运行则 `{mode:"skipped",reason:"running"}`。手动运行可执行已停用的安排。
- `PUT /api/schedules/<id> {enabled:false|true}`：返回该安排完整条目。目标停用状态独立保存在 system/schedule-overrides.json，修改目标正文不清掉停用状态。
- feed 无 cron，按窗口与间隔；ideas 为 `0 8 * * 1`；night 保留原 id，`30 22 * * *`；health-sync 为 `0 */3 * * *`，直接同步设备、不调用模型；compact/cleanup 保留。
- 目标跟进在主会话空闲后执行，排入等待期间不向主聊天插话。动态、点子、夜间整理和补读不占住主聊天。受现有机器内存约束，独立后台模型会话串行执行；在等待执行时也算该安排已运行，不重复积压。不同后台安排可在主聊天期间执行。
- 夜间整理继续使用 seed 的 prompt；动态/目标/点子每次从 spec/prompts 读取当前文件。system-prompt 使用分隔线后的正文和占位符替换。

`GET /api/settings` 与 `PUT /api/settings` 使用 `{provider,id}` 模型选择、`providers` 分组与原 permissionMode/permissionModes 字段；完整格式及 `/api/providers` 的 CRUD/test、settings 事件见本文 0.8.1「自定义模型服务」。权限为 auto（默认）或 bypassPermissions，两种都不向 App 发权限审批弹窗，关键对外动作由提示词要求先发 say 选项。模型服务变化在轮间续原会话；已运行的后台会话和 fork 保留启动环境。上下文统一 200K，使用内置压缩；内置模型为 max effort，压缩临时 low，自定义模型关闭不通用的推理参数。

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

agent 的 PreToolUse 守卫始终拒绝修改 health、uploads 及连接器维护的技能；仅在 `[动态]` 后台运行中拒绝修改 feed/动态说明.md，含该运行的原生 fork。原始数据可以用 cat/ls/Python/pdftotext 读取，复制或转换到 workspace/tmp 也允许；Bash 按修改源或写入目的地检查删除、移动、复制、重定向、解压、权限等操作。用户后来从活动页发起的普通续聊属于另一次运行，权限不因旧活动曾是动态而永久锁定。文件工具处理真实路径和符号链接；Bash 为常见命令检查，仍不是操作系统文件隔离。

## 启动迁移与移除项

首次启动在写入 `system/migrations/v08.json` 前执行一次迁移，先复制源数据与定时/聊天记录到 `backup/migrate-v08-<时间>/`，有 manifest。路径冲突、损坏配置或源符号链接会报错，不覆盖同名文件。旧根内容移到新根，不留下软链接：

- briefs 整体留在备份，运行目录删除；sites → library/artifacts；files → library/media；diary → soul/diary；memory/role/角色.md → soul/角色.md。
- task-index.json → activity-index.json；记录中的旧交付路径重写。聊天备份后移除旧完成卡片、补齐消息 id、重写旧交付链接。
- 移除晨报/晚报/健康周报安排、旧头像 shape/palette 设置、旧 jobs.jsonl、旧 memory/health/latest.json。保留自定义安排，补 feed/ideas/health-sync，night 的 id 不变、时间对齐 22:30。

已删除的 HTTP：`/api/briefs`、`/api/briefs/item`、`/api/jobs`、`/api/tasks/<id>/{history,send,stop}`、`/api/run`、`/api/profile`。旧 WS `unqueue`、`edit_queued`、`queue_update`、`stop_task`、`task_stop`、hello.queued、hello.tasks 和旧 job/结果卡片协议不再提供。

简报 HTML 校验/渲染、基础 CSS、按钮脚本、三种 skin、briefGuideFile、旧简报迁移脚本及相关测试全部删除。page.screenshot 只认 library/artifacts。旧 docs/v04、v05、v06 是历史记录，不作为 0.8 对接依据。

## 本地 SDK 实验与可复现验收

锁定 SDK 0.3.295。`test/sdk-interjection.test.mjs` 用真实 CLI、回环 fake Anthropic 服务和两个 Read 工具：第一个工具执行中向 AsyncIterable 填新消息；下一次模型请求已包含这条消息，且此前 result 数为 0。完整运行层下，SDK 也可能把插话放进 tool_result 内的提醒；应检查模型请求内容，不能只检查顶层 user 文本。

`node scripts/verify-v08.mjs` 会启动临时数据根、真实 SDK、假模型和 HTTP/WS 服务，日志在 `/tmp/v08-cloud-demo/`。覆盖两次 say、工具期间插话、带选项、首次/重复点击、正文只进过程、活动步骤，以及聊天选择 Opus 时动态的真实 wire model 也为 Opus。没有调用外部模型或真实设备，不代表线上/App 集成已验收。

`node scripts/verify-v08-browser.mjs` 用本机真 Chrome、假模型和本地测试页，验证主聊天与独立旁聊各自的接管→App 点击→交还→原输入流继续→say；包括鉴权、实时画面、waiting 和不使用浏览器的动态懒启动。日志在 `/tmp/v08-cloud-demo/browser/`。没有访问真实网站、个人 profile 或服务器；systemd/cgroup 隔离未在 macOS 上宣称实测。

## 0.8 补充：新建旁聊

旁聊是抽屉中可另开的独立聊天。每个旁聊对应一个持久化的活动 id；新建时创建全新的 SDK 会话，不复制、不恢复、不注入主聊天或其他旁聊的消息上下文。用户数据、记忆、权限、连接器和云端浏览器仍属于同一个豆豆。随后一律用原有活动续聊、详情、停止接口，不新建活动 id。重启后恢复该旁聊自己的 SDK 会话；其会话文件不可用时，只用该旁聊自己的记录补充上下文。

本节只新增接口、事件及可选字段，已有请求、响应字段和主聊天事件保持原义。早于本补充的 App 可以忽略新增字段和事件。

### 创建与继续

`POST /api/side-chats`，使用与其他 API 相同的鉴权：

```json
{"text":"单独帮我研究一下这个想法","title":"研究想法","attachments":[],"clientId":"new-side-request-id"}
```

`text`、`attachments` 的格式、上传流程及限制与 `/api/send` 相同；两者不能同时为空。`title` 可省略，提供时为 1–200 个字符且不能全空白；省略时先从第一条文字或附件名取临时标题，结束后异步使用当前选中的模型补上中文标题和摘要；显式标题不被覆盖，已有旁聊不补做历史改名。第一条用户消息随请求持久化并开始处理，无需再调用 send。

成功 **201**，返回的是活动 id：

```json
{"ok":true,"id":"side-activity-id","chatType":"side"}
```

创建成功表示消息已接受，不表示豆豆已回复。未鉴权 401；无效 JSON、空消息、无效附件或标题 400；服务正在关闭 503。校验失败不会留下空旁聊。

后续使用已有接口，id 均为创建时返回的活动 id：

| HTTP | 请求 | 成功 |
| --- | --- | --- |
| `POST /api/activities/<id>/send` | `{text,attachments?,clientId?}` | 200 `{ok:true,id}`，id 仍是同一个活动 id |
| `GET /api/activities/<id>/history` | 无 | 原有 `{id,title,status,items}`，另加本节的 `chatType,messages` |
| `POST /api/activities/<id>/stop` | 无 | 原有 200 `{ok:true,id}` |

正在运行的旁聊收到补充时，消息交给它自己的 AsyncIterable 输入流。旁聊运行与主聊天彼此独立，不中断主聊天，不改变主聊天的 `busy`，也不向主聊天输入流发消息。云端仍限制同一时间只运行一个独立活动，以控制内存；尚未取得运行资源时收到的消息会按提交顺序保留。头像依旧综合所有活动。

### 列表和详情的新增字段

复用 `GET /api/activities?limit=30&before=<毫秒时间>` 的原有分页。旁聊条目在 `running`、`recent` 中都有 **`chatType:"side"`**；`/api/state.activities`、WS `hello.activities` 和该旁聊的 `activity` 事件也带此字段。其他活动可不带该字段。App 筛选 `chatType === "side"` 即得到旁聊列表，按原有 next 游标继续分页。

```json
{"running":[],"recent":[{"id":"side-activity-id","label":"研究想法","title":"研究想法","chatType":"side","status":"done","ok":true,"ts":1792029600000,"outputs":[]}],"next":null}
```

`status:"done"` 只表示当前这轮完成，仍可续聊。`items` 保留原有步骤明细；新增的 `messages` 是该旁聊按写入顺序排列的全部聊天气泡，供聊天视图使用。两者用途不同，不要把 steps 和 messages 合并成重复气泡：

```json
{
  "id":"side-activity-id","title":"研究想法","status":"done","chatType":"side",
  "items":[{"kind":"prompt","from":"user","text":"单独帮我研究一下这个想法","time":"2026-10-15T02:00:00.000Z"}],
  "messages":[
    {"role":"user","id":"side-user-message-id","text":"单独帮我研究一下这个想法","ts":1792029600000,"source":"app","activityId":"side-activity-id","chatType":"side"},
    {"role":"assistant","id":"side-bubble-id","text":"我们从哪方面开始？","ts":1792029601000,"activityId":"side-activity-id","chatType":"side","options":[{"id":"0","label":"调研","reply":"先调研一下"}],"optionsUsed":false,"cards":[{"type":"link","url":"https://example.test/idea","title":"参考资料"}]}
  ]
}
```

messages 中的 `options,cards,media,error,attachments` 与主聊天消息格式相同；有选项的历史气泡带 `optionsUsed`。用户消息 source 为 `app`，选项回复为 `option`。正文和 result.result 只进 items；聊天只有 say，Stop 每轮最多提醒一次。忙时插话不重置，下一次续聊开始新运行时重置。异常提示留在这个旁聊，带 `error:true`。

### 旁聊消息事件与选项

现有 App WS 连接新增 **`activity_message`** 事件，用户消息和 assistant 气泡都通过它发送。按 `activityId` 路由到对应旁聊，再按消息 `id` 合并；未打开该旁聊时可更新其列表。这个事件不进入主聊天。旁聊不发送主聊天的 `user/say/delta/turn_end` 事件，也不触发主聊天的 reply 系统通知。活动步骤和轮结束仍使用现有的 `activity_step`、`activity` 事件。

```json
{"t":"activity_message","role":"assistant","id":"side-bubble-id","text":"我们从哪方面开始？","ts":1792029601000,"activityId":"side-activity-id","chatType":"side","options":[{"id":"0","label":"调研","reply":"先调研一下"}]}
```

`say` 的工具名和参数不变，模型不用填写会话 id。云端自动将旁聊及其工具内部的 say 指向该旁聊；普通后台活动与原生 fork 的 say 返回「后台运行不能对用户说话」。browser 卡片仍指向共享的当前浏览器会话，浏览器协议见 [browser.md](browser.md)。

点击旁聊里的选项时，给原有 `POST /api/options/choose` **额外带 `activityId`**：

```json
{"activityId":"side-activity-id","messageId":"side-bubble-id","optionId":"0"}
```

成功 200 `{ok:true,id:"side-user-reply-id",messageId:"side-bubble-id",optionId:"0",activityId:"side-activity-id",chatType:"side"}`，其中 id 仍是选项产生的用户消息 id，额外的 activityId 标记旁聊归属。回复写入该旁聊并从原输入流或原会话继续，整组选项永久失效，重启后仍失效。重复点击 409，找不到气泡/选项 404；activityId 指向非旁聊活动时 400。省略 activityId 仍按原协议选择主聊天里的选项，不会搜索旁聊或把旁聊回复发进主聊天。

WS `choose_option` 同样只新增可选的 activityId；消费事件也新增会话标记：

```json
{"t":"choose_option","activityId":"side-activity-id","messageId":"side-bubble-id","optionId":"0"}
{"t":"options_used","activityId":"side-activity-id","chatType":"side","messageId":"side-bubble-id","optionId":"0"}
```

WS hello.history 和 `/api/history` 继续只返回主聊天。旁聊不影响 `chatEmpty/firstChat` 或首次聊天触发。旁聊记录保存在 `system/side-chats/<活动id>/chat.jsonl`，选项消费保存在同目录 `options.json`，会话和活动索引仍使用原有持久化机制；App 不直接访问这些文件。

## 0.8 补充：活动标题与首次聊天

以下为后台或明确触发的友好标题映射，不把内部方括号触发词作为标题；主聊天普通工作轮使用 0.8.1 的「处理中」和异步概括。列表的 title/label、活动详情 title 和 activity 事件 title 使用同一个展示名称：

| 触发 | 展示标题 |
| --- | --- |
| `[第一次聊天]` | 第一次聊天 |
| `[动态]` | 看看有没有新动态 |
| `[目标跟进] X` | 跟进目标：X |
| `[点子]` | 想一批点子 |
| `[夜间整理]` | 夜间整理 |
| `[补读] X` | 补读 X |

设备信息、上次运行时间和下一行的完整提示词不进入展示标题。普通主聊天不再用消息原话当标题；显式指定的旁聊标题作为会话入口保持原样；新建且未指定标题的旁聊结束后可异步概括。已有活动的旧标题在读取、重启或续聊时保留，不做历史迁移。

首次聊天的 `[第一次聊天] 设备：android|mac` 仍原样交给模型，并作为 source 为 onboarding 的内部记录保留，供首次触发去重、会话恢复和活动追踪使用。云端不为它发送 WS user 事件，`GET /api/history` 和 WS hello.history 也不返回这条内部用户记录。App 无需为它创建用户气泡；豆豆随后只有 say 显示为聊天气泡，普通正文只进过程。首次聊天接口、返回字段、设备校验和并发去重规则不变；接受首次触发后 chatEmpty 为 false，即使豆豆还没有说出第一句。
