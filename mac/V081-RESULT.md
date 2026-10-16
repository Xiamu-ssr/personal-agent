# 豆豆 Mac 0.8.1 验收结果

新增自定义模型服务的改动、最新测试数、产物和截图 24–28 见 [V081-PROVIDERS-RESULT.md](V081-PROVIDERS-RESULT.md)。下文保留此前 0.8.1 的验收记录。

仅修改 `mac/**`。没有 commit、push、tag 或发布；没有读取真实密钥、token 或已安装 App 的数据目录。

## 附件问题与修复

Mac 改前的基线没有复现安卓报告的明显畸形，不能把同一个根因当作已证实。真实 AppKit 布局测得：空输入区 68 pt、单图 122 pt、混合附件加长文字 194 pt。基线图为 `00-baseline-attachment.png`。

代码核查发现两处缺口：附件的横向 ScrollView 没有显式高度约束；原生 NSTextView 没有文件拖拽回调，不能依赖外层 SwiftUI onDrop 接住已由文本框处理的事件。菜单栏另有独立的纯文字输入框，粘贴附件会跳主窗口。

这轮改为共享附件条，滚动区固定 48 pt、附件片固定 44 pt、文件名限一行，每片可删除，多了横向滚动。输入框、加号和发送按钮独立布局，长文字仍最多五行。修后空输入区 68 pt、单图 124 pt、混合长文字 196 pt；附件本身只增加一行。图片消息按网格排列，文件另列。注册原生拖拽类型，把拖入文件和图片交给附件读取器；同时保留内容区 NSItemProvider 拖入路径。菜单栏复用同一 ComposerBar，不再跳主窗口。

实测分别覆盖单图、三图、PDF、混合、长文字、原生 NSTextView 拖拽目的方法、SwiftUI provider 拖入、上传发送和菜单栏附件发送。拖拽验收使用临时文件和 Finder 形态的 pasteboard，未操控用户 Finder。

## 每条改动

1. **彩色图标**：本机能力、其他设备能力、设置入口、云端连接器和聊天里的能力/连接卡共用 AppIcon。使用本地 SF Symbols 和纯色方块，白色图形；不再请求或下载连接器 logo。能力开启开关为绿色。现有 8 项 Mac 执行能力不变，没有新增剪贴板或提醒事项的执行权限。
2. **讨论引用**：讨论先返回主聊天，挂 emoji/标题/来源引用条并聚焦，可取消；按发送才 POST `/api/feed/feedback`，携带 `path/action/text/clientId`。允许空评论。用户消息解析 quote，引用卡与自己的文字同气泡展示；点卡返回已加载原帖，不在列表时进入帖子详情，GET `/api/feed/item`。当前 discuss 协议不接收附件，已有附件会保留并提示先移除。点子、目标和健康的直接发送行为保留。
3. **活动与轨迹（按最新更正）**：撤掉气泡右键的「查看过程」，只保留复制。控制台采用 Muse「今天」的列表结构：圆形图标、话题标题、灰色单行摘要、时间，按日期分组。列表直接使用云端结果，主聊天干过活的轮次照常显示，纯聊天由云端排除；Mac 不从聊天气泡拼列表，也不因 activity_step 新建活动。`phase:"updated"` 按 id 修改现有行，不重拉列表、不改顺序或时间；摘要未生成时预留一行，异步事件与 HTTP 请求交错时保留较新的更新。分页保持原顺序并去重。点活动进入完整轨迹，保留各步时间、可展开的工具摘要及附件/续聊输入框；详情标题也随摘要事件更新。旁聊标题更新支持事件只带 id/title/summary 的格式，主聊天活动仍不会串入旁聊列表。
4. **clientId**：主聊天、旁聊新建/续聊、活动续聊、讨论、菜单栏和语音转写发送均走同一提交身份逻辑。每次提交生成 UUID，内容不变的失败重试复用，改稿或确认成功后下一次提交用新 UUID；上传成功的附件也复用。发送等待 HTTP 确认，按钮和输入锁在确认前保持，避免连点。气泡按服务端 id 合并，不再以相同文字猜测是哪次发送。
5. **回复补漏**：重连 hello 合并历史，并拉 `/api/history?n=1000`；App 回前台、窗口重新可见及菜单栏打开也补取。按 id 合并，保留已用选项和快照之后的新消息。补取 busy 状态时检查版本，修复漏掉的 idle，也防止旧 HTTP 快照覆盖新 WS 状态。处理并发补取和重连取消。唤醒沿用 AppDelegate 的重连链路。
6. **版本**：Info.plist、默认构建版本和产物校验改为 0.8.1。

删除了菜单栏独立文字输入/粘贴跳转路径、讨论输入弹窗、连接器远程位图/SVG 加载器、主聊天不等确认的 WS 发送路径、按文字匹配本地回声的逻辑。按更正撤回了气泡过程面板及其导航状态；移除正文 delta 累积和 final-stream 状态，主聊天和旁聊仅显示 say，历史补取也不会把 fallback 正文变成气泡。没有增加旧接口或兼容分支。

收尾核对 `cloud/docs/v08-cloud.md` 最新 **0.8.1** 节：正文及 result.result 只进轨迹，聊天只有 say（系统错误另保留）；活动按云端是否干活的规则列出，标题≤14 字、摘要≤40 字，初始可为空；updated 不是新活动。历史接口仍为 `/api/history`；四个 POST 共用 clientId 空间，10 分钟内连同已形成的错误响应一起去重，服务重启清空。Mac 没有请求 `/api/chat`，不展示云端 Stop hook 的内部提醒，也不自行处理标题触发词。

## 测试和本机验收

- `bash mac/Tests/verify-v081.sh`：**66 条 0.8.1 断言、80 条原有断言、1 项原生附件布局检查、4 组地址/登录回归全部通过**，退出码 0。覆盖附件上传复用、引用和 discuss 请求、空引用消息、UUID 复用与改稿换号、发送锁、旁聊、补漏合并、图标，以及只显示 say、活动摘要解析、原地更新、HTTP/WS 竞态和分页。
- `VERSION=0.8.1 bash mac/build.sh`：通过，退出码 0。
- `python3 mac/tools/validate-artifact.py`：通过，版本 0.8.1、arm64 + x86_64、codesign deep/strict 验证、15 个头像资源齐全。
- `git diff --check -- mac`：通过。
- 本地服务使用真实 cloud HTTP/WS、Harness 和 Agent SDK，仅接脚本化 localhost 假模型。没有载入 cloud 主入口或 .env；所有模型配置、会话、文件和浏览器数据在临时目录。App 使用独立 `DOUDOU_DATA_DIR`，设备注册在显式 loopback 验收模式下关闭，未申请或点击系统权限。
- 按最新协议重新启动本地云端，`/api/state.version` 为 **0.8.1**，再次完整跑过 native review。动态讨论选择前后服务端消息数不变；发送后 user.text 仅为用户问题，quote 独立存在。验收结束时云端又调整了概括模型的输出额度与思考参数；对这次变化单独复跑真实概括函数到本地假模型 HTTP，解析与返回字段通过，记录在 `summary-final-check.json`。
- 真实 SDK Read 执行期间断开 App WS，云端随后生成 **2 条 say**。确认 App 当时没收到，再重连补齐且无重复；普通正文只出现在活动轨迹，不出现在聊天。另验证前台回调、生产唤醒通知观察者和菜单栏打开补漏。唤醒用 NSWorkspace 通知注入，未让电脑实际休眠。
- 控制台先载入摘要尚未生成的真实工作轮；再放行本地假模型的概括响应，由云端真实概括器保存并发 updated。验证同一行的 id、顺序、时间、尺寸不变，jobsVersion 不递增、不触发重拉。点击该行展开真实 Read 工具摘要，再从原生输入框续聊，服务端记录仍属于原活动。
- 真实本地服务端“确认丢失”测试：第一次 POST 已成功后故意丢弃确认并报网络错误，Composer 重试沿用 UUID；两次返回同一用户消息 id，服务端历史只有一条。
- 正式签名 App 也实际启动并截图，另用新临时数据目录，token 文件不存在。运行架构为本机 arm64；Intel 只编译和签名校验。

产物：`mac/build/doudou-0.8.1.dmg`。大小 10499264 字节，SHA-256：`9eb82e18b3a2322a09c81d7df3fa5d1972c276c09c03479fa5fe6eaa9d8cf149`。

复跑：`V081_MAC=1 V08_MAC_OUTPUT=/tmp/v081-mac-shots node mac/tools/v08-local-cloud.mjs`；另一个终端 `bash mac/tools/review-v081.sh`。录制流程用 `bash mac/tools/review-v081.sh --record-quote`，采集自身窗口的独立帧和实际时间戳。测试与构建日志：`/tmp/v081-mac-tests.log`、`/tmp/v081-mac-build.log`、`/tmp/v081-mac-review.log`、`/tmp/v081-mac-record.log`。原来的 0.8 UI 验收入口同步了 async send 与新引用行为；本轮以 V081Review 为完整 UI 验收入口。

## 截图与录屏

全部使用 `screencapture -l <自己的窗口号>`，没有抓整屏。目录 `/tmp/v081-mac-shots/`：

| 路径 | 说明 |
| --- | --- |
| `/tmp/v081-mac-shots/00-baseline-attachment.png` | 改前：聊天布局中混合附件和长文字的基线。 |
| `/tmp/v081-mac-shots/01-attachment-image.png` | 单张图片附件。 |
| `/tmp/v081-mac-shots/02-attachment-three-images.png` | 三张图片在同一横向附件条中。 |
| `/tmp/v081-mac-shots/03-attachment-pdf.png` | PDF 文件名、大小和删除按钮。 |
| `/tmp/v081-mac-shots/04-attachment-mixed.png` | 图片与 PDF 混合。 |
| `/tmp/v081-mac-shots/05-attachment-long-text.png` | 混合附件加长文字，编辑器最多五行。 |
| `/tmp/v081-mac-shots/06-attachment-drag.png` | 原生文本框接收文件拖入后显示附件条。 |
| `/tmp/v081-mac-shots/07-attachment-bubbles.png` | 发出后的图片和文件气泡。 |
| `/tmp/v081-mac-shots/08-settings-light.png` | 浅色设置页的彩色能力入口。 |
| `/tmp/v081-mac-shots/09-settings-dark.png` | 深色设置页，通知保留红色图标。 |
| `/tmp/v081-mac-shots/10-capabilities-light.png` | 浅色本机能力，文件黄、截图蓝灰、通知红、日历橙，已开开关为绿色。 |
| `/tmp/v081-mac-shots/11-capabilities-dark.png` | 深色本机能力。 |
| `/tmp/v081-mac-shots/12-connectors-light.png` | 浅色连接应用：QQ 蓝、Gmail 红、Tavily 紫、GitHub 黑。 |
| `/tmp/v081-mac-shots/13-connectors-dark.png` | 深色连接应用。 |
| `/tmp/v081-mac-shots/14-discussion-quote-strip.png` | 点讨论后跳到主聊天，仅挂引用条、聚焦输入框。 |
| `/tmp/v081-mac-shots/15-discussion-quote-bubble.png` | 输入问题后发送，用户气泡显示引用卡和自己的话。 |
| `/tmp/v081-mac-shots/16-quote-return-to-feed.png` | 点击引用卡返回原帖。 |
| `/tmp/v081-mac-shots/17-reconnect-catch-up.png` | 断线期间的两条 say 补回，没有正文兜底气泡。 |
| `/tmp/v081-mac-shots/18-console-activity-summary-light.png` | 浅色控制台：主聊天工作轮和旁聊，图标、标题、单行摘要、时间。 |
| `/tmp/v081-mac-shots/19-activity-detail-trajectory.png` | 点活动查看完整轨迹，展开真实 Read 工具摘要，底部可接着聊。 |
| `/tmp/v081-mac-shots/20-menu-attachments.png` | 真实菜单栏弹窗同时显示 PDF、图片附件条。 |
| `/tmp/v081-mac-shots/21-formal-app.png` | 最终签名的正式 App，用新临时目录启动。 |
| `/tmp/v081-mac-shots/22-discuss-send.mp4` | 21.5 秒，动态点讨论、挂引用、输入问题、发送到引用气泡；48 张带真实时间戳的自身窗口帧合成，按只有 say 的新协议重录。 |
| `/tmp/v081-mac-shots/23-console-activity-summary-dark.png` | 深色控制台，同一活动标题、摘要及时间布局。 |

旧的 `18-background-activities.png` 和 `19-view-process.png` 已由新要求的活动列表、详情截图替换。验收结构化记录：`/tmp/v081-mac-shots/acceptance.json`、`formal-startup.json`、`baseline-layout.json`、`fixed-layout.json`；产物记录 `mac/verification/v0.8.1/artifact.json`。

23 张 PNG、1 段录屏的大小及 SHA-256 见 `/tmp/v081-mac-shots/manifest.json`。本轮自启的 App、SDK 子进程及本地云端已关闭。

## 实际改动文件

- 输入/消息/引用：`Sources/Composer.swift`、`GrowingInput.swift`、`MenuView.swift`、`ChatClient.swift`、`ChatTranscript.swift`、`ChatView.swift`、新增 `ChatQuote.swift`。
- 导航/内容/活动：`Sources/App.swift`、`MainView.swift`、`Nav.swift`、`Pages.swift`、`ContentViews.swift`、`Activities.swift`、`Console.swift`、`SideChats.swift`。
- 图标：新增 `Sources/AppIcon.swift`，修改 `Connectors.swift`、`Settings.swift`、`Theme.swift`。
- 版本/校验：`Info.plist`、`build.sh`、`tools/compile-check.sh`、`tools/validate-artifact.py`、`tools/verify.sh`。
- 测试/验收：`Tests/V08Tests.swift`、`V08Review.swift`、`V08R2Review.swift`；新增 `V081Tests.swift`、`V081Review.swift`、`AttachmentLayoutReview.swift`、`ReviewDraggingInfo.swift`、`TestTransport.swift`、`verify-v081.sh`；修改 `tools/v08-local-cloud.mjs`，新增 `tools/review-v081.sh`。
- 本文 `V081-RESULT.md`。所有以上路径均相对 `mac/`。

## 未做与边界

- 未复现出 Mac 与安卓完全相同的附件畸形，不把布局加固当作根因实证。
- 未连接生产云端、真实模型或真实账号，未读取安装目录 token，未重新测试需要系统授权的电脑执行能力；保留原有执行实现。
- 未实际睡眠/唤醒电脑，验证的是生产通知处理链和真实断线补漏。
- 演示旁聊的 summary 为空；当前云端对旁聊保留原名、跳过异步概括。Mac 预留摘要行，字段或 updated 到达后会显示；主聊天工作轮的标题、摘要与异步更新已完整实测。
- clientId 与失败草稿在当前进程内保留；没有新增进程重启后的草稿恢复。云端去重重启清空及 10 分钟期限遵循最终协议。
- 历史补取受服务端单次最多 1000 条限制。引用原帖已删除时详情会显示云端错误。
- 未 commit、push、tag、发布；DMG 仅为本地集成验收产物。

与 Muse 的布局差异：Mac 控制台是居中的桌面面板，列表使用原生 Mac 字体和桌面行距；图标、标题、单行摘要、时间与「今天」分组沿用参考结构，没有照搬手机全屏布局。
