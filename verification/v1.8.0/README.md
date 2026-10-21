# 1.8.0 内容、界面与性能验收

三列表格先确定列宽，再按实际换行决定行高；更多列保持横向滚动。主聊天在聊天、动态、点子、目标与资源库之间复用，隐藏时不更新行、不播放媒体。进入设置则释放聊天的原生托管视图，避免外观变化更新旧布局；测量与阅读锚点属于原会话，不建立第二份数据源。

头像从持续循环改为短暂表情，普通状态最多 2.5 秒；探头动作结束后同样释放播放器。低电量、减少动态效果、后台与离屏均停播。权限状态由返回前台和实际授权变更更新；无障碍仅订阅所需的窗口事件，按需观察仍能获取更新后的内容。

连接保活统一为服务端 90 秒，删除两个客户端的 25 秒定时器。原生网络栈回复 pong，不查询历史、不唤醒模型。它与豆豆的定时工作是两套机制。

## 已执行的检查

- 云端 145 项测试与源码检查通过，包含真实 WebSocket 对端的 pong、静默断线和关闭处理。
- Android 170 项 JVM 检查、API 35 模拟器 6 项检查通过。后台静默 95 秒后保持连接、自动回复服务端 pong、响应授权的电量读取，客户端主动 ping 为 0；另有头像生命周期、表格、长图和连续曲线手势检查。
- Mac 224 项核心断言、原生附件布局和登录地址检查通过。实际窗口载入 1000 条合成消息，检查 20 次切栏、历史阅读位置、表格边界以及真实点击的菜单。

`mac-performance.json` 记录同一工作负载：返回聊天布局耗时中位数约 62.0 → 12.5 毫秒，20 次切栏最大值约 102.3 → 52.7 毫秒；空闲视频 2 → 0，读取历史的位置在常用栏目和设置往返后都保留，布局循环警告为 0。这里测的是导航加同步布局，不是端到端点击延迟。

对照数据、正式安装包与生产核验在同目录 JSON 中记录。进程 CPU、解码器数量和模拟器结果不是手机全天耗电占比；19% 是否改善需要真机日常使用后比较。本次没有连接真实手机，也没有向用户主会话发送测试消息。

## 复现合成工作负载

`node verification/v1.8.0/fixture.mjs > /tmp/doudou-content-fixture.json`，再用 `DOUDOU_UI_FIXTURE=/tmp/doudou-content-fixture.json node cloud/test/usage-ui-fixture.mjs` 启动仅监听本机的 HTTP/WS。

Mac 检查入口为 `mac/Tests/PerformanceReview.swift`，通过 `mac/tools/compile-check.sh` 编译，并配合真实 Mascot 资源、独立 `DOUDOU_DATA_DIR`、`DOUDOU_REVIEW_OUTPUT` 运行。前台动画核验使用 `DOUDOU_REVIEW_INTERACTIVE=1`，必须激活验收窗口；记录中明确标识是否处于前台。Android 通过 adb 反向映射本机 18770 端口，执行 `PowerContentDeviceTest`、`TouchMotionDeviceTest` 和 `ImageLayoutDeviceTest`。测试使用合成账号和文件，正式 Android 包仍要求 HTTPS。
