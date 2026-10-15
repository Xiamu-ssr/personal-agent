# 自部署豆豆 0.8

将下文的示例端点、凭据和域名换成自己的配置。云端与 App 使用相同的 0.8 版本；升级旧服务请先看[升级说明](#从-07-升级到-08)。

## 准备服务器与模型端点

需要具备 `systemd` 与 `sudo` 的 Linux 服务器，以及 Node.js ≥ 20.9、Git、curl、OpenSSL、Nginx、域名和 HTTPS 证书。启用云端 Chrome 时建议整机至少 4GB 内存；这是容量建议，不是已对所有网站测出的硬门槛。

服务模板的 Node 路径是 `/usr/bin/node`，代码目录 `/opt/personal-agent`，数据目录 `/srv/agent`。使用其他路径时同步调整 systemd unit。

模型端点由 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN` 配置，须兼容 Anthropic Messages API，支持以下模型 ID，或在端点侧映射：

- `anthropic/claude-haiku-5.5`：主聊天默认值，也是动态任务固定使用的模型。
- `anthropic/claude-opus-5.5`
- `z-ai/glm-5.3-flash`
- `z-ai/glm-5.3-flashx`

模型和权限模式在 App 设置中管理，定义见 [`app-settings.mjs`](../cloud/src/app-settings.mjs)。切换主聊天模型不会改变动态任务的 Haiku 要求。

## 安装云端

```bash
sudo git clone https://github.com/Xiamu-ssr/personal-agent.git /opt/personal-agent
sudo touch /etc/personal-agent.env
sudo chmod 600 /etc/personal-agent.env
sudoedit /etc/personal-agent.env
```

最小配置：

```dotenv
ANTHROPIC_BASE_URL=https://api.example.com/anthropic
ANTHROPIC_AUTH_TOKEN=replace-with-your-api-key
AGENT_TZ=Asia/Shanghai
```

Nginx 需要已能提供 HTTPS。在自己的 HTTPS `server` 块中加入下面一行；安装脚本随后创建 include 文件并检查、重载 Nginx：

```nginx
include /etc/nginx/agent-location.inc;
```

先按下一节准备浏览器依赖，再安装服务：

```bash
cd /opt/personal-agent/cloud
sudo bash deploy/install.sh
```

[`install.sh`](../cloud/deploy/install.sh) 安装运行依赖、检查 JavaScript 语法，准备 `agent` 用户与 `/srv/agent`，按需生成 `AGENT_TOKEN`，安装本体、浏览器 host 与 Nginx 路由，启用服务并重载 Nginx。环境文件已有空的 `AGENT_TOKEN` 时需自己补齐。

脚本不安装 Node、不申请证书，也不会自动安装 Chrome / Xvfb。模板见 [`personal-agent.service`](../cloud/deploy/personal-agent.service)、[`personal-agent-browser.service`](../cloud/deploy/personal-agent-browser.service) 与 [`agent-location.inc`](../cloud/deploy/agent-location.inc)。

## 云端浏览器

0.8 运行有界面的 Chrome / Chromium，由 **Xvfb** 提供显示环境；在已配对 App 里查看画面并接管。它与页面截图检查所用的 Headless Shell 是两套用途不同的依赖。

### Alibaba Cloud Linux 3 与 RHEL 8 家族

[`browser-setup.sh`](../cloud/deploy/browser-setup.sh) 使用 `dnf`，安装 Chrome / Chromium、Xvfb、运行库和中文字体。依赖约占 0.8–1.5GiB；另为包下载预留约 2GiB 空闲磁盘，用户配置和下载文件需再留空间。

```bash
cd /opt/personal-agent/cloud
sudo bash deploy/browser-setup.sh

# 如果尚未安装本体，此时再运行
sudo bash deploy/install.sh
```

准备脚本不启动或重启服务。安装服务后 host 常驻，Chrome 按需启动。

### 其他发行版

按自己的发行版安装 Chrome / Chromium、Xvfb、中文字体和浏览器运行依赖。当前 `browser-setup.sh` 不适用于没有 `dnf` 的系统。

浏览器默认检查常见可执行文件名。需要自定义路径时，为**浏览器服务**增加 drop-in：

```bash
sudo systemctl edit personal-agent-browser
```

```ini
[Service]
Environment=AGENT_BROWSER_EXECUTABLE=/usr/bin/chromium
```

按自己实际安装路径替换，随后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl restart personal-agent-browser
```

当前模板限制本体 `MemoryMax=900M`、浏览器 `MemoryMax=800M`。Chrome 与 Xvfb 以 `agent` 普通用户运行，保留浏览器沙箱；浏览器服务不读取模型凭据环境文件。登录状态保存在 `/srv/agent/system/browser/profile/`，随个人数据保护和备份。

服务器访问目标网站需要代理时，浏览器也需要自己的出站网络配置；只给本体设置 `HTTPS_PROXY` 不代表浏览器服务会继承。根据自己的网络方案配置，不要把含模型凭据的整份环境文件交给浏览器。

安装后实际验证：在 App 控制台打开浏览器，打开网页、查看画面、接管后交还。登录、验证码或付款可能需要用户参与。

## 配对 Android 和 Mac

```bash
# 仅检查服务与反向代理，不验证模型或浏览器
curl --fail https://agent.example.com/agent/health

# 生成一次性六位配对码
sudo -u agent /usr/bin/node /opt/personal-agent/cloud/src/pair.mjs
```

从 [v0.8.0 发布页](https://github.com/Xiamu-ssr/personal-agent/releases/tag/v0.8.0)下载 APK / DMG。第一次登录填写自己的地址 `https://agent.example.com/agent` 与配对码。

配对码 24 小时有效，成功后立即作废；连续输错五次也会作废。另一台设备重新生成，已登录设备不受影响。

1. `/health` 返回 `{"ok":true}`，确认 HTTPS 与路由。
2. App 配对并显示在线，确认长连接。
3. 发消息收到模型回复，确认端点、凭据和模型 ID。
4. 按需连接应用或开启本机能力，实际查询所需数据。
5. 分别运行云端浏览器与动态刷新，检查实际结果。

首次主聊天引导称呼、起名和连接应用；已有历史的会话不会重复首次介绍。可直接告诉豆豆想看哪些动态。

健康数据依赖手机授权及 Health Connect / 厂商实际提供的数据。Mac 的文件、日历、屏幕录制与辅助功能按需授权；设备离线时对应能力不可用。

## 从 0.7 升级到 0.8

**0.7 及更早客户端不兼容 0.8 云端。** 云端更新后安装同版本 APK / DMG。

升级前备份整个数据目录及 `/etc/personal-agent.env`；等待当前工作结束后再更新代码、安装服务并重启。环境文件与备份含访问凭据和个人内容，不要提交到仓库。

首次启动由 [`migrate-v08.mjs`](../cloud/src/migrate-v08.mjs) 迁移：

- 旧站点并入 `data/library/artifacts/`，媒体文件并入 `data/library/media/`。
- 日记和角色文件并入 `data/soul/`。
- 旧简报及被替换的配置保留在 `backup/`；晨报、晚报与健康周报定时项退役。
- 初始化动态、点子、目标及新的目录结构，记录迁移标记。

不要用旧数据目录覆盖已运行的 0.8 根目录。升级失败时先停止服务，再依据升级前完整备份处理恢复。

## 语音转写与页面截图

语音转写将 `ANTHROPIC_BASE_URL` 末尾的 `/anthropic` 去掉，请求该基址的 `/v1/chat/completions`，使用同一份 `ANTHROPIC_AUTH_TOKEN`。端点还需支持 OpenAI 格式的 `input_audio` 和配置的音频模型。

`AGENT_ASR_MODEL` 默认 `google/gemini-3.5-flash-lite`。只支持 Messages API 的端点可能能文字聊天，却无法转写。用按住说话或语音笔记实际确认，源码见 [`transcribe.mjs`](../cloud/src/transcribe.mjs)。

页面截图检查使用独立 Headless 浏览器。[`install-screenshot.sh`](../cloud/scripts/install-screenshot.sh) 适用于 RHEL 8 兼容的 Linux x86_64，安装锁定版本 Chrome Headless Shell 与中文字体：

```bash
cd /opt/personal-agent/cloud
sudo bash scripts/install-screenshot.sh
sudo systemctl restart personal-agent
```

其他发行版可自行安装兼容浏览器，在本体环境文件配置 `AGENT_SCREENSHOT_BROWSER`。让豆豆打开构件并执行页面截图，确认实际可用；安装云端浏览器不能证明截图检查依赖已经就绪。

## 环境变量

| 变量 | 默认值或用途 |
| --- | --- |
| `ANTHROPIC_BASE_URL` | 自己的 Anthropic 兼容 API 基址 |
| `ANTHROPIC_AUTH_TOKEN` | 模型端点访问凭据 |
| `AGENT_TOKEN` | App / 设备鉴权，安装脚本按需生成 |
| `AGENT_ROOT` | `/srv/agent`，个人内容与运行状态目录 |
| `AGENT_HOST` / `AGENT_PORT` | `127.0.0.1` / `4400`，由 Nginx 提供 HTTPS |
| `AGENT_TZ` | `Asia/Shanghai` |
| `AGENT_NAME` / `AGENT_USER_CALL` | `豆豆` / `用户` |
| `AGENT_COMPACT_EFFORT` | `low`，可选 `low` / `medium` / `high` |
| `AGENT_ASR_MODEL` | `google/gemini-3.5-flash-lite` |
| `AGENT_SCREENSHOT_BROWSER` | 可选，页面截图检查的浏览器可执行文件 |
| `HTTPS_PROXY` | 可选，本体的出站代理；浏览器服务另配 |

`AGENT_BROWSER_SERVICE` 由本体 unit 指定为 `personal-agent-browser.service`；`AGENT_BROWSER_EXECUTABLE` 设置在浏览器服务里。模型与权限模式由 App 管理。

## 数据与维护

默认根目录 `/srv/agent`：

| 目录 | 内容 |
| --- | --- |
| `data/memory/`、`data/soul/` | 分类记忆、总档、角色和日记 |
| `data/feed/`、`data/ideas/`、`data/goals/` | 动态、点子和目标 |
| `data/library/artifacts/`、`data/library/media/` | 构件、网页、文档和媒体 |
| `data/uploads/`、`data/health/` | 用户附件与同步的健康数据 |
| `workspace/` | 任务中间产物与草稿 |
| `system/` | 会话、连接配置、定时任务与运行状态 |
| `system/browser/profile/` | 云端浏览器登录状态 |
| `backup/` | 升级迁移保留的旧内容与配置 |

备份整个根目录及 `/etc/personal-agent.env`。模型端点会收到本轮需要的对话、记忆和工具结果，连接的服务会收到相应调用；自部署不等于推理完全离线。

改变 `AGENT_ROOT` 时，同步调整本体和浏览器 unit 的环境、工作目录与权限，以及配对命令：

```bash
sudo -u agent env AGENT_ROOT=/srv/my-agent \
  /usr/bin/node /opt/personal-agent/cloud/src/pair.mjs
```

更改端口需同步 Nginx 上游；更改 Node 或代码路径需调整两个 unit。环境文件修改后重启相应服务，unit 修改后先执行 `daemon-reload`。

```bash
sudo systemctl status personal-agent personal-agent-browser --no-pager
sudo journalctl -u personal-agent -n 50 --no-pager
sudo journalctl -u personal-agent-browser -n 50 --no-pager
```

检查推理、搜索、浏览器和设备的失败原因，公开日志前移除个人内容与凭据。验收与已知限制见 [README](../README.md#验证与已知限制)和 [v0.8.0 发布说明](https://github.com/Xiamu-ssr/personal-agent/releases/tag/v0.8.0)。
