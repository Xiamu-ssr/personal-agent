# 安卓 0.5 本地假服务与验收

`app/src/debug/java/com/xiamu/agent/V5Fixture.kt` 的 MockWebServer 只监听 `127.0.0.1`，不转发请求。
`V5ReviewActivity` 使用此地址并停掉设备服务；这些类、样例 HTML 和 MockWebServer 不进入 release。
debug 包关闭设备服务的开机启动；工具在安装后只清理 `com.xiamu.agent.checks` 的旧测试配置与数据。

模拟的合同：

- `GET /api/briefs?days=7`：倒序 HTML 多卡，含短卡、长卡和 `data-prompt` 按钮；每张都是独立文档。
- `GET /api/settings` 和 `PUT /api/settings`：当前选择、服务器选项列表、每项 note；支持保存失败。
- `GET /api/tasks/<id>/history`：四种状态、说明、步骤摘要和 Markdown 结果。
- `POST /api/tasks/<id>/send`：续聊回同一个 id，任务转为 running；支持失败保留输入、完成模拟及 WS 快照。
- `/api/state`、`/api/jobs`、`/api/history`、`/api/tree`、`/api/profile`、`/ws` 为页面提供必要的隔离样例。

模型 note 倍数只是测试样例，不作为实际费用结论。

```sh
python3 tools/review_v05.py
```

先完成 JVM 测试和 APK 构建，再短时启动已有 `pa35`（端口 5554、2 核、2GB 配置、无窗口、host GPU），安装隔离 debug 包，
运行截图与集成检查，导出 `verification/v0.5.0/`，在 `finally` 立即执行 `adb -s emulator-5554 emu kill`。
有其他 AVD 占用 5554 时拒绝操作；不触碰真机，不申请系统权限，不连接真实服务。

已经构建时可加 `--skip-build`。`--classes` 可以只运行某个检查类或 `类#方法`。
跳过构建时会检查源码与 APK 时间，拒绝使用旧 APK。只补普通页面性能、3 秒刷新和截图时可加 `--profile-only`。
`--profile polling` 或 `--profile scroll` 可只补对应记录，减少模拟器运行时间。
这些记录先确认假服务 Activity 有前台焦点，避免把锁屏或通知栏手势记成列表滑动。
图形驱动出错时可用 `--gpu swiftshader`；该模式使用软件渲染，其帧率不代表实体手机。
