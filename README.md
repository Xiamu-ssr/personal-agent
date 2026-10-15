<p align="center"><em>A personal AI companion on your own server.</em></p>

<p align="center">
  <img src="docs/images/v0.8/hero.jpg" alt="豆豆 Personal Agent：从一句话开始，陪你把事情做完。芽豆插画与代码排版文字。" width="960">
</p>

<p align="center">
  <a href="https://github.com/Xiamu-ssr/personal-agent/releases/tag/v0.8.0"><img src="https://img.shields.io/badge/Release-v0.8.0-C9A45C?style=flat-square&amp;labelColor=101612" alt="Release v0.8.0"></a>
  <img src="https://img.shields.io/badge/Platforms-Android%20%C2%B7%20macOS%20%C2%B7%20Cloud-C9A45C?style=flat-square&amp;labelColor=101612" alt="Android · macOS · Cloud">
  <a href="https://github.com/anthropics/claude-agent-sdk-typescript"><img src="https://img.shields.io/badge/Built%20with-Claude%20Agent%20SDK-C9A45C?style=flat-square&amp;labelColor=101612" alt="Built with Claude Agent SDK"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-C9A45C?style=flat-square&amp;labelColor=101612" alt="MIT License"></a>
</p>

<p align="center">
  <a href="#开始使用">下载安装</a> · <a href="#功能">功能与截图</a> · <a href="#架构">架构</a> · <a href="#部署">自部署</a> · <a href="#spec">产品规格</a>
</p>

<p align="center"><strong>从一句话开始，陪你把事情做完。</strong><br>豆豆住在你自己的云主机上，记住你关心的事，到点继续做。<br>手机和 Mac 是同一个助手的两个入口，也是你按需交给它的手脚。</p>

<table width="100%">
  <tr>
    <td width="33%" align="center"><h3>3 端</h3>Android · macOS · 自有云</td>
    <td width="34%" align="center"><h3>5 个栏目</h3>聊天 · 动态 · 点子 · 目标 · 资源库</td>
    <td width="33%" align="center"><h3>11 个连接器</h3>邮箱 · 搜索 · 阅读 · 数据 · GitHub</td>
  </tr>
</table>

## 开始使用

**当前版本：[v0.8.0 · 会话即入口](https://github.com/Xiamu-ssr/personal-agent/releases/tag/v0.8.0)。** 需要自己的 Linux 云主机和模型端点；本项目不提供托管账号或内含模型额度。

| 设备 | 安装包 | 要求 |
| --- | --- | --- |
| Android | [下载 APK](https://github.com/Xiamu-ssr/personal-agent/releases/download/v0.8.0/doudou-0.8.0.apk) | Android 9 或更新版本 |
| Mac | [下载 DMG](https://github.com/Xiamu-ssr/personal-agent/releases/download/v0.8.0/doudou-0.8.0.dmg) | macOS 14 或更新版本，Apple 芯片 / Intel 通用 |
| 云端 | [部署指南](docs/deployment.md) | Linux、Node.js ≥ 20.9、systemd、Nginx、HTTPS |

先[部署云端](#部署)，生成一次性配对码，再在 App 填入自己的服务器地址。第一次聊天，豆豆会问怎么称呼你、自己叫什么，再推荐需要连接的应用和本机能力。

**从 0.7 升级：云端与客户端都需要更新到 0.8。** 旧版 App 不再兼容；首次启动云端会迁移旧数据，升级前请备份。详见[升级说明](docs/deployment.md#从-07-升级到-08)。

## 功能

### 想到什么，直接告诉它

<table width="100%">
  <tr>
    <td width="32%" align="center"><a href="docs/images/v0.8/phone-chat.png"><img src="docs/images/v0.8/phone-chat.png" alt="Android 0.8 聊天：芽豆头像、独立气泡、选择卡片与按需连接应用；模拟器演示数据" width="200"></a></td>
    <td width="68%" valign="middle">
      <sub>01 / CONVERSATION</sub>
      <h3>聊天就是入口。</h3>
      <ul>
        <li>发文字、图片、文件，按住说话，或留一条语音笔记。</li>
        <li>它忙着做事时，你也能接着说；新消息进入当前这一轮。</li>
        <li>回复以独立气泡和卡片出现，工具细节收进头像里的控制台。</li>
        <li>遇到需要选择或确认的关键动作，先给你选项，再继续。</li>
        <li>应用和设备能力按需连接，在对应设备上由你授权。</li>
      </ul>
    </td>
  </tr>
</table>

### 你关心的事，持续有新消息

<table width="100%">
  <tr>
    <td width="68%" valign="middle">
      <sub>02 / FEED</sub>
      <h3>动态，替代一整份晨晚报。</h3>
      <ul>
        <li>告诉它想看什么，它按你的口味查找新消息。</li>
        <li>默认每天 7:00–23:00，每 30 分钟检查一次，每次发布 0–2 条。</li>
        <li>写明来源、时间，附原文链接；有原文配图时一起展示。</li>
        <li>赞、踩，或点「讨论」接着聊；更新间隔和时段都能调整。</li>
        <li>动态使用 Haiku 5.5；实际搜索耗时和模型费用由你的端点决定。</li>
      </ul>
    </td>
    <td width="32%" align="center"><a href="docs/images/v0.8/phone-feed.png"><img src="docs/images/v0.8/phone-feed.png" alt="Android 0.8 动态：来源、原文链接、图片、赞踩讨论和时间；模拟器演示数据" width="200"></a></td>
  </tr>
</table>

### 单独聊件事，原来的工作接着做

<p align="center"><a href="docs/images/v0.8/mac-side-chat.png"><img src="docs/images/v0.8/mac-side-chat.png" alt="Mac 0.8 独立旁聊：侧栏会话、自己的消息历史与选择卡片；本地验收演示数据" width="960"></a></p>

从侧栏或抽屉新开一个旁聊，围绕另一件事继续问。主聊天和旁聊各自保存消息与选项状态，主聊天正在处理的工作不需要停下。芽豆的五种动画状态会告诉你：空闲、工作中、等你回复、完成、出错。

### 点子、目标和成果，各有去处

| 栏目 | 你可以怎么用 |
| --- | --- |
| **点子** | 根据记忆、目标和最近聊过的事，看看豆豆现在能帮上什么忙；点一条就开聊。 |
| **目标** | 在聊天里定目标，约定跟进频率，持续看进度和下一小步。 |
| **资源库** | 反复打开做好的网页、文档、图片和影音；构件与媒体分别收好。 |

<details>
<summary><strong>展开查看点子、目标与资源库截图</strong></summary>

<p align="center">
  <a href="docs/images/v0.8/phone-ideas.png"><img src="docs/images/v0.8/phone-ideas.png" alt="Android 0.8 点子，模拟器演示数据" width="200"></a>
  <a href="docs/images/v0.8/phone-goals.png"><img src="docs/images/v0.8/phone-goals.png" alt="Android 0.8 目标，模拟器演示数据" width="200"></a>
  <a href="docs/images/v0.8/phone-library.png"><img src="docs/images/v0.8/phone-library.png" alt="Android 0.8 资源库，模拟器演示数据" width="200"></a>
</p>

</details>

### 浏览器在云端，决定权在你手里

云主机上运行一个真正的 Chrome。豆豆可以打开网页、点击、输入；你能在 App 里看到画面，需要登录、验证码或付款时接管，完成后交还给它继续。登录状态保存在自己的云主机上。

**11 个内置云端连接器**：QQ 邮箱、163 邮箱、126 邮箱、Gmail、腾讯企业邮、阿里企业邮、通用 IMAP、Tavily、微信读书、Wind AI、GitHub（只读）。邮箱支持同一服务连接多个账号。数量来自[当前注册表](cloud/connectors/index.mjs)，接入方式见[连接器规格](spec/connectors.md)。

手机可提供已授权的日历、短信、位置、通知与健康数据；Mac 可提供命令行、文件、电脑操作和日历等能力。需要哪项再开启；设备离线时，相应本机能力不可用。

### 同一个豆豆，在更大的屏幕上

<p align="center"><a href="docs/images/v0.8/mac-feed.png"><img src="docs/images/v0.8/mac-feed.png" alt="Mac 0.8 动态页：五栏目侧栏、悬浮芽豆头像与信息流；本地验收演示数据" width="960"></a></p>

手机用悬浮底栏，Mac 用侧边栏。黑白外观跟随系统切换，蓝色留给链接。记忆、活动、权限、定时和云端浏览器统一收在头像控制台里。

<details>
<summary><strong>查看深色外观</strong></summary>

<p align="center"><a href="docs/images/v0.8/phone-feed-dark.png"><img src="docs/images/v0.8/phone-feed-dark.png" alt="Android 0.8 深色动态页；模拟器演示数据" width="240"></a></p>

</details>

<p align="center"><sub>本页 0.8 界面截图来自 Android 模拟器与 Mac 本地 App 的第二轮验收，均使用演示内容；不代表真实账号或手机真机数据。首图为芽豆插画，文字由代码排版，实际界面以单张截图为准。</sub></p>

## 架构

```mermaid
flowchart TB
  Android["Android · 聊天与已授权的本机能力"]
  Mac["macOS · 聊天与已授权的本机能力"]

  subgraph Cloud["你自己的 Linux 云主机"]
    Gateway["App / 设备网关"]
    Core["Claude Agent SDK · 会话与后台工作"]
    Content["灵魂与记忆 · 动态 · 目标 · 资源库"]
    Schedule["定时触发"]
    Browser["独立浏览器服务 · Chrome + Xvfb"]
    Connectors["按需连接的云端服务"]
    Gateway <--> Core
    Core <--> Content
    Schedule --> Core
    Core <--> Browser
    Core <--> Connectors
    Gateway <--> Browser
  end

  Model["你配置的 Anthropic 兼容模型端点"]
  Services["邮箱 · 搜索 · 阅读 · 数据 · GitHub"]
  Websites["网站"]
  Android <-->|"HTTPS / WebSocket"| Gateway
  Mac <-->|"HTTPS / WebSocket"| Gateway
  Core <--> Model
  Connectors <--> Services
  Browser <--> Websites

  classDef gold fill:#F3E3B5,stroke:#C9A45C,color:#172033
  class Core gold
  style Cloud fill:#F8F8F5,stroke:#C9A45C,color:#172033
```

**云端是本体，手机和电脑是手脚。** 关掉 App 后，云端定时工作仍能继续；调用本机能力时，那台设备必须在线。浏览器有独立服务与资源限制，按需启动 Chrome。

个人内容保存在云主机的 `data/`，任务草稿在 `workspace/`，会话、连接配置和浏览器登录状态在 `system/`。推理时会将本轮需要的对话、记忆和工具结果发给你配置的模型端点。具体目录和备份方式见[部署指南](docs/deployment.md#数据与维护)。

## 部署

准备自己的 **Linux 云主机、Node.js ≥ 20.9、Git、curl、OpenSSL、Nginx、systemd 与 HTTPS 域名**，以及兼容 Anthropic Messages API 的模型端点。启用云端浏览器还需要 Chrome / Chromium、Xvfb 和中文字体，建议为整机预留至少 4GB 内存。

```bash
sudo git clone https://github.com/Xiamu-ssr/personal-agent.git /opt/personal-agent
sudo touch /etc/personal-agent.env
sudo chmod 600 /etc/personal-agent.env
sudoedit /etc/personal-agent.env
```

填写自己的模型端点：

```dotenv
ANTHROPIC_BASE_URL=https://api.example.com/anthropic
ANTHROPIC_AUTH_TOKEN=replace-with-your-api-key
AGENT_TZ=Asia/Shanghai
```

在已有 HTTPS 的 Nginx `server` 块中加入：

```nginx
include /etc/nginx/agent-location.inc;
```

安装云端。下面的浏览器准备脚本适用于 **Alibaba Cloud Linux 3 / RHEL 8 的 `dnf` 环境**；其他发行版请按[完整指南](docs/deployment.md#云端浏览器)准备对应依赖。

```bash
cd /opt/personal-agent/cloud
sudo bash deploy/browser-setup.sh
sudo bash deploy/install.sh

# 只检查服务与 HTTPS 路由是否可达
curl --fail https://agent.example.com/agent/health

# 为一台 App 生成一次性六位配对码
sudo -u agent /usr/bin/node /opt/personal-agent/cloud/src/pair.mjs
```

安装脚本会准备 `agent` 用户与 `/srv/agent`，按需生成 `AGENT_TOKEN`，安装本体、独立浏览器服务和 Nginx 路由。它不安装 Node、不申请 HTTPS 证书。

App 填写自己的地址，例如 `https://agent.example.com/agent`，以及配对码。配对码 24 小时有效、用后作废；另一台设备重新生成。配对后发一条消息，确认模型真正回复，再按需连接应用和本机能力。

模型、权限模式在 App 设置里选择。当前默认模型为 Haiku 5.5，亦可选 Opus 5.5、GLM 5.3 Flash / FlashX；动态任务另固定使用 Haiku 5.5，因此端点也要支持它。模型 ID、环境变量、语音转写及维护命令见[完整部署指南](docs/deployment.md)。

## Spec

[`spec/`](spec/) 保存产品规格与提示词。聊天行为、动态更新、旁聊、云端与设备的分工，都在这里对齐；其中的草案与待对齐项不等于已发布功能。

直接打开 [`spec/index.html`](spec/index.html)，点架构节点查看产品说明、边界与完整提示词，无需启动服务。

```bash
# macOS，在仓库根目录打开离线规格
open spec/index.html

# 修改规格或提示词后重新生成
node spec/build.mjs
```

规格数据在 [`spec/spec.yaml`](spec/spec.yaml)，提示词在 [`spec/prompts/`](spec/prompts/)。

## 验证与已知限制

[v0.8.0 发布记录](https://github.com/Xiamu-ssr/personal-agent/releases/tag/v0.8.0)记录了：云端 **184 项**测试、Android **97 项**单元测试与 **73 张截图 / 7 段录屏**、Mac **80 项**逻辑断言和通用安装包构建。线上还用真实模型验证了「说话」和云端浏览器。这些是该版本的验收记录，不是每个设备、账号与网站的兼容性保证。

- Android 界面验收使用模拟器；健康数据和手机权限仍需要真机验证。
- 网页登录、验证码和网站自身限制可能需要用户接管；模型、搜索和第三方服务的费用另计。
- 动态刷新时间受搜索与模型响应影响，不保证在每个检查时点立即生成内容。
- 云端浏览器占用额外内存；服务模板限制本体 900MB、浏览器 800MB，小内存机器需留意系统与其他服务的余量。

## 从源码构建

**Android**：JDK 17、Android SDK 36，最低 Android 9。

```bash
cd android
./gradlew assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
```

自己的签名配置放在 `~/.personal-agent/signing.properties`；没有该文件时，当前脚本使用 debug 签名。

**Mac**：macOS 14+、Xcode Command Line Tools，在仓库根目录运行：

```bash
# 首次构建创建自己的本地签名身份，可能弹出钥匙串授权
bash mac/tools/make-signing-identity.sh
VERSION=0.8.0 bash mac/build.sh
# 产物：mac/build/doudou-0.8.0.dmg；Apple 芯片 + Intel 通用
```

Mac 安装包采用本地签名，未做 Apple 公证；首次安装的打开方式见[发布说明](https://github.com/Xiamu-ssr/personal-agent/releases/tag/v0.8.0)。

## License 与致谢

以 [MIT License](LICENSE) 开源，Copyright © 2026 Xiamu-ssr。第三方依赖与素材遵循各自许可证。

感谢 [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)、[Model Context Protocol](https://github.com/modelcontextprotocol/typescript-sdk)、[Jetpack Compose](https://developer.android.com/compose)、[SwiftUI](https://developer.apple.com/xcode/swiftui/)、[Playwright](https://github.com/microsoft/playwright) 与所有依赖项目。0.8 的会话与动态交互参考了 Meta Muse。

<p align="center"><strong>让你的助手，住在你自己的云里。</strong><br><sub>如果豆豆对你有用，欢迎 Star、反馈和一起改进。</sub></p>
