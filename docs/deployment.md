# 部署豆豆 1.4

豆豆使用 OpenClaw 2026.10.4，一个 Agent、同一个持续压缩的主 Session。Android、Mac 和 cloud 必须一起升级；旧协议返回 426。

## 运行环境

Linux、systemd、Nginx、HTTPS，以及 Node 24.16+（24 系列）或 26.1+。服务模板使用 `/opt/doudou-runtimes/node-v26.5.0-linux-x64/bin/node`；其他安装位置请同步修改 unit 与 PATH。代码在 `/opt/personal-agent`，持久数据在 `/srv/agent`。

在 `/etc/personal-agent.env` 配置以下字段，文件权限设为 600：

```dotenv
AGENT_TOKEN=replace-with-a-long-random-token
MODEL_BASE_URL=https://zenmux.ai/api/anthropic
MODEL_API_KEY=replace-with-your-key
AGENT_TZ=Asia/Shanghai
```

内置 ZenMux 使用 Anthropic Messages；App 的「模型 → 添加模型服务」提供 12 家供应商预设，选择供应商后填写 API Key，接口与常用模型自动填入。也可添加自定义 Anthropic 或 OpenAI Chat Completions 兼容服务。Anthropic 填 API 根地址，OpenAI 一般填含 `/v1` 的地址。实际模型选择保存在 `system/app-settings.json`，服务资料及密钥在 `system/providers.json`。配置更新后，下轮请求使用新模型；不新建主会话。

## 安装

```bash
cd /opt/personal-agent/cloud
# 先准备 Node
sudo bash deploy/install.sh
sudo systemctl start personal-agent.service
```

在现有 HTTPS server 中加入 `include /etc/nginx/agent-location.inc;`。Gateway 仅监听本机 18789，不对外暴露；App 通过 4400 上的豆豆协议访问。内部工具桥拒绝代理请求头。

```bash
curl --fail https://agent.example.com/agent/health
sudo -u agent /opt/doudou-runtimes/node-v26.5.0-linux-x64/bin/node \
  /opt/personal-agent/cloud/src/pair.mjs
```

把地址 `https://agent.example.com/agent` 和一次性配对码填入 App。健康检查的 `ready:true` 表示内核可接收请求；还应发送一条消息确认实际模型和工具执行。

## 从 1.0–1.3 升级

1.4 沿用协议 2，Android、Mac 与 cloud 一起升级。旧客户端收到明确的升级提示；不保留旧的点子点击执行接口或动态讨论发送接口。配对令牌继续使用，无需重新配对。

等待正在执行的工作结束，停服备份整个 `/srv/agent` 与环境配置，再替换代码、更新依赖并重启。不重跑迁移，也不清空原生 Session、记忆、Goal 或连接器。

点子和动态讨论统一为 `POST /api/send` 的 `quote` 引用，点击只进入草稿；用户按发送后进入主会话。活动记录明确区分 `tool` 调用和 `tool_result` 结果。

## 从 0.8 升级

先安装新版代码和 Node，在原服务停止后执行一次离线迁移：

```bash
sudo systemctl stop personal-agent.service personal-agent-browser.service
sudo -u agent /opt/doudou-runtimes/node-v26.5.0-linux-x64/bin/node \
  /opt/personal-agent/cloud/scripts/migrate-v1.mjs \
  --root /srv/agent --backup /srv/agent-backups/before-v1.tar.gz
```

备份目标必须是数据目录之外的新文件，并可由 agent 用户写入。脚本先完整归档、校验目录、计算 SHA-256，再变更数据；执行记录保存在 `system/migrations/v1.json`。

- 保留资源库、动态、Idea、健康、上传文件、连接器账号、设备资料、同步游标与模型配置。
- 原总档迁到 `USER.md`，其他旧记忆和日记迁到原生 `memory/`，保留来源和原修改时间；人格迁到 `SOUL.md`，Skill 迁到 `skills/`。
- Goal 转换为新状态；已交付进入待用户反馈，用户认可后才算完成。旧版“完成”记录保留为已完成。
- 聊天、活动与旧 Session 只在完整备份中保留，不导入新内核。迁移后首次聊天从持久记忆继续认识用户。

人工回退时先停服，恢复**整份**数据备份及对应旧版代码、旧 unit 和环境配置。不能把两个版本同时指向同一个数据目录。

云端交互浏览器已移除。停用并禁用旧 `personal-agent-browser.service`；迁移脚本会把登录状态保留在完整备份中，删除活动目录。手机、Mac 的本机操作能力继续使用。资源库本地 HTML 缩略图可选安装 `scripts/install-screenshot.sh`，仅短时渲染本地文件。

旧环境的模型凭据只需改名为 `MODEL_BASE_URL` / `MODEL_API_KEY`；1.0 不再读取 Claude Code 的配置和环境字段。

## 数据与维护

| 路径 | 内容 |
| --- | --- |
| `SOUL.md` / `USER.md` / `MEMORY.md` / `memory/` | 唯一的原生人格、用户资料与记忆 |
| `skills/` | 可复用方法；连接器维护自己的官方技能 |
| `.openclaw/` | OpenClaw 原生会话、索引及内部状态 |
| `data/feed/` | 日期分目录的动态 MD、原文配图与反馈 |
| `data/ideas/点子.md` | 个性化点子；采纳记录在同目录的 `反馈.jsonl` |
| `data/goals/` | 每个 Goal 一份 MD，含状态、进展与下次安排 |
| `data/library/`、`data/uploads/`、`data/health/` | 成果、上传与健康数据 |
| `workspace/` | 过程草稿 |
| `system/` | App 展示记录、账号配置、设备与同步、安排 |

备份整个数据目录和环境配置，避免在在线 SQLite 写入期间直接复制数据库文件。原生记忆检索、压缩前 flush 和 Dreaming 由 OpenClaw 管理；不维护第二份记忆库。App 心跳与 Goal 跟进通过同一主 Session 运行，原生额外心跳关闭以免重复唤醒。定时安排统一通过豆豆 schedules 工具，App 可查看和停用；OpenClaw 自己的 Dreaming 维护任务仍由内核管理。

动态和点子每次更新使用独立任务 Session，带入最近主聊天快照，共用工作区和原生记忆；它们没有 fork 主会话全文。任务摘要留待下次主会话带入，内容立即同步各端。Goal、提醒和心跳在长期主 Session 串行推进。

搜索走已连接的 Tavily 账号，`web_fetch` 直接抓取网页；模型供应商订阅不承担第三方搜索额度。

用户设备默认读取上下文，明确任务可用 Computer Use / Phone Use，范围由提示词约束；豆豆专用设备可操作系统。操作系统本身的能力授权仍在各设备完成。

Android 和 Mac 的设备归属、能力授权统一在「连接应用 → 本机」管理；头像控制台不再提供重复的权限页。Android 在本机能力中开启手机操作，再在系统无障碍的已下载应用中打开「豆豆手机操作」。截图需要 Android 11 或更新版本；较旧系统仍可读取界面节点和执行手势。App 会检测服务连接并同步云端；普通运行时权限不包含此授权。后台运行可在同页进入系统电池设置允许。Mac 操作电脑需要屏幕录制和辅助功能。

1.5 客户端把手机滚动和滑动统一为有边界的曲线轨迹与连续变速触摸，起止点保持准确；动作后仍须重新观察界面。此版没有云端代码或持久化格式变更，现有 1.4 云端无需停服或迁移数据。

上传的图片和文件以工作区路径进入会话，原生 `view_image` / 文件读取工具按需载入内容；上传成功与模型处理完成是两个独立结果。

```bash
sudo systemctl status personal-agent.service
sudo journalctl -u personal-agent.service --since '10 minutes ago'
cd /opt/personal-agent/cloud
npm test
npm run verify:kernel
```

测试只使用隔离目录和本地模型夹具。`verify:kernel` 启动真实 OpenClaw，验证原生工具循环、主会话连续性与重启续接，不调用外部付费模型。
