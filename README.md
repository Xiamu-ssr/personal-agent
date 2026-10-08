# Personal Agent

一个像 Today AI 那样的个人 agent：24 小时住在云主机上，手机和电脑是它的手脚。

| 目录 | 是什么 | 状态 |
|---|---|---|
| `spec/` | Spec 模拟器（`index.html`，浏览器直接打开）和系统提示词 | v3 |
| `cloud/` | 云端本体：Claude Agent SDK 内核 + 定时任务 + App/设备网关 | 在跑 |
| `android/` | 安卓 App（聊天 / 看板 / 任务 / 记忆 / 日记 + 设备能力） | 下一步 |
| `mac/` | Mac DMG（菜单栏 + 本机能力） | 之后 |

安装包发布在 [Releases](../../releases)，手机上直接下载 APK。

## 云端本体

```
/srv/agent/                 ← agent 的工作目录，归 Linux 用户 agent 所有（非 root）
  data/                     ← 精心维护，App 里能看到：memory/ briefs/ sites/ diary/
  workspace/<任务>/         ← 草稿区，每周清理
  system/                   ← connectors/ sync/ sessions/ schedule.json chat.jsonl
  .claude/skills/
```

- 模型：ZenMux `anthropic/claude-haiku-5.5`（主力、子任务、自动审批都用它）
- 权限：`permissionMode: "auto"`，由审批模型判断；外部动作靠系统提示词引导「拿不准就问」
- 主线程一个长 session（`resume`），定时任务 / 设备补读 / 夜间整理各开独立 session
- App 接口：`wss://<host>/agent/ws`（Bearer token），`/agent/api/{state,history,tree}`，`/agent/files/<data 下路径>`

部署（在 ECS 上）：

```bash
bash /opt/personal-agent/cloud/deploy/install.sh   # 不要加 sudo，脚本内部按需 sudo
```

`/etc/personal-agent.env` 需要：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`HTTPS_PROXY`（ECS 直连 ZenMux 不通）、`AGENT_TOKEN`（安装脚本会生成）。
