# 云端连接器（OpenClaw 目标规格）

> 服务目录与账号交互保留；工具注册和执行接入 OpenClaw 公开插件 / Gateway。以下是重构目标，不代表现有运行实现已经迁移。

一句话：**连接器的代码由我们随版本发布，豆豆和 App 只负责填配置。** 豆豆不写连接器代码，只引导用户提供必要的参数（地址、授权码、API Key），替用户填进去；用户也可以自己在 App 里填。

## 一、原则

1. **代码和配置分开。**
   - 代码在仓库的 `cloud/connectors/<name>/` 里，部署到 `/opt/personal-agent/`。这个目录归 root 所有，`agent` 用户只能读。
   - 配置在 `<AGENT_ROOT>/system/connectors/<name>/accounts.json`。
2. **一个服务一个连接器**，和 Today AI 一样。QQ 邮箱、163 邮箱、Gmail 是三个连接器，各自有官方图标。
   - 同一个服务可以连多个账号，比如两个 QQ 邮箱。邮箱工具用 `account` 指定账号，不填查所有账号；Tavily、Wind 的查询只用一个账号，明确额度耗尽时才尝试备用账号，见下文。
   - 几个连接器底层用同一套代码时（比如都是 IMAP），共享代码放在 `cloud/connectors/_shared/`，但对外仍然是各自独立的连接器。
3. **密钥只走表单或配置工具，不进模型上下文。**
   - 能接触到明文密钥的只有三处：App 表单 → 云端接口 → 连接器代码。
   - 任何返回给 App 或模型的数据，`values` 里的密钥字段都换成 `"••••"`。
   - **App 账号列表**在账号名后展示敏感字段的首尾片段，例如 `常用账号 · API Key: tvly••••1234`，帮助区分已经添加的 Key、密码、授权码。每端显示长度约为总长的 15%，最少 1 位、最多 4 位；中间统一 4 个圆点，不显示真实长度。少于 4 字符的秘密不展示片段。
   - 模型使用的 `connectors.list()` 不带这些片段。App 编辑表单仍以空白密码框或原有完整遮罩表示「保持不变」，不把展示片段当作新密钥提交。
4. **豆豆能改配置，改不了代码。**
   - 豆豆用 `connectors` 工具加账号、改备注、删账号。
   - `system/connectors/` 下的文件不允许 Read / Write / Edit 直接读写，也不允许 Bash 访问。由 OpenClaw 接入层与凭据隔离落实，理由写清楚，让豆豆改用配置工具；不保留旧内核 PreToolUse 钩子。
5. **不做自建连接器。** 目录里没有的服务，豆豆如实告诉用户「暂时还接不了」，不自己写代码。`system/custom-connectors/` 和相关代码删掉。
6. **云端内置能力不展示。** 网页搜索、网页读取、命令行、文件、定时、语音转写由 OpenClaw 或豆豆产品适配提供，App 里不列出来。

## 二、连接器的形状

`cloud/connectors/<name>/index.mjs` 默认导出：

```js
export default {
  name: "qq-mail",               // 稳定服务 id，不绑定旧 MCP server 命名
  title: "QQ 邮箱",
  description: "读取 QQ 邮箱里的邮件（只读）",
  icon: "icon.png",              // 同目录下的官方图标文件，App 通过接口取
  multiAccount: true,
  fields: [                      // App 根据这里生成表单
    { key: "address", label: "邮箱地址", type: "text", placeholder: "name@qq.com" },
    { key: "password", label: "授权码", type: "secret",
      help: "QQ 邮箱网页版 → 设置 → 账号 → 开启 IMAP/SMTP → 生成授权码" },
  ],
  label: (a) => a.address,       // 账号在列表里显示的名字
  async test(account) {},        // 真实登录一次；失败就 throw，并给出中文原因（例如「授权码不对」「没开 IMAP」）
  tools(accounts, ctx) {},       // 产品侧工具描述与处理器，由 OpenClaw 插件适配；ctx 提供游标状态
};
```

- 字段类型只有四种：`text`、`secret`、`number`、`select`。`showIf` 只支持「某个字段等于某个值」。
- **图标**：用服务的官方图标（从官网取 apple-touch-icon 或 favicon 的高清版），放在连接器目录里随代码发布。不要自己画。
- 注册表列出全部连接器。为已连接的服务通过 OpenClaw 公开插件注册工具、参数 schema 与执行处理器；用户设备只读工具和豆豆设备执行工具按角色分开注册。不保留 `createSdkMcpServer` 或旧 SDK 的 `mcpServers` 桥接。
- 账号变化后更新同一 Gateway 的工具可用性与账号配置；下一执行边界生效，不 new 主 Session。

### accounts.json

```json
{ "accounts": [ { "id": "a1b2c3", "label": "name@qq.com", "values": { "address": "…", "password": "…" },
                  "status": "ok", "checkedAt": 1791…, "error": null } ] }
```

- 文件权限 600，属主 agent，写入要原子（先写临时文件再 rename）。
- 状态信息（游标等）放在同目录的 `state.json`。

## 三、云端接口

| 接口 | 说明 |
|---|---|
| `GET /api/connectors` | `cloud.catalog`：还没配置的连接器，每项带 `fields`、`multiAccount`、`icon`。`cloud.installed`：已配置的，并带上 `accounts:[{id,label,status,error,checkedAt,values}]`。App 的 `label` 带敏感字段的首尾片段，`values` 里的 secret 一律是 `"••••"`。没有 `builtin`，也没有 `custom`。 |
| `GET /api/connectors/<name>/icon` | 官方图标文件，带长缓存头 |
| `POST /api/connectors/<name>/accounts {values}` | 校验必填项 → `test()` → 成功就保存并返回 `{id,label,status:"ok"}`；失败返回 400 `{error}`，不保存。 |
| `PUT /api/connectors/<name>/accounts/<id> {values}` | 修改账号；secret 字段传 `"••••"` 或不传，表示保持原值。同样要先 test。 |
| `DELETE /api/connectors/<name>/accounts/<id>` | 删除账号；删到 0 个账号就停用该服务工具。 |
| `POST /api/connectors/<name>/accounts/<id>/test` | 重新测一次，并更新 status。 |
| `DELETE /api/devices/<id>` | 从注册表里删掉一台设备（只允许离线设备；在线的返回 409）。 |

## 四、豆豆这边

- 内置 MCP `connectors` 提供四个工具，全部不返回密钥：
  - `list()`：列出目录、已连接的连接器和账号状态、各连接器的字段说明。
  - `add_account(name, values)`
  - `update_account(name, id, values)`
  - `remove_account(name, id)`
- 用户要接入某个服务时：
  1. 先 `list()`，看目录里有没有。没有就如实说暂时接不了。
  2. 有的话，按 `fields` 告诉用户要准备什么、去哪里拿（照 `help` 说）。
  3. 用户在 App 里自己填，或者把参数发过来由豆豆用 `add_account` 代填。代填时提醒一句：「在 App 里填表单更安全，聊天记录里会留下授权码」。
  4. 不写代码、不读配置文件。
- 提示词的工作目录表只保留 `system/connectors/`（只能用 connectors 工具改），删掉 `custom-connectors` 一行。

## 五、App

- 云端标签页：已连接的在上面，可以接入的在下面，每项都是官方彩色图标 + 名字 + 一行说明。
- 点进去是**连接器详情页**，所有连接器用同一个页面，没有特殊页：
  - `fields: []` 且 `multiAccount: false` 的免凭据服务只展示「连接服务」开关；开启时验证并保存空配置，关闭时删除该连接记录、卸载工具。失败时保留原状态并显示原因，不弹空账号表单。
  - 上方是图标、名字和说明，下面是账号列表，每个账号显示 label（含敏感字段首尾片段）、状态点和错误原因，右侧有「重新测试」和「删除」。账号备注是独立字段，编辑备注不会把列表里的片段写进配置。
  - 底部是「添加账号」，点开是按 `fields` 生成的表单：select 用分段控件或下拉；secret 是密码框，可以切换显示；`help` 写在字段下方的小字里；`showIf` 控制字段显隐。
  - 提交时按钮显示「正在验证…」。失败时把原因显示在表单上，已填的内容保留；成功后回到账号列表。
- 设备页里离线的设备可以「移除」，要二次确认。

### 余量

- 已连接列表显示余量，详情按账号展示；有数值才显示余额或进度。按同单位、同额度类型求和。
- Tavily 读取 `/usage`。Wind 显示「额度正常／额度不足」，仍有可用账号就显示正常；高德不展示无法取得的余量。界面不放接口限制说明。
- 同一 Tavily 账户下多个 Key 共享账户额度，不能当作独立账号累计。
- App 与 `connectors.list` 接收同一份 `usage` 信息；缓存一分钟，不改变授权和切换策略。

## 六、沿用的服务目录

### 邮箱（只读 IMAP，每家一个连接器）

| name | 名字 | 服务器（端口 993、SSL） | 备注 |
|---|---|---|---|
| `qq-mail` | QQ 邮箱 | `imap.qq.com` | 授权码 |
| `netease-163` | 163 邮箱 | `imap.163.com` | 登录后发 IMAP `ID` 命令，否则报 Unsafe Login |
| `netease-126` | 126 邮箱 | `imap.126.com` | 同上 |
| `gmail` | Gmail | `imap.gmail.com` | 应用专用密码；云主机要走代理 |
| `exmail` | 腾讯企业邮 | `imap.exmail.qq.com` | |
| `aliyun-mail` | 阿里企业邮 | `imap.qiye.aliyun.com` | |
| `imap` | 其他邮箱 | 手动填服务器和端口 | |

- Outlook 已经不支持密码登录 IMAP，不做。
- 工具（account 可选，不填就查全部账号，结果里带上 account）：
  - `list_folders(account)`
  - `search({account?, folder?="INBOX", query?, from?, since?, until?, unread?, limit≤50, before?})`
    - 返回 `{items:[{account, uid, folder, from, subject, date, unread, snippet}], next_before}`，按时间倒序。
  - `read({account, folder, uid})`
    - 返回正文纯文本（HTML 转文本，最多 20k 字）和附件清单（名字、大小）。
  - `save_attachment({account, folder, uid, name})`
    - 存到 `workspace/mail/<日期>/`，返回路径。
  - `read_since({account?, limit≤100})` 和 `sync_commit({cursor})`
    - 和设备的补读协议一样：按每个账号 INBOX 的 UID 游标增量读取，commit 之后才推进游标。
- 只读：不发信，不删信，不标记已读（BODY.PEEK）。
- 迁移：现有 `system/connectors/email/` 里的账号按 preset 搬到对应的新连接器（QQ → `qq-mail`，163 → `netease-163`），游标一起搬，然后删掉 `email` 目录。迁移脚本要能重复跑，不打印密钥。

### Tavily

- 字段：账号备注（可选）、API Key（secret）。支持添加多个独立账号，拒绝重复添加同一个 Key。
- 工具：`search({query, depth?, max_results?, time_range?})`、`extract({urls})`。
- 什么时候用：网页搜索统一用 Tavily，日常查询默认 basic；已知网址先用原生 web_fetch，完整正文可用 Tavily extract。搜索额度独立于模型供应商。
- 仅在官方 `432`（套餐额度用完）、`433`（按量预算上限），或 `402/403/429` 的错误正文明确说明积分/余额/额度耗尽时，用备用账号重试同一个查询。普通 `429` 只表示限流，网络、鉴权、服务故障都不能据此换号。
- 同一个 Tavily 账户的多个 Key 仍共享该账户的额度；Google/GitHub 只是登录方式，不代表额外获赠一份额度。

### Wind AI

- 字段：账号备注（可选）、API Key（secret）。支持多账号，查询结果带 `connector_account`，不返回 Key。
- 官方入口 `https://market.windalice.com`；AI 金融应用市场的积分与 Alice App、终端的权益不通用。
- 七个数据服务保持按需发现。`call`、`list_tools` 与 `ask_alice` 可在明确积分不足或每日额度耗尽时尝试备用账号；普通数据权限不足、限流和网络问题直接报告。
- `call` 如果含游标、会话、任务等参数，必须指定上次结果中的 `connector_account`；指定后固定使用该账号，不跨账号重试。`list_tools` 的分页在同一账号内完成。
- `ask_alice` 仅在任务接受前收到明确额度拒绝时换号；已收到状态或结果后出现额度不足，记录该账号已耗尽，但本次任务不再重复提交。普通断流也不跨账号重试，避免重复扣费。
- 技能清单和技能安装仍使用本地官方缓存，不轮询多个账号。

### 查询账号的冷却与恢复

- 只对 Tavily、Wind 启用。邮箱、GitHub、微信读书等有账号状态的连接器沿用原来的账号语义。
- 优先沿用上一次成功账号；明确额度耗尽后，每个备用账号本次最多尝试一次。耗尽记录持久化到私有 `state.json`，主聊天、旁聊、后台任务和服务重启后都跳过已知耗尽账号。
- Tavily 到下个 UTC 月初可再次探测，Wind 到下个北京时间零点可再次探测。这只是重新尝试时间，不承诺余额或预算届时一定恢复；如果仍不足，再进入冷却。充值或手动恢复后可点「重新测试」提前重新启用。
- 修改为不同 Key 或删除账号时清除对应记录；改备注不会清除。成功的认证测试只表示允许再次尝试，不能冒充精确余额查询。
- 状态记录仅含账号 ID、Key 的 SHA-256 指纹和时间，不保存查询、密钥或聊天正文，权限与账号文件相同（600）。并发请求的迟到成功结果不能取消另一个请求刚确认的耗尽记录。

### 腾讯行情

- `tencent-quotes`，免费、无需账号或 API Key，使用腾讯证券公开报价；在连接器页连接或取消即可。未连接时不挂载查询工具。
- `quotes({symbols})`：一次查询 1–50 个带市场的沪深京股票、ETF、指数代码，例如 `600519.SH`、`000001.SZ`、`sh000001`。不猜测不带市场的六位数字，避免把上证指数当作平安银行。
- 返回价格、昨收、涨跌额、涨跌幅、最高/最低、换手率、上游报价时间 `asOf` 和抓取时间 `fetchedAt`；部分代码缺失时单独列在 `missing`，不填零冒充有效报价。
- 同批查询合并并缓存 5 秒；查询不消耗 Wind 积分，不提供交易能力。休市或上游延迟时应说明报价时间，不能把抓取时间当成行情更新时间。接口没有稳定性承诺；历史、基本面、研报等仍使用其他数据连接器。

腾讯行情的代码与短缓存均在豆豆自己的连接器内，不调用股票铃进程，也不读取、导入或共享其配置和数据。

### 高德地图

- `amap`，默认未连接，使用一个高德「Web 服务」Key；在 App 的连接器表单里填写、验证后启用，删除账号即断开。Key 只保存在云端私有配置中，不进入查询工具或结果。
- 注册入口：高德开放平台 → 我的应用 → 添加 Key → **Web 服务**；名称自定。IP 白名单可先留空；需要限制时填云端请求高德的实际出口 IP，不能直接假定为服务器公网 IP。
- 直接调用高德官方 Web 服务 API，作为豆豆的 OpenClaw 插件工具发布；不依赖远程社区 MCP。
- 工具：`geocode`（地址转坐标）、`reverse_geocode`、`search_places`、`search_nearby`、`route`（步行/驾车/公交/骑行）、`distance`（直线/驾车/步行）、`convert_coordinates`、`weather`。全部只查询，不下单、订票或打车。
- 坐标为高德 **GCJ-02**，经度在前；手机 GPS/WGS84 结果先显式转换，不能静默混用。路线距离为米、耗时为秒；天气以 `reporttime` 为数据时间。返回最多三条路线和每条六十步，省略大段折线；截断时明确标记。
- 添加账号时用公共地标做一次地址查询验证，不读取用户位置。查询消耗高德 Key 的额度，配额、服务权限及使用许可由高德账号决定。HTTP 200 中的额度、IP 白名单和平台类型错误也要显示中文原因，不自动换号或反复请求。
- 官方文档：[创建 Web 服务 Key](https://lbs.amap.com/api/mcp-server/create-project-and-key)、[路径与距离](https://lbs.amap.com/api/webservice/guide/api/direction)、[坐标转换](https://lbs.amap.com/api/webservice/guide/api/convert)。

### 微信读书

- 用微信读书 2026-05-17 发布的官方 Agent Gateway，个人 API Key 是 `wrk-` 开头，`Authorization: Bearer <key>`。
- 字段：API Key（secret），`help` 写清在哪里生成。
- 工具按官方接口封装：书架、阅读统计、划线、想法、书籍搜索。接口细节以官方 Skill 文档为准。

### GitHub

- 查看当前用户可访问的仓库、单个仓库、issue 列表、issue 正文和评论，以及通知列表。仓库和 issue 可筛选、翻页；列表里的 PR 会明确标注，过长正文和评论会提示截断。
- 只读：不创建或修改仓库、issue、评论，不把通知标记为已读。只连接一个账号。
- 在 [GitHub 令牌设置](https://github.com/settings/tokens) 选择「Generate new token (classic)」，将个人访问令牌填进 App。公开仓库和通知勾选 `notifications`；要读取私有仓库及其 issue，还需 `repo`（已包含通知权限）。classic scope 本身包含写权限，连接器只使用读取能力。
- [通知 API 官方文档](https://docs.github.com/en/rest/activity/notifications#list-notifications-for-the-authenticated-user) 明确不支持 fine-grained PAT，只支持 classic PAT；所需 scope 为 `notifications` 或 `repo`。权限范围见 [GitHub 官方 scope 说明](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)，生成步骤见 [官方令牌指南](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic)。
