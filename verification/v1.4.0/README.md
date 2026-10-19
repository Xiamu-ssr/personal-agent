# 1.4.0 验收

Android、Mac 与 cloud 同版发布。APK 在原 OPPO 安装上覆盖升级，保留配对和“豆豆专用”归属；DMG 包含 arm64 与 x86_64，沿用固定本地签名。

- Cloud：123 项测试通过；Android：160 项测试通过。
- [原生附件读取](native-attachments.json)：真实 OpenClaw + 本地模型夹具；首次模型请求只有路径，调用 `view_image` / `read` 后才获得两张图片和文本内容。
- [真实供应商附件读取](production-attachments.json)：生产 HTTPS 上传一张合成图片和一个文本文件，在旁聊中通过原生工具读对图片文字、三个色块及文件标记；活动完成。
- [原生内核](native-kernel.json)：工具循环、记忆检索、主 Session 重启续接与停止验证通过。
- [272K 压缩策略](native-context.json)：真实内核，合成 usage 越过阈值后触发压缩，同一 Session 保留连续性；不是消耗 272K 真实供应商 token 的成本测试。
- [生产保全检查](production.json)：停服后完整备份数据、环境和 unit；配置、记忆、内容与 Skill 正文逐文件核对，主 Session 保留。连接器自动生成的安装版本标记允许更新。

## OPPO 真机

Android 15，PHW110。旧版本没有 Phone Use 服务；1.4 在系统无障碍里提供“豆豆手机操作”。真实授权连接后才注册 ready；App 关闭该能力后，云端立即显示关闭及原因，重新授权后恢复，无需重启。

隔离服务经实际 WebSocket → DeviceHub → 手机 AccessibilityService 完成：拼多多和淘宝启动、中文“手机支架”输入、提交搜索、读取商品结果、滚动/滑动、1440 长边截图、返回、主页和最近任务。旧 frame 被拒绝；锁屏返回实际 screenOn/locked 状态。切换前后台期间连续 12 次读取全部完成。没有购买、进入订单或发送消息。

[正式版真实模型流程](production-phone.json)使用 DeepSeek V4.1 Flash：读取节点与截图、在系统弹窗允许后台运行并确认状态、进入拼多多搜索“桌面手机支架”、观察结果并滚动、最后返回豆豆。两个验收轮次共完成 32 次设备调用，归属为 agent。系统白名单独立确认了后台运行许可。模型的观察与操作均未经过 ADB；ADB 仅用于安装、人工驱动初始无障碍授权及开发验收。

## 界面证据

[OPPO 本机权限](oppo-permissions.png) · [Mac 生产附件旁聊](mac-production-attachments.png)

截图已检查像素，只含设备权限或合成验收内容；不含生产地址、账号、真实对话与密钥。

## 范围

只验证了这一台 Android 15 OPPO；其他品牌的后台限制、Android 9/10 不提供无障碍截图、应用禁止截图或缺少无障碍节点等，仍以设备实际回执为准。Phone Use 不解锁有密码的锁屏。健康权限未作为本次真机验收结论。Mac 电脑操作仍需要用户现有的屏幕录制和辅助功能授权；本次验证了权限状态展示与设备连接，没有新增系统授权。
