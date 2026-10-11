# Mac 本机能力 0.4.0 集成交接

2026-10-11，本次实现与验证均在本机完成，供 Claude 集成 review。

## 实现和协议

- 能力列表为 shell、三个 folder_* 授权开关、computer_use、browser、notify、calendar_events。旧能力和 Prefs.folder 已删除，启动迁移只清理旧设置，不保留兼容接口。
- Capability 保留 name/title/description/args/hint/permit/run/enabled/json。run 为可选闭包，文件夹三项为 nil。appIcon 通过 NSWorkspace 读取终端、相应用户文件夹、系统设置、Safari、通知中心、日历的真实图标。
- enableAll 在主 actor 上依次申请通知、日历、桌面、文稿、下载、屏幕录制、辅助功能。屏幕录制和辅助功能分别打开系统设置、登记 TCC 请求、轮询最多 120 秒；computer_use 只有两项都通过才开启。shell/browser 无额外授权，在最后开启。progress(name, reason) 报告每项最终结果；界面负责 reregister。
- shell 用 posix_spawn 创建独立进程组，执行 /bin/zsh -lc。cwd 默认主目录，timeout 默认 30、最大 300 秒；SIGKILL 终止整个组，超时 exit=124。并行排空 stdout/stderr，保留最多 20000 字（两者合计），含截断说明。非零退出仍返回 stdout/stderr/exit。
- computer_use 用 ScreenCaptureKit 的 SCScreenshotManager 截图并编码 JPEG，长边不超过 1440。最近截图记录 display、图片尺寸和 CGDisplayBounds；位置参数从截图左上角的像素坐标换算到屏幕逻辑坐标，支持 Retina 和负坐标副屏。显示器布局变化或没有截图时拒绝位置操作。CGEvent 执行点击、拖动、滚动和键盘。PointerMotion.path 是带 seed 的纯函数，生成随机控制点的三次 Bézier、轻微抖动、变速和目标附近的落点；文字逐字输入，随机间隔。
- 豆豆浏览器是 App 内独立 NSWindow + WKWebView，多标签、地址栏、前进/返回、刷新和关闭标签均可由用户操作。采用固定 UUID 的 WKWebsiteDataStore，跨启动共享同一持久 profile，与其他浏览器隔离。UA 取当前系统 WebKit 的 UA，再补安装的 Safari 版本。此方案遵循 [WebKit 的 profile API](https://webkit.org/blog/14423/building-profiles-with-new-webkit-api/)。
- browser 的 args.op 为 tabs/open/snapshot/click/type/scroll/screenshot/back/close。open 不传 tab 则新建，传 tab 则复用；其他操作必须提供 tab。click/type 使用 snapshot 的 ref。type 追加文字，submit=true 发原生回车。
- snapshot JS 在 WKContentWorld.defaultClient 中运行，保存 ref 映射和 MutationObserver，不把 ref 写进 DOM。输出角色、名字、状态、层级及可交互 ref；过滤隐藏和装饰节点，12000 字以内并注明截断。click/type 只用 JS 做定位和滚动可见，鼠标/键盘由 NSEvent 投递给 WebKit responder；滚动也是原生事件。等待导航结束或 DOM 静止 500ms，最多 10 秒，并返回新 snapshot/stable。JS 调用另有超时保护。截图用 takeSnapshot，回传 JPEG。
- notify 与 calendar_events 保留原生实现。

### 文件夹与云端

现有云端把每个已注册且 enabled 的 capability 转成工具，没有“只展示、不生成工具”的协议字段。因此 DeviceClient.register 仅发送 Capabilities.tools 的五项（shell/computer_use/browser/notify/calendar_events），保留各项 enabled。三个文件夹留在 Capabilities.all 供本机界面显示和授权，完全不放进设备注册；其他设备页不会显示这三个开关。DeviceClient 也拒绝调用没有 run 的能力。不新增云端字段或兼容分支。

### 图片

DeviceResult.success 直接生成 {t:"result", id, ok:true, data:run返回值}。{image:base64,mime:"image/jpeg",width,height,...} 和图片数组均原样保留在 data，与 cloud/docs/app-protocol-tasks.md 的 image/mime 约定一致。

## 改动文件

修改：

- mac/Sources/Capabilities.swift
- mac/Sources/DeviceClient.swift
- mac/Sources/Prefs.swift
- mac/Info.plist：0.4.0，补桌面/文稿/下载/屏幕录制用途说明。
- mac/build.sh：包含 Device/ 源码，默认要求 Doudou Local Signing 身份，无 ad-hoc 回退。

新增：

- mac/Sources/Device/ShellTool.swift
- mac/Sources/Device/PointerMotion.swift
- mac/Sources/Device/ComputerTool.swift
- mac/Sources/Device/DeviceImage.swift
- mac/Sources/Device/DevicePermissions.swift
- mac/Sources/Device/DeviceResult.swift
- mac/Sources/Device/BrowserScripts.swift
- mac/Sources/Device/DoudouBrowser.swift
- mac/tools/caps-fixture.swift
- mac/tools/caps-test.swift
- mac/tools/caps-test.sh
- mac/tools/caps-signing-check.sh
- mac/tools/make-signing-identity.sh
- mac/tools/caps-README.md

## 实际验证

环境：macOS 15.6.1、Swift 6.1.2，源码以 Swift 5 模式、macOS 14 最低版本编译。

在 Claude-you 根目录运行：

~~~sh
bash personal-agent/mac/tools/caps-test.sh
bash personal-agent/mac/tools/caps-test.sh --typecheck
bash personal-agent/mac/tools/caps-signing-check.sh
~~~

- caps-test 共 56 个断言通过：主流程 48，持久 profile 写入 4、另一进程读取 3、清理 1。覆盖 shell 超时/整组终止/父进程先退出/截断/Unicode/退出码/cwd；坐标换算、截图尺寸和轨迹；图片序列化；注册过滤；本地 WKWebView 的层级/ref/状态/过滤/截断、native click/type 的 isTrusted、中文和 emoji、可信回车提交、DOM 稳定等待、截图、多标签、返回，以及从顶部滚动再返回顶部。
- 浏览器 profile 测试只访问临时本地 HTML，以独立随机 UUID 保存一条 localhost 测试 Cookie 和 localStorage；正常退出再启动后两者保留。测试结束删除该 profile，未碰产品 profile。
- 所有浏览器窗口均在屏幕外，未向全局事件 tap 发出电脑操作，未调用授权流程，未访问外网站点或登录账号。Socket 是本地内存替身，没有真实云端连接。
- --typecheck 的 arm64/x86_64 两个目标通过。
- caps-signing-check 用假的 security 命令验证缺少身份时构建报错、给出脚本提示、且不覆盖已有输出；脚本 bash -n、Info.plist lint、0.4.0 版本检查通过。没有执行证书创建脚本。
- 完整 build.sh 已用只对该命令生效的 DOUDOU_SKIP_SIGNING=1 构建成功，包含当前界面 Sources 和 Device/，生成 arm64/x86_64 通用 App/DMG。当前未出现界面 icon/Prefs.folder 旧字段编译错误，也无其他编译错误。
- 最终未签名验证生成物：/tmp/doudou-v04-caps-review.3eUHJT/doudou-0.4.0.dmg。未启动这个 App，也未发布、部署。
- git diff --check 通过。开发中发现的非 key 窗口点击投递、滚动坐标和测试 profile 清理问题已修正；最终没有未解决的本地编译/测试失败。

## 集成限制与用户操作

- cloud/src/devices.mjs 当前 CALL_TIMEOUT_MS 仍是 60000。本机允许 300 秒 shell，但云端会先在 60 秒判超时；需云端 worker 在集成时协调调用超时。此 worker 没有改云端。
- 未验证真实通知/日历/文件夹/屏幕录制/辅助功能授权、真实 CGEvent 电脑操作、固定证书签名及升级后 TCC 保留。纯函数和本地图片路径已验证，不能替代这些用户授权后的实际验收。
- 持久 Cookie/localStorage 已验证，真实网站登录、站点差异和会话保留未验证。snapshot 能遍历同源 iframe 和开放 shadow DOM；跨域 iframe/关闭 shadow DOM 无法生成内部 ref。
- DOM 稳定等到上限会返回 stable=false；JS 无响应则报超时。snapshot 的 ref 应以最近返回的结构为准。

签名脚本只写不运行。用户在工作区根目录手动执行：

~~~sh
bash personal-agent/mac/tools/make-signing-identity.sh
bash personal-agent/mac/build.sh
~~~

脚本生成名为 Doudou Local Signing 的十年自签名代码签名证书，导入用户登录钥匙串，并只在用户域对 codeSign 策略建立信任。已有有效身份则跳过；只有证书、缺少私钥/信任时给出检查提示，不重建。~/.personal-agent/signing/ 保留公开证书，临时私钥和 PKCS#12 文件导入后删除。

macOS 可能弹出登录钥匙串解锁或证书信任确认；首次构建也可能询问是否允许 codesign 使用私钥。由用户处理这些弹窗。之后使用固定签名构建的 App 手动开启能力；系统若要求屏幕录制后重启，请重新打开豆豆并继续授权。
