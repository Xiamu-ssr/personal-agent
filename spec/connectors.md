# 云端连接器（v0.4）

一句话：**连接器的代码由我们随版本发布，豆豆和 App 只负责填配置。** 豆豆不写连接器代码，只引导用户提供必要的参数（地址、授权码、API Key），替用户填进去；用户也可以自己在 App 里填。

## 一、原则

1. **代码和配置分开。**
   - 代码在仓库的 `cloud/connectors/<name>/` 里，部署到 `/opt/personal-agent/`。这个目录归 root 所有，`agent` 用户只能读。
   - 配置在 `<AGENT_ROOT>/system/connectors/<name>/accounts.json`。
2. **一个服务一个连接器**，和 Today AI 一样。QQ 邮箱、163 邮箱、Gmail 是三个连接器，各自有官方图标。
   - 同一个服务可以连多个账号，比如两个 QQ 邮箱。工具调用时用 `account` 参数指定账号，不填就是所有账号。
   - 几个连接器底层用同一套代码时（比如都是 IMAP），共享代码放在 `cloud/connectors/_shared/`，但对外仍然是各自独立的连接器。
3. **密钥只走表单或配置工具，不进模型上下文。**
   - 能接触到明文密钥的只有三处：App 表单 → 云端接口 → 连接器代码。
   - 任何返回给 App 或模型的数据，密钥字段都换成 `"••••"`。
4. **豆豆能改配置，改不了代码。**
   - 豆豆用 `connectors` 工具加账号、改备注、删账号。
   - `system/connectors/` 下的文件不允许 Read / Write / Edit 直接读写，也不允许 Bash 访问。PreToolUse 钩子负责拦截，理由写清楚，让豆豆改用工具。
5. **不做自建连接器。** 目录里没有的服务，豆豆如实告诉用户「暂时还接不了」，不自己写代码。`system/custom-connectors/` 和相关代码删掉。
6. **云端内置能力不展示。** 网页搜索、网页读取、命令行、文件、定时、语音转写都是 SDK 或本体自带的，App 里不列出来。

## 二、连接器的形状

`cloud/connectors/<name>/index.mjs` 默认导出：

```js
export default {
  name: "qq-mail",               // 稳定 id，也是 MCP server 名：mcp__qq-mail__*
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
  tools(accounts, ctx) {},       // 返回 SDK tool() 数组；ctx 提供 state 读写，用于游标
};
```

- 字段类型只有四种：`text`、`secret`、`number`、`select`。`showIf` 只支持「某个字段等于某个值」。
- **图标**：用服务的官方图标（从官网取 apple-touch-icon 或 favicon 的高清版），放在连接器目录里随代码发布。不要自己画。
- 注册表 `cloud/connectors/index.mjs` 列出全部连接器。启动时，harness 为**至少有一个账号**的连接器各建一个 `createSdkMcpServer`，和 `devices` 一样挂进 `mcpServers`。
- 账号变化后（不管来自 App 还是工具），重建 MCP server，并在下一轮让主会话 reload。

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
| `GET /api/connectors` | `cloud.catalog`：还没配置的连接器，每项带 `fields`、`multiAccount`、`icon`。`cloud.installed`：已配置的，并带上 `accounts:[{id,label,status,error,checkedAt,values}]`，values 里的 secret 一律是 `"••••"`。没有 `builtin`，也没有 `custom`。 |
| `GET /api/connectors/<name>/icon` | 官方图标文件，带长缓存头 |
| `POST /api/connectors/<name>/accounts {values}` | 校验必填项 → `test()` → 成功就保存并返回 `{id,label,status:"ok"}`；失败返回 400 `{error}`，不保存。 |
| `PUT /api/connectors/<name>/accounts/<id> {values}` | 修改账号；secret 字段传 `"••••"` 或不传，表示保持原值。同样要先 test。 |
| `DELETE /api/connectors/<name>/accounts/<id>` | 删除账号；删到 0 个账号就卸掉这个 MCP server。 |
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
  - 上方是图标、名字和说明，下面是账号列表，每个账号显示 label、状态点和错误原因，右侧有「重新测试」和「删除」。
  - 底部是「添加账号」，点开是按 `fields` 生成的表单：select 用分段控件或下拉；secret 是密码框，可以切换显示；`help` 写在字段下方的小字里；`showIf` 控制字段显隐。
  - 提交时按钮显示「正在验证…」。失败时把原因显示在表单上，已填的内容保留；成功后回到账号列表。
- 设备页里离线的设备可以「移除」，要二次确认。

## 六、目录（0.4）

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

- 字段：API Key（secret）。
- 工具：`search({query, depth?, max_results?, time_range?})`、`extract({urls})`。
- 什么时候用：日常搜索用内置的网页搜索；要做深入调研、或者要把网页正文整篇提取出来时用 Tavily。写进提示词。

### 微信读书

- 用微信读书 2026-05-17 发布的官方 Agent Gateway，个人 API Key 是 `wrk-` 开头，`Authorization: Bearer <key>`。
- 字段：API Key（secret），`help` 写清在哪里生成。
- 工具按官方接口封装：书架、阅读统计、划线、想法、书籍搜索。接口细节以官方 Skill 文档为准。

### GitHub

- 查看当前用户可访问的仓库、单个仓库、issue 列表、issue 正文和评论，以及通知列表。仓库和 issue 可筛选、翻页；列表里的 PR 会明确标注，过长正文和评论会提示截断。
- 只读：不创建或修改仓库、issue、评论，不把通知标记为已读。只连接一个账号。
- 在 [GitHub 令牌设置](https://github.com/settings/tokens) 选择「Generate new token (classic)」，将个人访问令牌填进 App。公开仓库和通知勾选 `notifications`；要读取私有仓库及其 issue，还需 `repo`（已包含通知权限）。classic scope 本身包含写权限，连接器只使用读取能力。
- [通知 API 官方文档](https://docs.github.com/en/rest/activity/notifications#list-notifications-for-the-authenticated-user) 明确不支持 fine-grained PAT，只支持 classic PAT；所需 scope 为 `notifications` 或 `repo`。权限范围见 [GitHub 官方 scope 说明](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)，生成步骤见 [官方令牌指南](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic)。
