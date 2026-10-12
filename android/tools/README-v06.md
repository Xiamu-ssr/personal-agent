# 安卓 0.6 本地验收

`V6Fixture` 只监听 127.0.0.1，不转发任何请求。`V6ReviewActivity` 停止设备服务，使用隔离包
`com.xiamu.agent.checks`；假服务、验收 Activity、CSS 样例和 MockWebServer 不进入 release。

假服务提供 0.6 的 `/api/jobs?before=&limit=30`、任务 history/send（含 agent/user 与附件）、
上传、健康 GET/sync、历次简报 item，以及页面所需的 settings/profile/tree/history/WS。
简报示例使用 `app/src/debug/assets/v06/brief-base.css`，它是云端基础样式的只读快照，含日期条、
状态格、步骤、对比和按钮；修改云端基础样式后可重新复制此 debug 资源，不能据此修改 cloud。

```sh
python3 tools/review_v06.py
```

先跑 58 项 JVM 检查并构建 debug、测试和 release APK，再启动已有 pa35，固定端口 5554、
无窗口、host GPU、2 核、2GB。脚本所有 adb 调用都带 `-s emulator-5554`，会核对 AVD 名字，
只安装/清理 .checks 测试包，不操作真机，不申请系统授权，不连接真实云端。
运行 V6Checks 的 7 项实际交互检查和截图，并在同一次开机里取普通页面轮询时间。
最后在 finally 中 emu kill，并清理 emulator 日志中的 adb 公钥输出。
已构建可传 `--skip-build`，脚本会拒绝源码晚于 APK 的情况。

`--repair-session` 只用于本地修复：断言失败后可向脚本 stdin 写 `retry`，复用这一次开机；
其他输入或 EOF 会关闭模拟器。不要让等待修复的模拟器长期空闲。

本轮最终证据是 `verification/v0.6.0/instrumentation-final.log` 的 OK (7 tests)、58 项 JVM 结果、
16 张最终截图、JSON 协议/手势证据，以及 release 签名和 manifest 检查。
本轮追加的普通页面轮询导出缺少启动标识，与前面的 JUnit 记录相同，未作为验证结果。
脚本现会先删除旧文件，等待 onStop 写入新的文件，并要求 launchId/processId/clock；
这段采样修复仅做编译/语法检查，未重启模拟器复测。任务在 JUnit 中的真实时间轮询已经通过。

V4/V5 的历史截图保留作历史证据；0.5 简报/任务的旧 UI 断言已被 V6Checks 取代。
V5Checks 只保留模型与权限保存回归并迁移样例 ID，本轮仅编译了这些保留检查，没有运行它们或整套 V4 UI 检查。
系统文件选择器、相机、录音权限、实体手机、生产服务和 release 性能需另外验收。
