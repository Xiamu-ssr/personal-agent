# 自部署豆豆

这份指南使用通用路径与示例域名。把示例端点、凭据和域名换成自己的配置。云端、App 安装包与产品规格都在同一个仓库里。

## 准备服务器与推理端点

需要一台有 `systemd` 的 Linux 服务器、可用的 `sudo`、Node.js ≥ 20.9、Git、curl、OpenSSL、Nginx，以及自己的域名和 HTTPS 证书。按所用 Linux 发行版准备这些工具。

[`cloud/deploy/personal-agent.service`](../cloud/deploy/personal-agent.service) 的 Node 路径是 `/usr/bin/node`，代码路径是 `/opt/personal-agent`。如果使用其他 Node 安装路径，需要在服务器上修改已安装 unit 的 `ExecStart`。

```bash
/usr/bin/node --version
```

推理端点通过 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN` 配置。除了兼容 Anthropic Messages API，还须支持当前 App 设置里的模型 ID，或在端点侧完成映射：

- `anthropic/claude-haiku-5.5`（默认）
- `z-ai/glm-5.3-flash`
- `z-ai/glm-5.3-flashx`

模型与权限模式由 App 管理，不通过环境变量切换。定义见 [`cloud/src/app-settings.mjs`](../cloud/src/app-settings.mjs)。

## 安装云端

以下使用部署脚本的默认路径：

```bash
sudo git clone https://github.com/Xiamu-ssr/personal-agent.git /opt/personal-agent
sudo touch /etc/personal-agent.env
sudo chmod 600 /etc/personal-agent.env
sudoedit /etc/personal-agent.env
```

填入最小配置：

```dotenv
ANTHROPIC_BASE_URL=https://api.example.com/anthropic
ANTHROPIC_AUTH_TOKEN=replace-with-your-api-key
AGENT_TZ=Asia/Shanghai
```

完整[环境变量列表](../README.md#部署)在 README 中。`AGENT_TOKEN` 是 App 和设备的鉴权凭据，和模型端点凭据不同；安装脚本在环境文件中找不到该项时会自动生成，已有空值需要先补齐。

Nginx 需要已经能提供 HTTPS。在自己的 HTTPS `server` 块中添加下面这行；安装脚本随后会创建这个 include 文件，再检查并重载 Nginx：

```nginx
include /etc/nginx/agent-location.inc;
```

[`agent-location.inc`](../cloud/deploy/agent-location.inc) 将 `/agent/` 反向代理到 `127.0.0.1:4400`，包含 WebSocket Upgrade 设置与长连接超时。修改云端端口时，上游地址也要一起修改。

```bash
cd /opt/personal-agent/cloud
sudo bash deploy/install.sh
```

[`install.sh`](../cloud/deploy/install.sh) 的实际工作：

- 安装 `cloud/package.json` 中的运行依赖，检查入口目录的 JavaScript 语法。
- 创建 `agent` 用户，准备 `/srv/agent` 并设置权限。
- 按需生成 `AGENT_TOKEN`，安装 systemd unit 与 Nginx include。
- 启用并重启 `personal-agent` 服务，检查并重载 Nginx。

它要求环境文件、Node 与 Nginx 已经准备好。脚本按默认路径部署，不安装 Node、配置域名或申请证书。

## 配对 Android 和 Mac

```bash
# 无需鉴权的存活接口，只检查服务和反向代理是否可达
curl --fail https://agent.example.com/agent/health

# 生成一次性六位配对码
sudo -u agent /usr/bin/node /opt/personal-agent/cloud/src/pair.mjs
```

在 [Releases](https://github.com/Xiamu-ssr/personal-agent/releases/latest) 下载 APK / DMG。App 第一次登录时填写自己的云端地址 `https://agent.example.com/agent` 与配对码。HTTPS 地址使用 `/agent` 路径，App 会连接相应的 API 与 WebSocket。

配对码 24 小时有效，成功后立即作废；连续输错五次也会作废。另一台设备需要重新生成配对码，已经登录的设备不受影响。默认数据目录下，配对命令不用读取模型凭据。

按这个顺序确认可用：

1. `/health` 返回 `{"ok":true}`，确认 HTTPS 与路由可达。
2. App 配对成功、显示在线，确认 App 长连接可用。
3. 发一条简单消息并收到回复，确认推理端点、凭据和模型映射可用。
4. 在「连接应用」逐项开启本机能力或配置云端账号，再实际查询一次所需数据。

健康数据需要手机开启健康能力，且 Health Connect / 厂商确实提供相应数据。Mac 的文件、通知、日历、屏幕录制和辅助功能按需授权。设备离线时，云端后台工作仍能继续，设备调用会返回离线原因。

## 简报与站点的截图检查

截图功能还需要 **Chrome / Chromium 与中文字体**。云端的 `playwright-core` 依赖不会自动下载浏览器。

仓库提供的 [`install-screenshot.sh`](../cloud/scripts/install-screenshot.sh) 使用 `dnf`，适用于 RHEL 8 兼容系统的 Linux x86_64。它安装浏览器依赖、与锁定 Playwright 版本匹配的 Chrome Headless Shell，以及 Noto 中文字体：

```bash
cd /opt/personal-agent/cloud
sudo bash scripts/install-screenshot.sh
sudo systemctl restart personal-agent
```

其他发行版请自行安装兼容的 Chrome / Chromium、运行依赖和中文字体，将可执行文件路径写进环境文件的 `AGENT_SCREENSHOT_BROWSER`，再重启服务。默认浏览器位置是 `/opt/personal-agent-browser/chrome-headless-shell-linux64/chrome-headless-shell`。

完成后，让豆豆生成一份简报或站点，并实际使用「页面截图」检查。浏览器安装成功只说明依赖就绪。

## 语音转写

当前转写实现会把 `ANTHROPIC_BASE_URL` 末尾的 `/anthropic` 去掉，再请求该基址的 `/v1/chat/completions`，使用同一份 `ANTHROPIC_AUTH_TOKEN`。端点需要支持 OpenAI 格式的 `input_audio` 与配置的音频模型。

`AGENT_ASR_MODEL` 默认是 `google/gemini-3.5-flash-lite`。只兼容 Anthropic Messages API 的端点可以提供文字对话，但不一定能提供当前语音转写；接入要求见 [`cloud/src/transcribe.mjs`](../cloud/src/transcribe.mjs)。用一次按住说话或语音笔记确认自己的端点是否可用。

## 数据、路径与维护

默认根目录是 `/srv/agent`：

| 目录 | 内容 |
| --- | --- |
| `data/memory/` | 分类记忆与总档 |
| `data/briefs/`、`data/sites/` | 简报与常驻站点 |
| `data/diary/`、`data/uploads/`、`data/health/` | 日记、用户附件、同步的健康数据 |
| `workspace/` | 任务中间产物与草稿 |
| `system/` | 会话、连接器配置、定时任务与运行状态 |

备份时保留整个根目录及 `/etc/personal-agent.env`，其中包含个人内容和访问凭据。推理端点会收到本轮需要的对话、记忆与工具结果。

改变 `AGENT_ROOT` 时，必须准备对应目录并让 `agent` 用户可写，同时调整 unit 的 `WorkingDirectory`。配对命令也需使用同一个根目录：

```bash
sudo -u agent env AGENT_ROOT=/srv/my-agent \
  /usr/bin/node /opt/personal-agent/cloud/src/pair.mjs
```

改变 `AGENT_PORT` 时同步修改 Nginx 上游；改变 Node / 代码路径时同步修改 unit。环境文件修改后重启服务；unit 修改后先执行 `sudo systemctl daemon-reload`。

```bash
sudo systemctl restart personal-agent
sudo systemctl status personal-agent --no-pager
sudo journalctl -u personal-agent -n 50 --no-pager
```

检查日志时留意推理、连接器与设备的具体失败原因。公开日志前先检查并移除个人内容与凭据。v0.6.0 的功能验证范围和已知限制见[发布说明](https://github.com/Xiamu-ssr/personal-agent/releases/tag/v0.6.0)。
