# Android 0.8.1 修复与本地验收

仅修改 `android/**`，没有 commit、push、tag 或发布，没有读取真实密钥。debug 包为 `com.xiamu.agent.checks`，版本为 **0.8.1 / 13**。

## 收尾协议

开工时云端文档还没有 0.8.1 节；收尾按照更新后的 `cloud/docs/v08-cloud.md` 和 `spec/spec.yaml` 对齐。最终约定替换了最初任务里的两点：

- 模型正文只进过程，不再产生 fallback 或正文 delta；用户可见回复由 say 发出。Stop hook 属于云端，App 不显示内部提示。
- 活动包含使用过非 say 工具的主轮、目标跟进、旁聊及其他可见后台工作；纯聊天、没发帖的动态不列。每项增加标题和一句 summary，updated 按 id 更新，排序保持原 started/ts。

客户端已删除正文 delta 临时气泡，并增加活动摘要。旧约定下的活动与 fallback 截图在 `/tmp/v081-android-shots/earlier-protocol/`；已撤销的长按过程截图在 `superseded-process-ui/`，均不属于最终截图清单。收尾文档快照是 `accepted-cloud-protocol.md`，哈希见 `activity-acceptance.json`。

自定义模型服务补充以 `.codex-handoff/v081-providers.md` 为准，并已在收尾时阅读云端文档新增的完整「自定义模型服务」节。先使用独立脚本化协议服务验收，再使用真实本地云端 HTTP/WS/Providers/Harness 补测；只将 `https://example.test` 的 Messages 传输接到回环假上游，未调用外部模型。最终约定匹配：对象选项、服务 CRUD/test、Key 尾四位与空白编辑、settings 全量事件、校验及错误返回。快照为 `providers-contract.md`、`providers-cloud-protocol.md`，证据为 `provider-backend-proof.json`。

## 附件问题根因

`MessageComposer` 原先把提示、`PickedRow`、`InputPill` 作为同级节点直接输出，而主聊天和旁聊的调用位置是 `Box`。这些节点在相同位置布局，缩略图、文件名和删除按钮被输入框盖住。01–05 使用工作区现有的 **0.8.0 debug 包 / versionCode 12**，通过真实系统选择器复现；没有下载线上 release 包。

现在组件内部用 Column 排列提示、引用、附件条和输入框。附件固定缩略尺寸，文件名省略，独立删除，多选横向滚动；附件数量不影响输入框结构。文字最多四行并限制最大高度。失败保留选择和已上传结果，成功只清除本次发送的附件。用户气泡中的图片使用两列网格，文件卡片留出间距。

另外修复透明 PNG 压成 JPEG 时默认变黑底的问题，压缩前明确铺白底。

## 每条改动

1. **附件**：修复叠放、逐个删除和横滑；实测单图、三图、PDF、混合与长文字，检查发送后的图片和文件排版。
2. **彩色能力**：本机能力使用固定彩色圆角方块和白色图形，开启态绿色；云端服务用品牌色、首字或通用图形。设置、连接列表、详情和聊天卡片共用组件。没有下载品牌 logo，本机授权和设备能力逻辑保持原样。
3. **动态引用**：点击讨论只挂上可取消的引用条并聚焦输入，发送才提交 `/api/feed/feedback`，携带 path/action/text/clientId，允许空文字。解析历史和 WS 的 quote，在用户文字上方显示引用卡；点击定位原帖或打开单帖详情。修复首次占位误触发分页、引用定位被取消的问题。定位时暂停翻页，真正看见最后一帖才继续加载。点子、目标和健康入口沿用原直接发送行为。
4. **活动和轨迹**：只使用云端活动列表，不自行拼轮次，包含干过活的主聊天轮次。对照 Muse 的 f03 原帧，活动行采用小圆图标、标题、灰色单行摘要和下方时间。收到 `phase:"updated"` 按 id 原地补标题和摘要，不新增记录、不修改状态和时间、不触发列表重载；重连时重新取云端列表。点活动进入原详情页查看轨迹、接着聊。气泡长按只保留复制，撤掉「查看过程」入口及专用底部面板。
5. **只发一次**：主聊天改用 HTTP 确认；主聊、旁聊创建、旁聊续聊和讨论均生成 UUID。网络重试复用原值，发送未确认时按钮不能再次提交。自动传输重试一次，手动重试继续复用；修改内容或成功后下一条消息用新 UUID。明确的 HTTP 拒绝允许重新提交，避免被缓存的错误锁住。
6. **回复补漏**：hello.history 与 `/api/history` 按消息 id 合并，保留请求期间新到的 WS 消息和已消费选项。不按文字去重，也不因期间收到新事件就跳过整批历史。回前台自动重连并补回。
7. **版本**：0.8.0 / 12 → 0.8.1 / 13。
8. **自定义模型服务**：模型页按 ZenMux 与自定义服务分组，使用 `{provider,id}` 全局单选、即时保存；添加及编辑包含名称、Base URL、密码 Key 显隐、只读 Anthropic 和 1–20 行模型。测试中锁定提交并显示进度，失败保留表单和服务错误；编辑 Key 只显示尾四位，留空不发 apiKey。删除由云端判断，当前服务的拒绝提示原样显示。`settings` 事件自动重读，设置页和控制台也同步更新。Key 不写偏好或日志，草稿诊断和服务错误回显会打码。版本保持 0.8.1 / 13。

## 删除的旧逻辑

- 主聊天通过 WS 写出即视为成功的发送。
- 本地无 id 的乐观发送气泡，以及按文字匹配回声。
- 动态讨论点击后立即提交。
- 连接器图标下载、灰度滤镜、系统 App 图标解析。
- 最终协议已删除的正文 delta 累积和临时气泡。
- 已作废的长按「查看过程」菜单、导航状态和专用 ProcessSheet。
- 旧模型字符串与平铺 models 列表；只解析新的 providers 和 `{provider,id}`，不保留兼容分支。

## 测试结果

Java 17、现有 Android SDK，在 `android/` 执行：

```sh
./gradlew :app:testDebugUnitTest :app:assembleDebug --offline
```

**160 项通过，0 失败、0 错误，debug 构建成功。** 基础修复新增 34 项：`V081MessageTest` 30 项，`MessageRetryTest` 4 项，覆盖附件选择、引用与 discuss 请求、quote 和活动摘要解析、UUID 重试、按 id 补漏合并。活动更新回归覆盖同 id 保持排序、未知 id 不造记录、保留运行状态/时间/输出、部分字段更新和旧 HTTP 快照覆盖。四个 POST 接口分别用 MockWebServer 模拟服务已收件、回包断开。旧 delta 用例改成 say/turn_end 验证。

自定义服务另新增 **29 项**：`ProviderSettingsTest` 21 项、`ProviderApiTest` 8 项，覆盖 providers/新 model 解析、跨服务相同模型 ID、表单边界与 Unicode、URL、重复 ID、空 Key 编辑、POST/PATCH/DELETE/测试与设置请求、Key 不进入诊断或异常堆栈。脚本语法与 `git diff --check -- android` 通过。

## 模拟器结果

使用真实 cloud HTTP/WS/Harness/content，注入 `cloud/test/query-fixture.mjs` 和脚本化 summarize 回调。聊天、活动摘要均没有调用真实模型；启动使用独立临时数据根，并清除凭据环境变量。App 地址为 `http://10.0.2.2:18768`，所有资料均为演示数据。

- 附件使用真实 Android 图片和文档选择器，完成删除、上传、发送与六张附件横滑。
- 设置、本机/云端分段、首次聊天连接卡均核对浅色和深色，另补拍健康等底部能力图标。
- 讨论挂起及取消均没有发送请求，有字和空评论都能发送。丢掉首次回包后，两次请求 UUID 相同，只有一条对应用户消息。
- 主聊天丢弃两次回包，自动加手动重试共三次请求，UUID 相同，只存一条用户消息；连点第二次没有提交。
- 旁聊创建和续聊各丢弃一次回包，各两次请求 UUID 相同，仅创建一个旁聊、仅存一条对应续聊消息。
- 主动断开 WS 并阻止重连六秒，期间生成回复，自动重连后补回一次。Home 回后台期间生成另一条回复，回前台后补回一次，均未手动刷新。
- 最终协议下，纯聊天不列活动，Read 工作轮和独立后台检查列出。保持控制台打开，实测「处理中」变成话题和摘要，期间列表 GET 为零，标题纵向位置及 id/ts 排序不变。点进详情展开 Read 轨迹并续聊，保持原活动 id；丢首次回包，两次请求同一 UUID，只保存一条交代。气泡长按菜单只有复制。
- 最终 say 正常显示，模型原始正文不进入聊天，在过程接口中保留。这不代表真实 SDK Stop hook 续跑验收。
- 自定义服务在脚本化假云端与真实本地云端各跑一遍：单选保存和外部 WS 同步、模型行增删、密码显隐、测试进度、失败不落库、空 Key 编辑、当前服务删除拒绝及切回内置后删除成功。App 日志不含测试 Key。真实 Providers 向假上游发起 5 次微型测试，均为首个模型、max_tokens 8，另直接验证了 `/api/providers/test`。

UI 驱动曾遇到 UiAutomator 空根节点、键盘收起底栏、Quick Boot 安装状态问题，已补页面等待、键盘处理和每次安装。本次活动断言最初将标题文字中心的横坐标当成位置；文字变长会改变该坐标，已改为纵向位置及 id/ts 顺序验证，重新实测通过。最终阶段全部通过，AndroidRuntime 错误日志为空。失败时也执行模拟器关闭。

## 截图与录屏

根目录：`/tmp/v081-android-shots/`。下列为实际模拟器截图或 adb screenrecord，未编辑画面。

| 路径 | 说明 |
| --- | --- |
| [01-before-one-image.png](/tmp/v081-android-shots/01-before-one-image.png) | 修复前，一张图片被输入框遮住。 |
| [02-before-three-images.png](/tmp/v081-android-shots/02-before-three-images.png) | 修复前，三张图片重叠。 |
| [03-before-pdf.png](/tmp/v081-android-shots/03-before-pdf.png) | 修复前，PDF 附件被遮住。 |
| [04-before-mixed.png](/tmp/v081-android-shots/04-before-mixed.png) | 修复前，图片与文件混合。 |
| [05-before-long-text.png](/tmp/v081-android-shots/05-before-long-text.png) | 修复前，混合附件加长文字。 |
| [06-onboarding-light.png](/tmp/v081-android-shots/06-onboarding-light.png) | 首次聊天连接卡，浅色。 |
| [07-onboarding-dark.png](/tmp/v081-android-shots/07-onboarding-dark.png) | 首次聊天连接卡，深色。 |
| [08-after-one-image.png](/tmp/v081-android-shots/08-after-one-image.png) | 修复后，一张图片。 |
| [09-after-three-images.png](/tmp/v081-android-shots/09-after-three-images.png) | 修复后，三张图片和删除按钮。 |
| [10-after-pdf.png](/tmp/v081-android-shots/10-after-pdf.png) | 修复后，PDF 图标和文件名。 |
| [11-after-mixed.png](/tmp/v081-android-shots/11-after-mixed.png) | 修复后，图片与 PDF 混合。 |
| [12-after-long-text.png](/tmp/v081-android-shots/12-after-long-text.png) | 长文字输入保持有界高度和圆角。 |
| [13-sent-mixed-attachments.png](/tmp/v081-android-shots/13-sent-mixed-attachments.png) | 发送后的图片、PDF 和文字气泡。 |
| [14-sent-three-images.png](/tmp/v081-android-shots/14-sent-three-images.png) | 发送后的三图网格。 |
| [15-settings-light.png](/tmp/v081-android-shots/15-settings-light.png) | 彩色设置页，浅色。 |
| [16-settings-dark.png](/tmp/v081-android-shots/16-settings-dark.png) | 彩色设置页，深色。 |
| [17-local-capabilities-light.png](/tmp/v081-android-shots/17-local-capabilities-light.png) | 本机能力和绿色开启态，浅色。 |
| [18-local-capabilities-dark.png](/tmp/v081-android-shots/18-local-capabilities-dark.png) | 本机能力，深色。 |
| [19-cloud-connectors-light.png](/tmp/v081-android-shots/19-cloud-connectors-light.png) | 品牌色云端连接器，浅色。 |
| [20-cloud-connectors-dark.png](/tmp/v081-android-shots/20-cloud-connectors-dark.png) | 品牌色云端连接器，深色。 |
| [21-discussion-quote-composer.png](/tmp/v081-android-shots/21-discussion-quote-composer.png) | 点讨论后仅挂引用并聚焦键盘。 |
| [22-discussion-sent-quote.png](/tmp/v081-android-shots/22-discussion-sent-quote.png) | 输入文字并发送后的引用卡。 |
| [23-console-activities-summary.png](/tmp/v081-android-shots/23-console-activities-summary.png) | 最终协议的工作主轮和后台活动，含标题与摘要。 |
| [24-assistant-copy-menu.png](/tmp/v081-android-shots/24-assistant-copy-menu.png) | 气泡长按菜单，只保留复制。 |
| [25-activity-detail-trajectory.png](/tmp/v081-android-shots/25-activity-detail-trajectory.png) | 从活动列表进入详情，展开 Read 工具轨迹。 |
| [26-send-pending-disabled.png](/tmp/v081-android-shots/26-send-pending-disabled.png) | 发送等待确认，按钮变灰。 |
| [27-retry-preserved-draft.png](/tmp/v081-android-shots/27-retry-preserved-draft.png) | 回包丢失后草稿保留。 |
| [28-websocket-reconnect-catchup.png](/tmp/v081-android-shots/28-websocket-reconnect-catchup.png) | WS 断线回复自动补回一次。 |
| [29-foreground-catchup.png](/tmp/v081-android-shots/29-foreground-catchup.png) | 回前台自动补回一次。 |
| [30-final-say-bubble.png](/tmp/v081-android-shots/30-final-say-bubble.png) | 最终协议，say 显示答复，正文只进过程。 |
| [31-side-chat-create-once.png](/tmp/v081-android-shots/31-side-chat-create-once.png) | 丢首次回包仍只创建一个旁聊。 |
| [32-side-chat-continue-once.png](/tmp/v081-android-shots/32-side-chat-continue-once.png) | 旁聊续聊重试只存一条用户消息。 |
| [33-quote-return-to-feed.png](/tmp/v081-android-shots/33-quote-return-to-feed.png) | 引用卡返回动态原帖。 |
| [34-quote-older-post-detail.png](/tmp/v081-android-shots/34-quote-older-post-detail.png) | 列表外旧帖打开详情。 |
| [35-attachments-horizontal-scroll.png](/tmp/v081-android-shots/35-attachments-horizontal-scroll.png) | 六张附件横滑。 |
| [36-quote-return-to-earlier-feed.png](/tmp/v081-android-shots/36-quote-return-to-earlier-feed.png) | 定位到列表中较早的帖子。 |
| [37-local-health-light.png](/tmp/v081-android-shots/37-local-health-light.png) | 剪贴板和健康图标，浅色。 |
| [38-local-health-dark.png](/tmp/v081-android-shots/38-local-health-dark.png) | 剪贴板和健康图标，深色。 |
| [39-console-awaiting-title.png](/tmp/v081-android-shots/39-console-awaiting-title.png) | 完成后等待异步话题与摘要，行位置保持。 |
| [40-activity-continued.png](/tmp/v081-android-shots/40-activity-continued.png) | 活动详情续聊，保持原 activityId。 |
| [41-provider-models-light.png](/tmp/v081-android-shots/41-provider-models-light.png) | 含自定义服务的模型分组列表，浅色。 |
| [42-provider-models-dark.png](/tmp/v081-android-shots/42-provider-models-dark.png) | 同一模型分组列表，深色。 |
| [43-provider-add-form.png](/tmp/v081-android-shots/43-provider-add-form.png) | 添加服务，固定 Anthropic、假 Key 和演示 URL。 |
| [44-provider-test-error.png](/tmp/v081-android-shots/44-provider-test-error.png) | 服务测试失败后保留表单并显示返回的错误。 |
| [45-provider-edit-masked.png](/tmp/v081-android-shots/45-provider-edit-masked.png) | 编辑页，当前 Key 仅显示 ••••abcd，输入框留空。 |
| [01-discussion-to-send.mp4](/tmp/v081-android-shots/01-discussion-to-send.mp4) | 约 33 秒，挂引用、取消、重新引用、输入和发送。 |

共 **45 张 PNG、1 段 32.59 秒 MP4**。证据还包括 `backend-proof.json`、`activity-acceptance.json`、`ui-proof-*.json`、`unit-test-results.json`、`artifact-manifest.json`、`cleanup-proof.json`、`gradle.log` 和 `ui-review-*.log`。活动更正替换列表与菜单截图，补充详情轨迹、等待标题和续聊截图。首次聊天、讨论、重试、补漏与旁聊已按 say 协议实测；附件、颜色与分页沿用本轮未改组件的验收证据。

41–45 最终截图来自真实本地云端补测；独立假云端的相同截图存于 `providers-fixture/shots/`。模型服务证据另有 `provider-ui-proof-fixture.json`、`provider-ui-proof-real.json`、`provider-backend-proof.json`、`providers-gradle.log` 与 `provider-app-*.log`。

## 复跑

设置 Java 17 与 Android SDK 并构建 debug 包。在仓库根启动：

```sh
V08_DEMO_OUTPUT=/tmp/v081-android-shots/final-host node android/tools/v08-demo.mjs
```

仅在验收时启动 pa35，关闭 snapshot load/save，使用 headless 和 swiftshader_indirect。模拟器需已有本地演示登录，或用 `10.0.2.2:18768` 和演示配对码 `123456` 登录。将 `/tmp/v081-android-fixtures/` 的三张演示图及 PDF 放进 Download，扫描图片后运行：

```sh
V08_REVIEW_SHOTS=/tmp/v081-android-shots python3 android/tools/v081-review.py
```

默认跑全部阶段，可用 V081_PHASE 指定逗号分隔的阶段。驱动仅使用 emulator-5554，每次安装当前 debug 包，并在 finally 执行 adb emu kill。宿主通过 SIGTERM 关闭。

自定义服务可单独启动 `node android/tools/v081-providers-demo.mjs`，再运行 `python3 android/tools/v081-providers-review.py`；真实本地云端补测改用 `node android/tools/v081-providers-local.mjs` 和 `V081_PROVIDER_MODE=real`。两种宿主分别启动，均只使用隔离演示数据和假 Key；UI 驱动 finally 会关闭模拟器。

## 未做到与边界

本轮 App 功能和列出的模拟器流程已完成。没有做真机、真实连接器账号、真实模型或线上服务验收，没有发布。真实 SDK Stop 续跑属于云端实现，脚本化模型不能证明它。讨论接口只有文字，原有附件草稿会保留，在发送或取消引用后恢复。

模拟器已关闭，无 qemu/emulator 残留。本次假云端及三个本机端口也已关闭。

## 实际改动文件

35 files:

- [android/REVIEW-v0.8.1.md](../android/REVIEW-v0.8.1.md)
- [android/app/build.gradle.kts](../android/app/build.gradle.kts)
- [android/app/src/main/java/com/xiamu/agent/Activities.kt](../android/app/src/main/java/com/xiamu/agent/Activities.kt)
- [android/app/src/main/java/com/xiamu/agent/AgentSettings.kt](../android/app/src/main/java/com/xiamu/agent/AgentSettings.kt)
- [android/app/src/main/java/com/xiamu/agent/Api.kt](../android/app/src/main/java/com/xiamu/agent/Api.kt)
- [android/app/src/main/java/com/xiamu/agent/Chat.kt](../android/app/src/main/java/com/xiamu/agent/Chat.kt)
- [android/app/src/main/java/com/xiamu/agent/ChatState.kt](../android/app/src/main/java/com/xiamu/agent/ChatState.kt)
- [android/app/src/main/java/com/xiamu/agent/MessageDelivery.kt](../android/app/src/main/java/com/xiamu/agent/MessageDelivery.kt)
- [android/app/src/main/java/com/xiamu/agent/ProviderDraft.kt](../android/app/src/main/java/com/xiamu/agent/ProviderDraft.kt)
- [android/app/src/main/java/com/xiamu/agent/SideChatModels.kt](../android/app/src/main/java/com/xiamu/agent/SideChatModels.kt)
- [android/app/src/main/java/com/xiamu/agent/media/Media.kt](../android/app/src/main/java/com/xiamu/agent/media/Media.kt)
- [android/app/src/main/java/com/xiamu/agent/ui/Account.kt](../android/app/src/main/java/com/xiamu/agent/ui/Account.kt)
- [android/app/src/main/java/com/xiamu/agent/ui/AppIcons.kt](../android/app/src/main/java/com/xiamu/agent/ui/AppIcons.kt)
- [android/app/src/main/java/com/xiamu/agent/ui/ChatScreen.kt](../android/app/src/main/java/com/xiamu/agent/ui/ChatScreen.kt)
- [android/app/src/main/java/com/xiamu/agent/ui/Composer.kt](../android/app/src/main/java/com/xiamu/agent/ui/Composer.kt)
- [android/app/src/main/java/com/xiamu/agent/ui/Connections.kt](../android/app/src/main/java/com/xiamu/agent/ui/Connections.kt)
- [android/app/src/main/java/com/xiamu/agent/ui/Console.kt](../android/app/src/main/java/com/xiamu/agent/ui/Console.kt)
- [android/app/src/main/java/com/xiamu/agent/ui/Feed.kt](../android/app/src/main/java/com/xiamu/agent/ui/Feed.kt)
- [android/app/src/main/java/com/xiamu/agent/ui/FeedQuote.kt](../android/app/src/main/java/com/xiamu/agent/ui/FeedQuote.kt)
- [android/app/src/main/java/com/xiamu/agent/ui/Pages.kt](../android/app/src/main/java/com/xiamu/agent/ui/Pages.kt)
- [android/app/src/main/java/com/xiamu/agent/ui/ProviderForm.kt](../android/app/src/main/java/com/xiamu/agent/ui/ProviderForm.kt)
- [android/app/src/main/java/com/xiamu/agent/ui/RuntimeSettings.kt](../android/app/src/main/java/com/xiamu/agent/ui/RuntimeSettings.kt)
- [android/app/src/main/java/com/xiamu/agent/ui/SideChat.kt](../android/app/src/main/java/com/xiamu/agent/ui/SideChat.kt)
- [android/app/src/main/java/com/xiamu/agent/ui/Style.kt](../android/app/src/main/java/com/xiamu/agent/ui/Style.kt)
- [android/app/src/test/java/com/xiamu/agent/MessageRetryTest.kt](../android/app/src/test/java/com/xiamu/agent/MessageRetryTest.kt)
- [android/app/src/test/java/com/xiamu/agent/ProviderApiTest.kt](../android/app/src/test/java/com/xiamu/agent/ProviderApiTest.kt)
- [android/app/src/test/java/com/xiamu/agent/ProviderSettingsTest.kt](../android/app/src/test/java/com/xiamu/agent/ProviderSettingsTest.kt)
- [android/app/src/test/java/com/xiamu/agent/ReplyMediaTest.kt](../android/app/src/test/java/com/xiamu/agent/ReplyMediaTest.kt)
- [android/app/src/test/java/com/xiamu/agent/V081MessageTest.kt](../android/app/src/test/java/com/xiamu/agent/V081MessageTest.kt)
- [android/app/src/test/java/com/xiamu/agent/V08ProtocolTest.kt](../android/app/src/test/java/com/xiamu/agent/V08ProtocolTest.kt)
- [android/tools/v08-demo.mjs](../android/tools/v08-demo.mjs)
- [android/tools/v081-providers-demo.mjs](../android/tools/v081-providers-demo.mjs)
- [android/tools/v081-providers-local.mjs](../android/tools/v081-providers-local.mjs)
- [android/tools/v081-providers-review.py](../android/tools/v081-providers-review.py)
- [android/tools/v081-review.py](../android/tools/v081-review.py)
