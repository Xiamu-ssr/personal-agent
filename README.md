# Personal Agent

一个像 Today AI 那样的个人 agent：24 小时住在云主机上，手机和电脑是它的手脚。

| 目录 | 是什么 | 状态 |
|---|---|---|
| `spec/` | Spec 模拟器（`index.html`）、App 产品规格（`app-v2.md`）和系统提示词（`prompts/system-prompt.md`） | v3 |
| `cloud/` | 云端本体：Claude Agent SDK 内核 + 定时任务 + App/设备网关 | 在跑 |
| `android/` | 安卓 App（聊天 / 今日 / 任务 / 记忆 / 豆豆 + 本机能力） | v0.2.0 |
| `mac/` | Mac App（和安卓同样的页面，左侧栏布局 + 菜单栏快速聊天），打成 DMG | v0.2.0 |

安装包发布在 [Releases](../../releases)：手机下载 APK，Mac 下载 DMG。

## 云端本体

```
/srv/agent/                 ← agent 的工作目录，归 Linux 用户 agent 所有（非 root）
  data/                     ← 精心维护，App 里能看到：memory/ briefs/ sites/ diary/
  workspace/<任务>/         ← 草稿区，每周清理
  system/                   ← connectors/ sync/ sessions/ schedule.json chat.jsonl
  .claude/skills/
```

- 模型：ZenMux `anthropic/claude-haiku-5.5`（主力、子任务、自动审批都用它），effort `max` + adaptive thinking；缓存 5 分钟、上下文压缩用默认
- 记忆只存事实（用户说的或直接观察到的，带来源和日期），不存推测；规则全写在系统提示词里
- 权限：`permissionMode: "auto"`，由审批模型判断；外部动作靠系统提示词引导「拿不准就问」
- 主线程一个长 session（`resume`），定时任务 / 设备补读 / 夜间整理各开独立 session
- App 接口：`wss://<host>/agent/ws`（Bearer token），`/agent/api/{state,history,tree,connectors,jobs,skills,upload,transcribe}`，`/agent/files/<data 下路径>`，完整列表见 `spec/app-v2.md`

部署（在 ECS 上）：

```bash
bash /opt/personal-agent/cloud/deploy/install.sh   # 不要加 sudo，脚本内部按需 sudo
```

`/etc/personal-agent.env` 需要：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`HTTPS_PROXY`（ECS 直连 ZenMux 不通）、`AGENT_TOKEN`（安装脚本会生成）。

## App（安卓 + Mac）

两端是同一个产品的两种布局：页面、功能、文案一样，安卓用底部导航，Mac 用左侧栏、排版更宽。产品规格见 [`spec/app-v2.md`](spec/app-v2.md)。

- 一级页面：**聊天 · 今日 · 任务 · 记忆 · 豆豆**；设置里有连接应用（本机 / 云端 / 其他设备）、设备、技能
- 登录：账号 = 云端地址，密码 = 6 位配对码或口令（自动判断）。配对码在已登录设备「设置 → 生成配对码」拿（24 小时有效、一次性，新码顶掉旧码），或在 ECS 上 `sudo -u agent node /opt/personal-agent/cloud/src/pair.mjs`
- 输入框：＋ 菜单（上传文件 / 拍照 / 图片 / 录制语音笔记），按住说话（转文字后直接发出），附件在气泡里显示
- 两条 WebSocket：`role=app`（聊天、事件）和 `role=device`（把这台设备注册成豆豆的手脚，能力逐个打开才对豆豆可见）
- 豆豆回复或任务完成时，App 不在前台会弹系统通知（设置里可关）

### 安卓

Kotlin + Jetpack Compose，minSdk 28。

- 本机能力：电量、发通知、位置、日历、短信（分页，一次最多 500 条，支持补读）、写剪贴板、打开网页（发一条可点的通知）
- 构建：`cd android && ./gradlew assembleRelease`（签名读 `~/.personal-agent/signing.properties`，不在仓库里）

### Mac

SwiftUI 普通窗口应用（macOS 14+），关掉主窗口后留在菜单栏，菜单栏气泡可以快速聊天，点 Dock 图标重新打开主窗口。

- 本机能力：电量、发通知、日历、读/写剪贴板、打开网页、当前应用、快捷指令（列出 / 运行）、一个授权文件夹（列目录 / 读 / 写）
- 安装：打开 DMG，把「豆豆」拖进「应用程序」。没有 Apple 开发者签名（ad-hoc），第一次打开会被拦：系统设置 → 隐私与安全性 → 「仍要打开」；或者终端里 `xattr -dr com.apple.quarantine /Applications/豆豆.app`
- 口令存在 `~/Library/Application Support/Doudou/token`（0600），不进钥匙串，免得每次更新都弹授权
- 构建：`VERSION=0.2.0 bash mac/build.sh`，只要命令行工具（CLT），不用 Xcode。脚本会自动绕开部分 CLT 自带的旧 `module.modulemap` 导致的 `import SwiftUI` 失败
