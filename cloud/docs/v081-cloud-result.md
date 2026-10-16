# v08-cloud · 0.8.1 result（A–F 修订后）

本文件以用户最后确认的 A–F 为准，替换上一版「显示最终正文、后台说话游标、排除所有主聊天活动」方案。版本仍为 0.8.1。只改 cloud；没有连接服务器、读取密钥文件、部署或执行 commit / push / tag，没有修改并行的 Android、Mac 或 spec 文件。

## A：聊天只有 say，Stop 最多提醒一次

- 删除最终正文显示、正文 delta、fallback 气泡和 result.result 兜底气泡。主聊天、旁聊和后台的正文都只保存过程；没有任何模型正文通道会创建聊天气泡。系统异常仍保留现有 error:true 提示。
- 新增 TurnSpeech，记录本轮 say 的文字、正文及是否已经提醒。主聊天、旁聊安装 Stop hook；后台不安装。最后一条 assistant 有正文，且不与任一次 say 相同或被它包含时，返回 decision:block。整轮没 say 但写过正文也会提醒。
- 理由严格为：

> 你最后写的这段正文用户看不到。要告诉用户的话用 say 发出（短句，可以分几条）；如果只是旁白或总结，直接结束。

- stop_hook_active 为 true 或本轮已提醒时直接放行，忙时插话不重置；下一轮重新检查。空白归一化去重，最终正文比某次 say 多出内容时仍会提醒。

### SDK 0.3.295 实际表现

先做了长连接 AsyncIterable 的独立实验，再接入 Harness。真实 SDK + loopback 假模型，在同一个 query 内完成两轮：

```json
{
  "stops": [
    {"active": false, "text": "第一轮用户看不到的正文"},
    {"active": true, "text": "补发给用户的短句。"},
    {"active": false, "text": "第二轮第一次正文"},
    {"active": true, "text": "第二轮仍然只写正文"}
  ],
  "results": ["success", "success"],
  "requests": {"first": 3, "second": 2},
  "bubbles": 1
}
```

active 是 SDK 输入 stop_hook_active 的记录。第一次 block 后，模型在下一次请求里看到理由并调用 say；第二轮被提醒后仍只写正文，第二次 Stop 放行并正常结束，没有循环。两个 result 都在该轮处理完 Stop 后才到达，查询保持可接收下一条输入。实验日志是 `/tmp/v081-cloud-demo/stop-probe.log`。

接入后的实测还覆盖：先 say 再写正文，被拦一次后补发 say；旁聊同样会补说，且气泡只保存在自己的 messages。独立实验不是仅根据 SDK 类型声明推断支持。

## B：工作轮次成为活动，异步概括标题与摘要

- 主聊天普通轮临时标题为「处理中」，不再把用户原话或内部触发消息做标题。第一次调用非 say 工具时，该轮进入 running 并推 started；纯聊天只留过程，不进列表或 activity 事件。
- 系统发起的主会话轮次同样按非 say 工具判断。插话继续归本轮。目标跟进按 C 作为活动展示，即使只是询问进展也保留，临时标题为「跟进目标：…」。旁聊是独立会话入口，继续展示。
- 动态只有生成了新的有效帖子才展示；未发帖的运行保留过程但隐藏。文件工具写入可立即识别，结束时再扫描新增帖子，以覆盖 Bash 等写入方式。
- 活动结束后异步请求 App 当前选中的模型，adaptive thinking / low effort、最多 1024 输出 tokens，根据用户交代、工具步骤、say 生成中文 title（≤14 字）和 summary（一句、≤40 字）。直接使用 HTTP 请求，不额外启动一个 SDK 子进程，也不占住主聊天。生成失败或格式不符保留临时标题和空摘要。
- running、recent 均增加 summary（初始可为空串）；补全后推 activity / phase:updated，带 id、title、summary。标题和摘要持久保存，异步完成不会改变列表时间排序。显式旁聊标题不被概括覆盖。
- 所有过程 id 都能用原 history 接口读取，包括没有列入列表的纯聊天或无新帖动态；activity_step 不是加入活动列表的信号。

## C：目标跟进直接进入主会话

- scheduler 的 goal 使用 runMain，向主会话原输入流投递；忙时只在内部等待，等 SDK idle 后开启新一轮，不作为当前轮插话。排队和执行期间同一安排保持 single-flight。
- 触发提示词不写成用户聊天气泡；完整提示词和后续 say 已经存在于同一 SDK 会话，用户回复自然沿用上下文。原有目标提示词读取及占位符替换保留。
- 删除后台说话日志、持久游标和 UserPromptSubmit 注入代码。不会再读取或消费上一版的后台说话状态文件。
- 动态、点子、夜间整理、补读、健康同步、委派执行继续后台运行；后台和原生 fork 调用 say 直接返回工具错误「后台运行不能对用户说话」。原生委派完成仍通过 SDK 通知交给主会话，由主会话说话。
- `POST /api/schedules/<goal:id>/run` 改为返回 mode:main；id 是随后主会话跟进活动的 id。等待期间不会伪造一个正在执行的活动或用户气泡。其他安排仍是 isolated，已有运行仍返回 skipped。

## D：say 工具说明

工具说明逐一解释了卡片用途，并明确：

> goal：展示一个已经写好的目标（`data/goals/<name>.md`），卡片本身不会创建目标

同时改为「主聊天在主聊天说，旁聊只在当前旁聊说；后台运行不能对用户说话」，删掉旧的后台直接发往主聊天说明。MCP listTools 的实际说明也有断言覆盖。

## E：自拼完整字符串提示词

- config 新增 basePromptFile。base.md 和 system-prompt.md 各取第一条独立 `---` 以下正文，以一个空行连接，统一替换名字、称呼、时区；第一次构建后只使用缓存字符串。主会话、旁聊、后台、fork 取得同一串，已删除 SDK preset/append 配置。
- 没有修改 spec 文件；使用 lead 提供的 base.md。测试只校验分隔线、拼接顺序、占位符替换和缓存一致，不绑定业务措辞。
- 用真实 SDK 0.3.295 向本机假 API 发请求，只传假 key。自拼字符串完整原样进入 system；main、fork、后台的该文本块一致。
- **核实发现一个 SDK 边界：字符串模式仍会附一条 Agent SDK 通用身份句与计费头。** 它不会再加入 Claude Code 整套预设、Claude Code 身份句或环境段，但不能声称实际 system 只有自拼字符串。公开的 string API 没有去掉这条通用身份句的开关；没有修改 SDK 或剥掉其元数据。

实际 system 的三个 text 块为：

```json
[
  {
    "length": 73,
    "custom": false,
    "text": "x-anthropic-billing-header: cc_version=2.1.295.0ae; cc_entrypoint=sdk-ts;"
  },
  {
    "length": 62,
    "custom": false,
    "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK."
  },
  {
    "length": 17632,
    "custom": true
  }
]
```

自拼正文长 17632 个 UTF-16 单元。三个文本块以空行连接用于阅读时，总长 **17771** 个 UTF-16 单元、UTF-8 **27613** 字节。以下是该连接文本的前 300 个字符（计费头后缀来自本次抓包，可能随 SDK 请求变化）：

```text
x-anthropic-billing-header: cc_version=2.1.295.0ae; cc_entrypoint=sdk-ts;

You are a Claude agent, built on Anthropic's Claude Agent SDK.

You are an agent working with the user toward their goals, using your own judgment along the way. Use the instructions below and the tools available to you to as
```

完整字段：`/tmp/v081-cloud-demo/prompt/system.json`；摘要：`/tmp/v081-cloud-demo/prompt/summary.json`。首行、正文与长度均来自此次实际请求，不是拼 options 后推算的结果。

核实二已实际走通：项目技能出现在工具可用清单并用 Skill 读到内容；Agent 启动原生 fork 并返回；手动 /compact 产生真实压缩请求和 compact_boundary，effort 为 low 后恢复 max；UserPromptSubmit 附加时间、Stop block/active 流程正常；MCP say 产生气泡。自拼字符串在整个流程保持一致。fork 和压缩检查没有改成手写替代实现。

## F：所有事跟随 App 当前模型

- 删除 FEED_MODEL 以及 runIsolated/options 的独立 model 覆盖入口；动态、点子、夜间整理、补读、目标跟进、旁聊都取 App 设置。活动概括在实际发送请求时再读设置，取消固定 Haiku。
- 未提供显式标题的新旁聊，完成后也按相同机制自动概括标题/摘要；显式标题和旧旁聊名称保留。标题补全沿用 activity phase:updated，不新增接口或字段。
- SDK 所有默认模型别名、子代理强制模型、自动权限两个分类器均配置为所选模型；流式控制更新已打开的主会话和独立会话，不重建会话。语音转文字保持既有音频模型。
- 已撤掉 ModelGateway 源码、测试和接线；`ANTHROPIC_BASE_URL`、`HTTPS_PROXY`、PATH 原样传给 CLI，不转发或改写模型请求体。打开的主会话和独立会话继续通过 SDK setModel 切换。
- 已运行的 fork 使用启动时的模型完成；新 fork 使用当前设置。分类器的两个环境变量、子代理强制模型配置保留；本次未触发真实 SDK 的自动权限分类模型请求，也未向线上模型发起真实权限判定。

真实 SDK + 假 API 切换片段（完整 requests.json 在上述 prompt 目录）：

```json
{
  "before": "z-ai/glm-5.3-flash",
  "after": [
    "anthropic/claude-opus-5.5",
    "anthropic/claude-opus-5.5"
  ],
  "feed": "anthropic/claude-opus-5.5",
  "summary": "anthropic/claude-opus-5.5"
}
```

真实 SDK 测试在旧模型的请求未完成时切换，确认后台独立会话、旁聊的下一次请求使用新模型，且 id/上下文保留；已运行 fork 保留启动模型，新 fork 使用新模型。四个 App 模型依次切换的长连接、所有模型的 200K/压缩/计价回归均通过。

## 保留的 0.8.1 修复

- 第 2 条：后台正文只进过程；本次 C 进一步拒绝后台 say。
- 第 5 条：四个提交接口的可选 clientId、10 分钟并发去重、返回第一次结果保持。
- 第 6 条：discuss 保存用户 text + quote；模型仍取得完整帖子，空评论合法。
- 第 7 条：目标卡先检查目标文件存在且解析有效；失败整次 say 不发送。
- 第 8 条：uploads / health 的 Bash 读取和向外转换复制放行，写入、修改、移动、删除等拦截；Write / Edit 仍拒绝。
- 第 9 条：Python / pip 3.11 入口、service PATH、安装依赖及 SDK Bash 继承 PATH 的验证保留。
- 第 10 条：package、lock、hello、state、MCP 的版本均为 0.8.1，协议文档已同步。

## 验证

- `cd cloud && npm test`：**211 / 211 通过**，失败、跳过、取消均为 0，包含真 Chrome 的浏览器测试。
- 所有 `.mjs` 的 `node --check`：**118 / 118 通过**。
- `npm run check`、部署脚本及 pip 入口的 `bash -n`、`git diff --check`：通过。
- 本地实例演示使用真实 SDK、脚本化假模型和 HTTP；聊天、动态及活动概括均请求选中的 GLM 5.3 Flash；另一个实测在轮中切换到 Opus，后续请求、动态及概括都变为 Opus。没有访问线上模型、网站、设备或服务器。
- 原有四模型上下文和计价测试改为先 say 再结束，仍完整校验 200K、167K 压缩阈值、effort 恢复及 Opus 计价，未绕过 Stop 来让测试通过。

主要测试：sdk-prompt-model、sdk-stop、sdk-say、v081-core、v081-http、activity-summary；以及上游地址/代理/PATH 原样传递、fork 模型边界、旁聊、引用/去重、目标卡、Bash 守卫、工具环境、上下文恢复、媒体和浏览器回归。

## 本地演示及实际返回

运行 `cd cloud && node scripts/verify-v081.mjs`。日志和返回保存在 `/tmp/v081-cloud-demo/`：

- chat.json、activities.json、work-activities.json、goal-queued.json、stops.json、summary.json；
- events.jsonl、demo.log、npm-test.log、node-check.log、check.log、stop-probe.log。

实际脚本输出：

```text
main: say -> prose -> Stop block once -> repaired say; chat contains only 2 say bubbles, no fallback
activities: pure chat hidden, research listed with selected-model title/summary; both process histories readable
goal: busy main keeps check-in pending; native idle -> same main stream starts goal -> say; no trigger user bubble
feed: say returned tool error '后台运行不能对用户说话'; prose stayed in process; no-post activity hidden
goal card: missing file rejected the complete say, model corrected with a valid say
discussion: user words + feed quote persisted; repeated clientId reused one result and message
```

### 1. say → 正文 → Stop → 补发 say

Stop hook 实际记录的片段：

```json
[
  {
    "activityId": "2328aa9a-552b-422f-b909-7185812fb032",
    "active": false,
    "decision": "block",
    "text": "都办完了，分头说：这段较长正文必须先被 Stop 提醒，不直接显示。"
  },
  {
    "activityId": "2328aa9a-552b-422f-b909-7185812fb032",
    "active": true,
    "decision": "allow",
    "text": "资料已读完，这是给你的短句结果。"
  }
]
```

`GET /api/history` 中本轮的全部 assistant 气泡如下，正文和 fallback 均未出现：

```json
{
  "items": [
    {
      "role": "assistant",
      "id": "2b6ef47f-e75e-438d-9e94-28fd15620a0b",
      "text": "我已经检查了一部分。",
      "ts": 1792078970197,
      "activityId": "2328aa9a-552b-422f-b909-7185812fb032"
    },
    {
      "role": "assistant",
      "id": "69b1220b-e95e-48c5-aedd-91dc00257107",
      "text": "资料已读完，这是给你的短句结果。",
      "ts": 1792078970253,
      "activityId": "2328aa9a-552b-422f-b909-7185812fb032"
    }
  ]
}
```

### 2. 纯聊天不列出，查资料的活动带标题和摘要

纯聊天完成后，`GET /api/activities` 当时的完整返回（只有先前查资料的一轮）：

```json
{
  "running": [],
  "recent": [
    {
      "id": "2328aa9a-552b-422f-b909-7185812fb032",
      "label": "查询本地资料",
      "title": "查询本地资料",
      "summary": "读取资料并向用户说明了结果",
      "status": "done",
      "ok": true,
      "ts": 1792078970277,
      "outputs": []
    }
  ],
  "next": null
}
```

对应 WebSocket 实际事件：

```json
{
  "t": "activity",
  "phase": "updated",
  "id": "2328aa9a-552b-422f-b909-7185812fb032",
  "title": "查询本地资料",
  "summary": "读取资料并向用户说明了结果"
}
```

纯聊天的过程仍通过它自己的 activityId 查到，演示脚本已断言。

### 3. 忙时目标跟进等到下一轮

`POST /api/schedules/goal%3A增肌/run` 实际返回 body：

```json
{
  "mode": "main",
  "id": "7b9f5421-949e-4704-ad8f-e2c760c1e06a"
}
```

本地在 Read 工具暂停期间观测到的状态（waiting 是内部等待数，不是新增 App 字段）：

```json
{
  "mode": "main",
  "id": "7b9f5421-949e-4704-ad8f-e2c760c1e06a",
  "busyActivityId": "015934dc-319a-4382-a6c8-a291403f02aa",
  "waiting": 1,
  "goalRequested": false
}
```

此时假模型尚未收到目标跟进。释放 Read、收到原轮 result 和 native idle 后，原主会话才开始目标跟进。其聊天历史气泡为：

```json
{
  "role": "assistant",
  "id": "b2259423-5246-4041-bac7-d96877790d73",
  "text": "今天训练了吗？",
  "ts": 1792078970560,
  "activityId": "7b9f5421-949e-4704-ad8f-e2c760c1e06a"
}
```

没有 `[目标跟进]` 用户气泡。独立的原生 SDK 测试还验证了用户接着回答时，模型已在同一会话里看到这句询问，无需游标补入。

### 4. 动态 say 被拒绝

真实 SDK 下一次模型请求的工具结果中包含「后台运行不能对用户说话」，后台运行最终成功结束，只留正文过程；`/api/history` 条数不变，且这次无帖动态没有出现在最终 `/api/activities` 中。没有把工具错误改成用户气泡。

引用与 clientId 也重新实测，`GET /api/history` 中用户引用记录为：

```json
{
  "role": "user",
  "id": "a73f9daf-7c67-4f86-949f-ed2d5309aa94",
  "activityId": "a73f9daf-7c67-4f86-949f-ed2d5309aa94",
  "text": "V081_DISCUSS 这对我有什么用？",
  "ts": 1792078971053,
  "source": "feed",
  "quote": {
    "kind": "feed",
    "path": "data/feed/2026-10-16/0900-新品.md",
    "title": "新工具发布",
    "emoji": "🚀",
    "source": "本地发布站"
  }
}
```

并发重试返回同一个消息 id，只出现这一条引用。完整最终活动列表见 activities.json，共 3 条：两次查资料主轮和一次目标跟进。

## 协议和部署提醒

- 无新增或改名 HTTP 路径。聊天历史沿用 `GET /api/history`，仓库没有 `/api/chat`，未增加兼容别名。
- 行为变化：不再发正文 delta / fallback；turn_end 成功时 text 为空，不创建气泡；主会话工作轮重回活动；无帖动态隐藏；目标安排 mode:main；后台 say 返回错误。
- 新增字段/枚举：running/recent 的 summary，activity 的 phase:updated、title、summary；过程 text 步骤可带 speech:true，Stop 提示的 tool 为 Stop。clientId / quote 约定保持不变。完整对接见 `v08-cloud.md` 的 0.8.1 节。
- lead 部署时仍需同步主服务 unit，daemon-reload 后自行重启本体，确保 PATH 为 `/opt/personal-agent/cloud/deploy/bin:/usr/local/bin:/usr/bin:/bin`。保留 Python 符号链接和 pip 脚本的执行权限。安装脚本不自动重启本体，本轮没有实际执行安装。
- 概括使用服务已有的 Anthropic 网关环境和凭据；部署后需验收目标网关上当前所选模型的实际输出。失败会保留临时标题，不阻塞聊天。
- 部署需一并带上 `spec/prompts/base.md` 与 system-prompt.md，并重启本体载入静态字符串；本次没有改 spec。CLI 保留原上游和代理环境，不需要新增 systemd unit 或反向代理规则。
- lead 对齐提示词时继续使用 `mcp__doudou__say` 和 `[目标跟进] <目标名>`；目标跟进已经在主会话，后台提示词应保持静默，重活通过原委派机制回报主会话。本次未修改 spec 提示词。
- 目标跟进等待数在进程内，尚未开始的定时触发不会跨重启重放；已开始的过程和会话仍按现有机制持久保存。原生 Stop 实验及演示均为本地假模型证据，未宣称线上 GLM / Haiku 行为或真实 App 已验收。
- Bash 守卫仍为常见命令及字面量脚本的检查，不是操作系统沙箱。

## 改动文件

E/F 追加改动：

- `src/config.mjs`、`src/agent.mjs`、`src/app-settings.mjs`、`src/scheduler.mjs`、`src/activity-summary.mjs`、`src/server.mjs`；已删除 `src/model-gateway.mjs` 和 `test/model-gateway.test.mjs`。
- 新增 `scripts/verify-v081-prompt.mjs`、`test/sdk-prompt-model.test.mjs`；更新 harness、prompt-v08、activity-summary、scheduler、query-fixture、sdk-v05、sdk-v08 以及 verify-v08 / verify-v081 脚本；文档同步。
- 没有修改 `src/browser/**`、部署 unit 或音频转写模块。

A–D 改动：

- `src/agent.mjs`、`src/say.mjs`、`src/scheduler.mjs`、`src/task-history.mjs`、`src/server.mjs`、`src/app-settings.mjs`。
- 新增 `src/turn-speech.mjs`、`src/activity-summary.mjs`；移除上一版尚未提交的 turn-reply / background-speech 模块。
- `docs/v08-cloud.md`、本 result；`scripts/verify-v081.mjs`、`scripts/verify-v08.mjs`、`scripts/verify-v08-browser.mjs`。
- 新增 `test/sdk-stop.test.mjs`、`test/activity-summary.test.mjs`，并更新 v081-core/http、sdk-say、活动标题、调度、旁聊、媒体、上下文和已有演示断言。

前一轮保留：content、conversation-recovery、data-guard、client-requests、bash-writes，Python 入口及部署 unit / install.sh，版本文件及相关测试。本轮没有修改 `src/browser/**`；浏览器演示的独立说话场景改成旁聊，以符合后台静默规则，真 Chrome 接管/交还覆盖仍在。
