# 云端连接器（v0.3）

一句话：**连接器的代码由我们随版本发布，豆豆和 App 只负责填配置。** 豆豆不碰基础设施。

## 一、原则

1. **代码和配置分开。**
   - 代码在仓库的 `cloud/connectors/<name>/` 里，部署到 `/opt/personal-agent/`。这个目录归 root 所有，`agent` 用户只能读。
   - 配置在 `<AGENT_ROOT>/system/connectors/<name>/accounts.json`。
2. **一个连接器可以有多个账号。** 例如「邮箱」是一个连接器，QQ 和 163 是它下面的两个账号。工具调用时用 `account` 参数指定账号，不填就是所有账号。
3. **密钥只走表单或配置工具，不走聊天，也不进模型上下文。**
   - 能接触到明文密钥的只有三处：App 表单 → 云端接口 → 连接器代码。
   - 任何返回给 App 或模型的数据，密钥字段都换成 `"••••"`。
4. **豆豆能改配置，改不了代码。**
   - 豆豆可以用 `connectors` 工具加账号、改备注、删账号。
   - `system/connectors/` 下的文件不允许 Read/Write/Edit 直接读写，也不允许 Bash 访问。PreToolUse 钩子负责拦截，理由写清楚，让豆豆改用工具。
5. **自建连接器单独放。** 目录里没有的服务，豆豆可以自己写，放在 `system/custom-connectors/<name>/`，按标准插件格式（`.claude-plugin/plugin.json` + `.mcp.json`）。这类在 App 里显示为「自建」。好用的再由我们收编成预置连接器。

## 二、连接器的形状

`cloud/connectors/<name>/index.mjs` 默认导出：

```js
export default {
  name: "email",                 // 稳定 id，也是 MCP server 名：mcp__email__*
  title: "邮箱",
  description: "QQ、163、Gmail、Outlook、企业邮箱（IMAP，只读）",
  icon: "envelope",              // App 用来映射图标的语义名
  multiAccount: true,
  fields: [                      // App 根据这里生成表单
    { key: "preset", label: "邮箱类型", type: "select",
      options: [{ value: "qq", label: "QQ 邮箱" }, { value: "163", label: "163 邮箱" }, …, { value: "custom", label: "其他（手动填服务器）" }] },
    { key: "address", label: "邮箱地址", type: "text", placeholder: "name@qq.com" },
    { key: "password", label: "授权码", type: "secret",
      help: { qq: "QQ 邮箱网页版 → 设置 → 账号 → 开启 IMAP/SMTP → 生成授权码", "163": "…" } },
    { key: "host", label: "IMAP 服务器", type: "text", showIf: { preset: "custom" } },
    { key: "port", label: "端口", type: "number", default: 993, showIf: { preset: "custom" } },
  ],
  label: (a) => a.address,       // 账号在列表里显示的名字
  async test(account) {},        // 真实登录一次；失败就 throw，并给出中文原因（例如「授权码不对」「没开 IMAP」）
  tools(accounts, ctx) {},       // 返回 SDK tool() 数组；ctx 提供 state 读写，用于游标
};
```

- 字段类型只有四种：`text`、`secret`、`number`、`select`。`showIf` 只支持「某个字段等于某个值」。`help` 可以是一个字符串，也可以是「按 preset 取值」的映射。
- 注册表 `cloud/connectors/index.mjs` 列出全部连接器。启动时，harness 为**至少有一个账号**的连接器各建一个 `createSdkMcpServer`，和 `devices` 一样挂进 `mcpServers`。
- 账号变化后（不管是来自 App 还是工具），重建 MCP server，并在下一轮让主会话 reload。

### accounts.json

```json
{ "accounts": [ { "id": "a1b2c3", "label": "name@qq.com", "values": { "preset": "qq", "address": "…", "password": "…" },
                  "status": "ok", "checkedAt": 1791…, "error": null } ] }
```

- 文件权限 600，属主 agent，写入要原子（先写临时文件再 rename）。
- 状态信息（游标等）放在同目录的 `state.json`。

## 三、云端接口

| 接口 | 说明 |
|---|---|
| `GET /api/connectors` | 和现在一样，但 `cloud.catalog` 里的每一项都带上 `fields` 和 `multiAccount`。已配置账号的连接器移到 `cloud.installed`，并带上 `accounts:[{id,label,status,error,checkedAt,values}]`；values 里的 secret 一律是 `"••••"`，用于编辑页预填。自建连接器放进 `cloud.custom`。 |
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
- 用户在聊天里直接把授权码发给豆豆的话，豆豆可以代填（调用 `add_account`），但要提醒一句：「下次在 App 里点「连接」填表单更安全，聊天记录里会留下授权码」。
- 提示词的工作目录表改为：
  - `system/connectors/`：连接器配置。只能用 connectors 工具改，不能直接读写。
  - `system/custom-connectors/<名>/`：自建连接器（插件格式）。目录里有的服务不要自建。
- 「帮我接入「邮箱」连接器」这类消息的处理顺序：
  1. 先 `list()`，确认是预置连接器。
  2. 告诉用户去 App 的连接应用 → 邮箱 → 填表单，或者让用户把字段发过来由它代填。
  3. 不写代码。

## 五、App

- 云端目录里点「连接」，或点已连接的连接器，打开**连接器详情页**：
  - 上方是图标、名字和说明，下面是账号列表，每个账号显示 label、状态点和错误原因，右侧有「重新测试」和「删除」。
  - 底部是「添加账号」，点开是按 `fields` 生成的表单：select 用分段控件或下拉；secret 是密码框，可以切换显示；`help` 写在字段下方的小字里；`showIf` 控制字段显隐。
  - 提交时按钮显示「正在验证…」。失败时把原因显示在表单上，已填的内容保留；成功后回到账号列表。
- 自建连接器只读展示：名字、说明，标注「豆豆自建」。
- 设备页里离线的设备可以「移除」，要二次确认。
- 不再有「点连接 = 发一句聊天」。

## 六、第一个连接器：邮箱（只读 IMAP）

- 预置（服务器、端口 993、SSL）：
  - QQ：`imap.qq.com`
  - 163：`imap.163.com`
  - 126：`imap.126.com`
  - Gmail：`imap.gmail.com`
  - Outlook：`outlook.office365.com`
  - 腾讯企业邮：`imap.exmail.qq.com`
  - 阿里企业邮：`imap.qiye.aliyun.com`
  - 其他：手动填。
- 163、126 登录后要发 IMAP `ID` 命令，否则会报 Unsafe Login。
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
- 依赖：`imapflow`，HTML 转文本用 `html-to-text`，或者自己写一个简单的剥标签。
