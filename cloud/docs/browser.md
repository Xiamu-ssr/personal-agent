# 豆豆 0.8 云端浏览器

一个常驻于 cloud 进程内的控制器，按需使用一个有界面的 Chrome。生产 Linux 通过常驻的系统服务 `personal-agent-browser.service` 启动 Chrome；无 `DISPLAY` 时先启动 Xvfb（1280×800×24）。macOS 不走系统服务，直接懒启动系统 Google Chrome。没有虚拟机、桌面环境、VNC 或新的 npm 依赖。

## Lead 接线

入口 `src/browser/index.mjs`：

```js
import { CloudBrowser, createBrowserMcpServer, attachBrowserRoutes } from "./browser/index.mjs";

// 同一服务只创建一次；主会话、后台会话、HTTP/WS 共用这个控制器。
const browser = new CloudBrowser({ root: config.root });

// 每个 SDK query 创建新的 MCP transport/server；控制器仍然共享。
const mcpServers = { browser: createBrowserMcpServer({ browser }) };

// server 是已有 node:http Server；在其 request/upgrade 监听器都注册后、listen 前调用。
const browserRoutes = attachBrowserRoutes(server, { browser, authenticate: authed });
// 也可传 token: config.token。未指定 authenticate 时沿用 Bearer / pa_token 的校验规则。

browser.on("returned", (event) => {
  // Harness 将内部 [浏览器交还] 消息送回原会话的 AsyncIterable 输入流。
  // 后台等待接管时保留原 query；不生成用户气泡，也不占主聊天。
});

// 服务退出时先清理浏览器和浏览器 WS，再关 HTTP。
await browserRoutes.close();
```

- `createBrowserMcpServer({ browser?, root?, idleMs?, executablePath?, noSandbox? })` 返回 SDK 的 `type: "sdk"` MCP server 配置，不是整个 `mcpServers` 字典。名字为 `browser`。
- `attachBrowserRoutes(server, { browser?, root?, token?, authenticate? })` 挂载 HTTP/WS，返回 `{ browser, close }`。`close()` 可重复调用，会终止浏览器 WS、关闭 Chrome/Xvfb、恢复挂载前的监听器。
- 两边省略 `browser`、提供同一个 `root` 时，也会使用按 root 缓存的同一个控制器。生产建议显式创建并共享；不要创建多个控制器操作同一个 profile。
- 适配器封装现有 `request` / `upgrade` 监听器，先分流浏览器路径，其余路径继续交给原监听器。这使原有 catch-all 404 / WS 401 不会抢先处理浏览器请求。挂载后不要另加 catch-all 监听器。
- 控制器的 `state` 事件与 WS 状态对象一致；`frame` 事件为帧对象；`returned` 在实际发生用户→豆豆交还时发出，带 `t: "browser_returned"` 和先前的接管原因 `reason`。重复交还不重复发事件。
- 模块不直接依赖或修改 Harness；lead 必须接 `returned`，才能在上一回合已经结束时主动唤醒豆豆继续。只显示状态不会自动创建新的 Agent 回合。

## 进程、数据与内存

```text
system.slice/
 ├─ personal-agent.service（900M）
 │   ├─ 进程内 MCP（主/后台 query 各自的 transport）
 │   └─ HTTP / WS → 同一个 CloudBrowser → loopback host / CDP
 └─ personal-agent-browser.service（800M，允许 swap）
     └─ 常驻 Node host → 按需 Xvfb + Chrome
         ├─ 持久用户上下文，一个标签页
         └─ 资源库缩略图临时隔离上下文，完成即关闭
```

两项都是 `User=agent` 的系统服务，本体只通过 loopback 和私有 `system/browser/service.json` 连接 host，不调用 systemctl。host 开机启动但不启动 Chrome；关闭浏览器、空闲回收或 Chrome 崩溃不会退出 host。缩略图复用同一个 Chrome，不再有单独的截图服务模板。macOS 开发不设置 `AGENT_BROWSER_SERVICE`，继续由控制器直接管理 Chrome；本机也可用独立 host 子进程测试通信。

固定目录：`<ROOT>/system/browser/profile`、`<ROOT>/workspace/browser-downloads`。浏览器目录/profile 权限 0700；Cookie、localStorage 随 profile 保留，下载不会因关闭浏览器删除。不要把 profile 放进 App 文件接口或版本库。新进程启动前清理陈旧的 `DevToolsActivePort`，使用 Chrome 分配的随机调试端口，强制绑定 loopback；不暴露 CDP 和 X11 到公网，不使用 token URL 查询参数。

Linux 用 Xvfb 的 `-displayfd` 原子选择空闲显示器，`-nolisten tcp` 禁止 X11 TCP。Chrome 与 Xvfb 各自有独立 Unix 进程组。启动失败、崩溃和关闭时清理自己拥有的进程组；不用全局 `pkill`，不影响其他 Chrome。Chrome 崩溃后下一次使用重新启动；Xvfb 退出也会清理 Chrome。已有 `DISPLAY` 的 Linux 和 macOS 不启动 Xvfb。

默认 10 分钟无操作关闭 Chrome 和 Xvfb。Agent 工具、用户输入、打开/接管/交还会更新计时；状态查询、观看 WS、画面刷新不会更新计时。正在运行的工具完成后重新计时。用户长时间没有输入也会关闭，但接管权仍归用户，需交还后豆豆才恢复操作。关闭先发 `Browser.close` 并等待进程退出，给 Cookie / localStorage 落盘时间，再以 TERM/KILL 清理残留进程。

只保留一个用户标签页。链接与 `window.open` 改在当前页打开，额外创建的用户页立即关闭；弹窗式 OAuth 可能需要网站支持同页登录。缩略图在隔离上下文内渲染本地构件，禁止外部 HTTP/WebSocket，不使用登录 Cookie，不改变用户页；一次只跑一个。Chrome 以 app 窗口启动，实时截图只含网页，固定 CSS 视口 1280×800。单标签页不等于单进程，跨站 iframe 和 Chrome 辅助服务仍可能产生子进程。

内存措施：关闭 GPU、扩展、同步、后台网络、默认应用、后台常驻、预渲染、备用 renderer、后退缓存等；renderer 软上限 1、V8 old space 192 MiB、磁盘缓存 64 MiB、媒体缓存 16 MiB。保留站点隔离和 Chrome 沙箱，不用 `--single-process`。这些参数不是总 RSS 的硬限制。`--disable-dev-shm-usage` 避免小 `/dev/shm` 导致启动失败。

可选环境：`AGENT_BROWSER_EXECUTABLE` 指定 Chrome/Chromium 可执行文件；`AGENT_BROWSER_NO_SANDBOX=1` 仅供宿主机沙箱确实不可用的部署。默认不关闭沙箱。已有 systemd 服务的 `NoNewPrivileges=true` 可能要求可用的用户命名空间沙箱；需要 lead 在目标机验证，安装脚本不会改服务配置。

目标机为 systemd 239、cgroup v1（hybrid），1.8G RAM、1G swap。本体的 `MemoryLimit/MemoryMax=900M` 不再包含 Chrome/Xvfb；浏览器服务两项均为 800M，不限制 swap，不使用 `OOMPolicy`。lead 实测知乎页约 575 MiB PSS、加 B 站标签页约 740 MiB，Xvfb 约 13 MiB；这是容量依据，不能替代包含 host、页缓存、截图峰值的 cgroup 计费。使用 `memory.usage_in_bytes`、`memory.max_usage_in_bytes` 和 PSS 验收，详见 [部署与内存隔离](browser-memory.md)。

## MCP 工具

所有描述为中文；工具名前缀由 SDK 添加为 `mcp__browser__`。

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `open` | `url` | 唯一标签页打开 HTTP/HTTPS，等 DOMContentLoaded |
| `snapshot` | 无 | Playwright `ariaSnapshot({mode:"ai"})`，可访问性树含 ref，最多 80,000 字符 |
| `click` | `ref` | 以最新快照 ref 点击 |
| `fill` | `ref,text` | 替换输入框内容 |
| `select` | `ref,values: string[]` | 按 value 选择下拉项 |
| `press` | `key,ref?` | Enter、Tab、Escape、ControlOrMeta+A 等；可指定元素 |
| `scroll` | `deltaY,deltaX?` | CSS 像素滚动，正数下/右 |
| `screenshot` | 无 | 返回 MCP JPEG image content |
| `wait` | `seconds?` | 默认 1 秒，最多 10 秒，可被接管取消 |
| `request_takeover` | `reason` | 一句中文原因，切到用户控制并通知 App |

先 snapshot，再用 `e3` / `f1e3` 等 ref；导航、DOM 变化后重新读。工具默认操作超时 8 秒、导航超时 15 秒。遇到登录、验证码、付款确认必须请求用户接管。工具不会自动识别所有这类页面；依赖工具描述和 Agent 判断。

所有 Agent 工具在用户接管时返回普通 MCP text，`isError` 不为 true，不会触碰页面：

```json
{"blocked":true,"message":"用户正在操作，等他交还"}
```

接管立即标记控制权，取消当前可取消的 Playwright 操作，阻挡排队中的旧工具；输入和交还在同一操作队列串行执行。接管 HTTP 响应完成后，之前的 Agent 操作已经退出。已经发出的点击无法撤销。交还释放尚未结束的鼠标拖动，再通知 lead；不会自动重复之前的点击/付款等操作。

## App 鉴权与 HTTP

路径以下均为服务内部路径；nginx 的 `/agent/` 前缀下，App 使用 `/agent/api/browser/...` 和 `/agent/ws/browser`。Bearer token 与现有 App 相同；浏览器 WebView 可使用已有 `pa_token` cookie。空 token 拒绝访问；不提供免鉴权接口。

| 方法 | 路径 | 请求体 / 响应 |
| --- | --- | --- |
| GET | `/api/browser/state` | 状态；不会启动 Chrome |
| POST | `/api/browser/open` | `{}`；启动并返回状态，不改变控制权 |
| POST | `/api/browser/takeover` | `{"reason":"我来登录"}`；reason 可省略，启动并接管 |
| POST | `/api/browser/return` | `{}`；交还并返回状态，不会重新打开已关闭的 Chrome |
| POST | `/api/browser/close` | `{}`；等进程清理结束后返回 closed 状态 |
| POST | `/api/browser/input` | 下述输入事件；成功 `{"ok":true}` |

请求体上限 64 KiB。错误为 `{"error":"原因"}`：401 未鉴权；400 JSON/字段/坐标非法；409 未接管、画面过期、接管已结束或浏览器关闭；413 体积过大；503 Chrome 不可用。不记录 token、输入文字、网页内容或 Chrome stderr。

## WS 实时画面

连接 `/ws/browser`，携带相同 Bearer / cookie。连接即订阅帧，但不会启动 Chrome；App 先 POST open 或 takeover。服务发送 JSON text messages：

```json
{"t":"browser_state","state":"user","control":"user","url":"https://example.com/login","title":"登录","reason":"这里要登录，你来一下","viewers":1,"idleTimeoutMs":600000,"lastActivityAt":1792000000000}
```

`state`：`closed` 已关闭，`idle` 已打开但空闲，`agent` 豆豆的工具执行中，`user` 用户接管中。`control` 为 `agent` / `user`；即使 closed，仍可能保留用户控制权。URL/title 为当前或最后一次页面信息；状态变化、导航、标题变化都会推送。`agent` 描述浏览器操作，不代表整个聊天回合。

```json
{"t":"browser_frame","frameId":21,"mimeType":"image/jpeg","data":"<base64 JPEG>","width":1280,"height":800,"viewport":{"width":1280,"height":800},"timestamp":1792000000200}
```

`width,height` 是 JPEG 像素尺寸；`viewport` 是此帧对应的 CSS 视口尺寸，考虑页面缩放；`timestamp` 为服务发送时间（毫秒）。`frameId` 在此服务进程内单调递增。`data` 不带 `data:` 前缀。

通过 CDP `Page.startScreencast`，JPEG quality 65；延迟 ack 合并变化帧，发送间隔至少 200ms，最多 5 fps。静态页面没有固定心跳帧。只缓存最后一张 JPEG 与最近 32 帧的尺寸信息；导航和关闭使旧 frameId 失效。WS 不启用压缩，慢连接积压超过 1 MiB 丢弃帧，超过 2 MiB 断开；客户端只保留最新一帧。服务每 30 秒 ping，失活连接清理。

App 切后台/画面不可见时发送：

```json
{"t":"browser_watch","watch":false}
```

恢复可见发送 `watch:true`。最后一个观看者取消订阅/断开时 `Page.stopScreencast`；仅看状态可以连上后立即 watch false。WS 断开不会自动交还控制权，以免登录操作被 Agent 抢走；10 分钟无操作仍会关闭进程。

## 用户输入 JSON

必须先 takeover。`x,y` 相对于实际显示的图片左上角，`width,height` 为图片在 App 中实际显示的尺寸，均不含黑边/留白；可使用 App 的逻辑点，无需换算为物理屏幕像素。服务按该 frameId 的 CSS 视口换算：`cssX=x/width*viewport.width`，`cssY=y/height*viewport.height`。不用额外加网页滚动量。

例如把 1280×800 的帧显示成 640×400，中点点击对应 CSS `(640,400)`：

```json
{"type":"click","frameId":21,"x":320,"y":200,"width":640,"height":400,"button":"left","clickCount":1}
```

连续拖动（滑块/验证码）推荐按序 await 每个 pointer 请求，发送间隔 30–60ms；pointer up 必须发送。`move` 可合并，`down/up` 不丢弃。交还会补发鼠标抬起。

```json
{"type":"pointer","phase":"down","frameId":21,"x":100,"y":200,"width":640,"height":400}
{"type":"pointer","phase":"move","frameId":22,"x":200,"y":200,"width":640,"height":400}
{"type":"pointer","phase":"up","frameId":23,"x":260,"y":200,"width":640,"height":400}
```

也可单次提交拖动路径（2–64 点，点间约 16ms）：

```json
{"type":"drag","frameId":21,"width":640,"height":400,"points":[{"x":100,"y":200},{"x":150,"y":200},{"x":200,"y":200}]}
```

滚动 delta 同样使用显示图片坐标单位，服务换算为 CSS 像素：

```json
{"type":"scroll","frameId":21,"x":320,"y":200,"width":640,"height":400,"deltaX":0,"deltaY":120}
```

点击输入框聚焦后发 text，使用 `Input.insertText`，支持中文/粘贴（最多 16,384 字符），不会替换已输入内容。App 用本地 IME 合成，提交最终文本，避免重复提交 composing 文本。

```json
{"type":"text","text":"中文输入"}
{"type":"key","key":"Enter"}
{"type":"key","key":"a","modifiers":2}
```

key 使用 Enter、Tab、Backspace、Delete、Escape、ArrowLeft/Up/Right/Down、Home、End、PageUp、PageDown、空格、单个英文字母/数字。`modifiers` 为 CDP 位掩码：Alt=1、Ctrl=2、Meta=4、Shift=8，可相加；每次请求发 keyDown + keyUp，不保留修饰键。普通文字优先 text。此处的键名与 MCP press 的 Playwright 组合键语法不同。

输入使用 CDP `Input.dispatchMouseEvent`、`Input.insertText`、`Input.dispatchKeyEvent`。网页内容中的登录、表单、滑块可以操作；系统文件选择器、Chrome 原生权限/凭据窗口、系统钥匙串、WebAuthn 等不在网页画面内，未实现远程操作。不会绕过验证码或替用户确认付款。

JavaScript alert/confirm/prompt/beforeunload 不会自动接受或取消，会暂停给用户确认。状态额外带 `dialog`（通常为 null）；App 根据字段显示原生确认框，而非尝试点击 JPEG 中不存在的浏览器对话框。对话框处理前交还返回 409：

```json
{"dialog":{"type":"confirm","message":"请确认操作","defaultValue":""}}
{"type":"dialog","accept":false}
{"type":"dialog","accept":true,"promptText":"用户输入的提示框答案"}
```

dialog 输入仍需接管；使用 CDP `Page.handleJavaScriptDialog`，用户处理后再交还。

协议依据：[CDP Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/)、[CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)。

## 安装与本地验收

在目标机由 lead 手动运行安装脚本。`browser-setup.sh` 安装 Xvfb、Chrome（x86_64 使用 Google 官方签名 RPM 仓库；其他架构尝试现有仓库 Chromium）、GTK/NSS/ALSA/GBM/X11 运行库、fontconfig、Liberation 与一种可用的中文字体。中文字体按 Noto CJK / 文泉驿顺序查找。包安装脚本不安装完整桌面、不启动服务、不改防火墙或关闭沙箱。

脚本可重复运行；已有浏览器直接复用。估算安装后 0.8–1.5 GiB，建议安装前至少 2 GiB 空闲；dnf 缓存、profile、下载另计。中文字体或非 x86 浏览器仓库不可用时明确失败，不自动换非官方源或关闭签名验证。Google Linux 安装形式见 [官方安装说明](https://support.google.com/chrome/a/answer/9025926?hl=en)。当前未在 Alibaba Cloud Linux 3 运行脚本；其仓库可用性、运行库依赖和沙箱必须在目标机实测。

```sh
cd /opt/personal-agent
sudo bash cloud/deploy/browser-setup.sh
sudo bash cloud/deploy/install.sh
# 已有本体与依赖，只更新浏览器系统 unit 时：
sudo bash cloud/deploy/browser-service-install.sh
```

两个 service 安装脚本均要求 root、可重复执行。安装后浏览器 host 已 enable 并启动，Chrome 仍懒启动；本体只 enable，不自动启动或重启。已运行 host 不会因重复安装而加载新代码，lead 准备好后手动执行：

```sh
sudo systemd-analyze verify /etc/systemd/system/personal-agent.service /etc/systemd/system/personal-agent-browser.service
sudo systemctl restart personal-agent-browser.service
sudo systemctl restart personal-agent.service
systemctl is-enabled personal-agent-browser.service
systemctl is-active personal-agent.service personal-agent-browser.service
systemctl show personal-agent.service personal-agent-browser.service -p MainPID -p ControlGroup -p MemoryLimit -p MemoryMax
task_memory_mount="$(findmnt -rn -t cgroup -o TARGET,OPTIONS | awk '$2 ~ /(^|,)memory(,|$)/ {print $1; exit}')"
test -n "$task_memory_mount"
task_browser_group="$(systemctl show personal-agent-browser.service -p ControlGroup --value)"
cat "${task_memory_mount}${task_browser_group}/memory.limit_in_bytes"
cat "${task_memory_mount}${task_browser_group}/memory.usage_in_bytes"
cat "${task_memory_mount}${task_browser_group}/memory.max_usage_in_bytes"
```

浏览器 limit 预期为 838860800 字节，本体为 943718400。进程归属、swap、PSS、故障恢复和 10 分钟回收的完整验收命令见 [browser-memory.md](browser-memory.md)。本轮没有连接服务器运行这些命令；App HTTP/WS 和卡片格式保持原样。

本机可运行：

```sh
node --test cloud/test/browser*.test.mjs
node cloud/src/browser/demo.mjs
node cloud/scripts/verify-v08-browser.mjs
```

demo 只用本机 Chrome 和本地 HTTP 表单；独立 profile 和所有产物放在 `/tmp/v08-browser-demo/`。空闲阈值缩短为 3.5 秒，验证 MCP initialize/list/call、ref 填表/下拉/点击、WS JPEG、半尺寸坐标点击、接管文字/按键、Agent 被挡、交还继续读取、观看中自动关闭、重启后的 localStorage/持久 Cookie。不会使用个人 Chrome profile 或外部登录账号。

产物：`output.log`、`snapshot.txt`、`after-return.txt`、`frame-1.jpg` 至 `frame-3.jpg`、`after-return.jpg`、`frames.json`、`states.json`、`memory.json`。独立测试输出另存 `tests.log`。RSS 从 `ps` 读取自己的 Chrome 主进程及递归子进程/进程组，保留已见 PID/进程组，关闭后再次查询确认没有残留，按阶段记录，单位 MiB；不包括 Node 和 Linux Xvfb，共享页可能重复计算。

2026-10-15 本机验收：macOS arm64、Node v26.5.0、Google Chrome 155.0.8059.41。独立测试 19/19，通过完整 demo；收到 19 帧，帧尺寸 1280×800，最短帧间隔 200ms，四种状态均收到；用户取消 JavaScript 确认框、重启保留持久 Cookie/localStorage 均通过。

| 阶段 | Chrome 合计 RSS（MiB） | 进程数 |
| --- | ---: | ---: |
| 打开本地页 | 769.8 | 6 |
| MCP 提交表单 | 831.5 | 6 |
| 实时画面 | 882.5 | 6 |
| 用户接管 | 895.9 | 6 |
| 交还 | 897.2 | 6 |
| 空闲关闭 | 0 | 0 |
| 重启 | 812.5 | 6 |
| 最终关闭 | 0 | 0 |

这是 browser worker 早期本机 demo 的阶段采样，非连续峰值。macOS RSS 有共享页重复计数，不能用它替代 Linux PSS/cgroup 计费。当前部署已改为本体 900M 与浏览器 800M 的独立系统服务，容量依据及新的本机验证见 [browser-memory.md](browser-memory.md)。Linux 安装/Xvfb 实机、云端沙箱、App UI、真实网站登录/验证码/付款及长期负载均未在本任务验收。
