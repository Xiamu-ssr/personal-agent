# 豆豆 1.6.1 验收

修复聊天附件测量与固定裁切：Android 共用按原始宽高比测量的图片组件，长图后的文字和下一条消息不会重叠；动态两端按比例完整显示并能点开查看。账号按钮可随空间换行，Android 模型卡片随系统字体增高。

Wind 显示简短的可用性状态，不生成数值进度；一个账号耗尽仍有其他账号可用时整体显示「额度正常」。未知余额不展示接口说明或假数值。Tavily 和已支持的供应商继续展示真实数值。

## 任务故障

旧后台任务走 OpenResponses，执行中切换模型可复现 `Gateway requester authority changed`；主聊天的 Gateway 入口不受该 HTTP 授权快照影响。现已删除第二条执行路径，所有运行按原生 Session Key 使用 Gateway，保留任务隔离和同一长期主会话。

`cloud/scripts/verify-task-reload.mjs` 启动真实 OpenClaw 与本地合成模型：阻塞后台模型调用，在执行期间切换模型，确认原生热加载生效，再继续工具调用并完成任务，结果回到主会话。修复前失败、修复后通过，见 `task-reload.json`。

## 检查

- Cloud：130 项单元检查通过。删除仅服务于旧 HTTP 执行入口的测试，原生运行的模型切换由上述集成检查覆盖。
- OpenClaw：原生工具、记忆检索、同一会话与重启续接、工具运行期间接收两条补充、按需读取附件、272K 压缩策略通过。
- Android：169 项单元检查；2 项设备测试覆盖 8 组宽度／字体／单图和多图布局、动态完整宽高比与三段图像像素。实际 App 另验证聊天、动态、账号额度、较大字体下账号按钮和模型卡片，共 5 项。
- Mac：223 项核心断言、附件布局和登录检查；原生图片 320×480、动态图片、Wind 状态、连接器列表和模型卡片复核。
- 本轮仅使用 Android 15 模拟器、隔离偏好、合成图片和本地模型。未使用 OPPO 真机。安装包与生产结果补充到 `deployment.json`。

## 复现

先设置 `DOUDOU_UI_FIXTURE=verification/v1.6.1/fixture.json`，运行 `node cloud/test/usage-ui-fixture.mjs`。调试包安装到临时模拟器，反向代理 18770 端口后运行 `ImageLayoutDeviceTest` 与 `android/tools/review-v161.py`。脚本拒绝实体设备。

Mac 使用 `mac/tools/compile-check.sh` 编译 `mac/Tests/V161Review.swift`，设置隔离的 `DOUDOU_DATA_DIR` 与截图目录 `DOUDOU_REVIEW_OUTPUT`，以 `-server http://127.0.0.1:18770` 运行。所有页面数据均为合成信息。
