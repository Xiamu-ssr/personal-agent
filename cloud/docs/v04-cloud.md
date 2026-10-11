# 云端 v0.4 交付记录

2026-10-11。本轮只改 `personal-agent/cloud/**` 和 `personal-agent/spec/prompts/system-prompt.md`。没有 commit、push、发布、部署、SSH、真实服务登录或真实模型调用。

## 实现与验证

`npm run check`、`npm test` 全部通过：**69/69**，无跳过、无未解决失败。原有 50 项回归保留，按 v0.4 更新旧协议断言，新增 19 项。运行环境为本机 Node **26.5.0**、锁定 Agent SDK **0.3.295**；真实 SDK/native CLI 的模型请求全部指向 loopback fake-anthropic。

| 需求 | 实现及实际验证 |
| --- | --- |
| 200K 窗口 | 默认 INPUT_LIMIT=172000、HEADROOM=5000，CLI 窗口恰为 200000，输出预留 20000、摘要预留 13000、触发点 167000。真实 SDK 的主会话、隔离、子 agent 验证了 env 和缓存输入越线后的低 effort 压缩；128K 输出上限仍按模型能力表设置。 |
| JSON 简报 | 共享 schema 检查 v/time/必需字段、卡片及区块数量、28/80 字限制、tone、纯文本约定。真实 CLI 的 main/fork/isolated 均经历无效 Write → 中文反馈 → Edit 修正；有效文件进入 API 与 path 卡片，HTML 简报不收集。 |
| 排队修改 | WS 双 App 实测广播 edited/removed、请求方 too_late、重连 hello.queued、保留附件、最终文本才入历史、撤回不入历史。原生 idle 控制派发，恢复重试不会重复写 user 记录。 |
| 头像与 state | HTTP 验证 4×4 全部组合、默认值、鉴权、无效提交保持原文件、600 权限和属主；state 有 userCall/agentName、无 model。 |
| 连接器 | 七家独立邮箱在同一套共享代码上跑本地 TLS IMAP wire 测试，验证固定 host、993/SSL、NetEase 登录后 ID、只读、分页、附件、独立游标。Tavily/微信读书用本地 HTTP 假服务核对 Bearer、参数、失败、密钥遮罩；还通过真实 SDK MCP 调用这两项，断言模型请求无明文 API Key。 |
| 图标 | 下载官方资源随代码发布；HTTP 验证全部九个图标、MIME 和长缓存头。其他邮箱使用中性信封 SVG。 |
| 设备图片 | 验证单图、多图、混合文字/元数据、5 MiB 边界、超限与坏 base64 中文 MCP 错误；真实 SDK 请求中截屏是 Anthropic image block。 |
| 提示词 | 测试最小 JSON 示例有效、字段限制、HTML title/description、配置工具流程、Tavily 用途、健康 latest.json，以及原定时后台 fork 规则保留。 |
| 迁移 | 临时目录造 HTML、三个简报任务、QQ/163 账号与游标、空 custom 目录；默认预览不写入 → apply 保存/归档 → 再 apply 零变化。断言备份原内容、相对路径、600 权限/属主、prompt 以外字段不动、无密钥输出。另测 CLI --apply、目标冲突预检、部分中断重跑、符号链接拒绝、非空 custom 保留、坏 JSON 不打印正文。 |

## 安卓 / Mac 对照协议

详细事件与账号接口见 [app-protocol-tasks.md](app-protocol-tasks.md)。路径沿用 Bearer/cookie 鉴权，外部反代前缀 `/agent` 由 App 云端地址处理。

| 接口 | 最终格式 |
| --- | --- |
| `GET /api/briefs?days=7` | `{items:[{date,name,time,path,brief}]}`；brief 为完整 v=1 JSON，time 倒序；默认含今天的近 7 个本地自然日；days 1–365，坏参数 400；空列表 `{items:[]}`。 |
| `GET /api/profile` / `PUT /api/profile` | GET、PUT body 和 PUT 成功回包均为 `{avatar:{shape,palette}}`。shape 只能 bean/girl/boy/cat，palette 只能 mist/dusk/mint/sakura，默认 bean+mist；校验失败 400 `{error}`。 |
| `GET /api/state` | `{busy,devices,tasks,schedule,firstChat,userCall,agentName}`，没有 model。 |
| `GET /api/connectors` | `{cloud:{id,name,kind,online,catalog,installed},devices}`，没有 builtin/custom；每项 `{name,title,description,icon,fields,multiAccount,status}`，installed 另带遮罩后的 accounts。 |
| `GET /api/connectors/<name>/icon` | 图片二进制，`Cache-Control: private, max-age=2592000`；catalog/installed.icon 为对应 `/api/connectors/<name>/icon`。 |
| `POST /api/send` | body 沿用 `{text,attachments?}`，成功回包 `{ok:true,id}`。 |

```json
{"t":"user","id":"message-uuid","text":"原文本","source":"app","ts":1791580800000,"attachments":[]}
{"t":"unqueue","id":"message-uuid"}
{"t":"edit_queued","id":"message-uuid","text":"新文本"}
{"t":"queue_update","id":"message-uuid","state":"removed"}
{"t":"queue_update","id":"message-uuid","state":"edited","text":"新文本"}
{"t":"queue_update","id":"message-uuid","state":"too_late"}
{"t":"hello","busy":true,"tasks":[],"devices":[],"history":[],"queued":[{"id":"message-uuid","text":"新文本","source":"app","ts":1791580800000,"attachments":[]}]}
{"t":"job","phase":"done","role":"card","label":"晨报","title":"晨报","path":"data/briefs/2026-10-11/晨报.json","outputs":["data/briefs/2026-10-11/晨报.json"],"ok":true,"ts":1791580800000,"taskId":"fork-id"}
```

edited/removed 广播给所有在线 App；too_late 只回请求方。修改不改变 id、附件、时间和队列位置。history 的 user 同样带 id；未派发消息只在 hello.queued，先 history 再 queued 合并。无效 WS 参数返回 `{t:"error",error:"中文原因"}`。闹钟 envelope source 为 schedule，不可作为普通用户消息撤回。隔离完成卡片没有 taskId；只有简报才带 path，站点用 outputs。

## 连接器封装与官方依据

稳定 id 为 `qq-mail`、`netease-163`、`netease-126`、`gmail`、`exmail`、`aliyun-mail`、`imap`、`tavily`、`weread`。邮箱 values 为 `{address,password,label?}`，imap 另需 host、可选 port（默认 993）；不再有 preset。Tavily/微信读书 values 为 `{apiKey}`，multiAccount=false。

Tavily 工具为 `search({query,depth?,max_results?,time_range?})`、`extract({urls})`；depth 映射为官方 search_depth，max_results 最大 20、urls 最多 20 个 HTTP(S) URL。`test()` 调 `GET /usage`，不触发搜索或正文提取。依据 [官方 Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)、[Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract)、[Usage](https://docs.tavily.com/documentation/api-reference/endpoint/usage)。

微信读书依据 [官方配置页](https://weread.qq.com/r/weread-skills) 和 [Tencent/WeChatReading 官方 Skill](https://github.com/Tencent/WeChatReading/blob/main/skills/SKILL.md)，实际直接读取 main 文档版本 **1.0.5**，并核对 shelf/readdata/notes/search 四份参数说明。入口 `POST https://i.weread.qq.com/api/agent/gateway`，`Authorization: Bearer`，业务参数与 api_name/skill_version 同层。test 调 `/user/notebooks`，count=1，以最小的个人分页请求验证 Key；没有进行真实登录或费用测试。收到 upgrade_info 返回中文升级错误，需随代码更新封装。

| MCP 工具 | Gateway api_name / 参数 |
| --- | --- |
| `shelf()` | `/shelf/sync`，无业务参数；提示模型 books/albums/mp 都计入书架条目。 |
| `reading_stats({mode?,baseTime?})` | `/readdata/detail`；mode weekly/monthly/annually/overall，baseTime 是 Unix 秒；工具说明明确阅读时长是秒、自然日均口径。 |
| `highlights({bookId})` | `/book/bookmarklist`；只读个人划线，不含书签内容。 |
| `thoughts({bookid,synckey?,count?})` | `/review/list/mine`；bookid 小写 i，synckey 分页。 |
| `search_books({keyword,scope,maxIdx?,count?})` | `/store/search`；scope 显式传入，保留分组结果，不把响应 scope 当请求类型过滤。 |

账号变化仍在当前回合结束后重建主 query、resume 同一 session；每个主/隔离 query 建独立 MCP transport。

## 图标来源

| 连接器 | 官方资源 | 像素 |
| --- | --- | --- |
| QQ 邮箱 | [官网 favicon](https://res.wx.qq.com/t/webmail/webmail/res/images/qqmail_favicon_96h.8d124a7.png) | 96×96 |
| 163 邮箱 | [官网 apple-touch-icon](https://mail.163.com/apple-touch-icon.png) | 180×180 |
| 126 邮箱 | [官网 apple-touch-icon](https://mail.126.com/apple-touch-icon.png) | 180×180 |
| Gmail | [Google 官方产品图标](https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_512dp.png) | 1024×1024 |
| 腾讯企业邮 | [官网 favicon](https://exmail.qq.com/exmail_logo.ico) | 32×32 |
| 阿里企业邮 | [官网 favicon](https://qiye.aliyun.com/static/0.2.9/images/favicon.ico) | 32×32 |
| Tavily | [官网 apple icon](https://tavily.com/apple-icon.png?apple-icon.2rsjznomrsf77.png) | 180×180 |
| 微信读书 | [官网 apple-touch-icon](https://rescdn.qqmail.com/node/wr/wrpage/style/images/independent/appleTouchIcon/apple-touch-icon-152x152.png) | 152×152 |
| 其他邮箱 | `connectors/imap/icon.svg`，中性信封 | 192×192 SVG |

腾讯企业邮/阿里企业邮的公开官网资源目前只取得 32 像素 favicon，未伪造高清图；Gmail 使用 Google 官方高清产品图标资源。可在后续取得更高清官方资源后替换对应文件。

## 实际改动文件

以下路径相对 `personal-agent/`。

- 运行层：`cloud/src/context-policy.mjs`、`agent.mjs`、`server.mjs`、`devices.mjs`、`connectors.mjs`、`config.mjs`、`main.mjs`；新增 `cloud/src/briefs.mjs`、`profile.mjs`。
- 连接器：移除 `cloud/connectors/email/index.mjs`；新增 `cloud/connectors/_shared/imap.mjs`、`_shared/http.mjs`；更新 `cloud/connectors/index.mjs`。九个目录 qq-mail/netease-163/netease-126/gmail/exmail/aliyun-mail/imap/tavily/weread 下各有 `index.mjs` 和 `icon.png`、`icon.ico` 或 `icon.svg`。
- 迁移与默认任务：新增 `cloud/scripts/migrate-0.4.mjs`；更新 `cloud/seed/system/schedule.json`。
- 新测试：`cloud/test/briefs.test.mjs`、`connectors-v04.test.mjs`、`migrate-0.4.test.mjs`、`runtime-v04.test.mjs`、`prompt-v04.test.mjs`；新增假服务/helper `fake-connector-api.mjs`、`native-fixture.mjs`。
- 更新回归：`cloud/test/connectors.test.mjs`、`context-policy.test.mjs`、`email.test.mjs`、`fake-imap.mjs`、`harness.test.mjs`、`http.test.mjs`、`mcp.test.mjs`、`schedule-fork.test.mjs`、`sdk-context.test.mjs`、`sdk-tasks.test.mjs`。
- 提示词与协议：`spec/prompts/system-prompt.md`、`cloud/docs/app-protocol-tasks.md`、`context-policy.md`、`task-runtime.md`、本文件。

## 部署时由用户执行

先由 Claude 完成集成并把本轮代码、图标、提示词发布到 `/opt/personal-agent`（代码归 root，agent 只读），保留 SDK lock。已有生产 env 若显式设置旧的 AGENT_CONTEXT_INPUT_LIMIT/HEADROOM，改成 172000/5000 或移除覆盖以采用默认值；不要打印 env 内容。

```bash
set -e
cd /opt/personal-agent
sudo systemctl stop personal-agent
sudo -u agent node cloud/scripts/migrate-0.4.mjs --root /srv/agent
sudo -u agent node cloud/scripts/migrate-0.4.mjs --root /srv/agent --apply
sudo -u agent node cloud/scripts/migrate-0.4.mjs --root /srv/agent --apply
sudo systemctl start personal-agent
```

第一条迁移仅预览，第二条执行，第三条应输出「0 项，没有变化」。遇到冲突/损坏文件时保持服务停止，检查源文件和备份，处理后重复迁移；不要以失败输出当作迁移完成。所有被移走的源文件/目录在 `/srv/agent/backup/migrate-0.4/<时间戳>/`，schedule 原文件先复制到同一备份。脚本不 rm；备份由用户以后手动清理。

启动日志应有 `max_output=128000 compact_window=200000 compact_pct=100`。部署后再验证两端 JSON 卡片、排队编辑/撤回、头像同步、截图、真实连接器和网关；本轮没有进行这些线上操作。

## 尚未验证的边界

- 生产 Linux CLI、真实模型/网关、真实 IMAP/Tavily/微信读书凭据、实际数据内容与成本，以及安卓/Mac UI 均未验收。本机真实 SDK 配假服务验证的是云端协议与运行层。
- 未派发队列是服务进程内状态；WS 重连和 SDK query 重建可恢复当前队列，服务进程重启不会恢复排队消息。后台任务跨进程恢复沿用原有限制。
- 简报校验与自动卡片依赖 Write/Edit hook；Bash 绕过文件 hook 不会自动校验/收集卡片。提示词要求简报用 Write，API 和完成卡片还会重新校验 JSON。
- 非空 `system/custom-connectors/` 按迁移要求保留并提示人工检查；运行层不再加载其中代码或 env。未知 preset、已存在但不同的目标 JSON/账号/游标会在执行前报错，避免覆盖已有数据。
