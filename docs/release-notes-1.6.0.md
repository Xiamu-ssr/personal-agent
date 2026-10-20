模型设置改成可横滑的金色卡片：名称水印、余额、模型选择与编辑入口集中在一起，最后一张空卡片新增供应商。新增后直接使用该服务；删除当前服务会切到其他已配置账号。

- Tavily 展示真实总积分和多账号进度；Wind、高德明确显示目前未提供精确余量接口，不估算余额。
- 模型余额接入 DeepSeek、ZenMux Management API Key，以及 OpenRouter 当前 Key 的预算。其他供应商显示未接入状态。
- 原内置 ZenMux 自动迁为普通可编辑账号，保留模型选择、连接器、记忆和原生主 Session。
- 修复长任务中追问被挡在外层队列的问题：新消息直接进入 OpenClaw 的主会话调度，在工具边界处理补充，活动同步显示。
- 修正动态工具参数传递，展示真实调用错误，并开启原生重复调用检测，避免空参数反复失败。

Android 168 项、Cloud 139 项检查通过；双端原生界面及真实 OpenClaw 配本地模型夹具验收通过，覆盖忙碌时接收补充、停止、重启续接和 272K 压缩。包含正式签名 APK、Apple 芯片 / Intel 通用 DMG 与 SHA-256 校验。

Mac 使用现有本地签名，未公证。本轮 Android 界面验收使用虚拟机。更多截图与验证范围见[验收记录](https://github.com/Xiamu-ssr/personal-agent/blob/main/verification/v1.6.0/README.md)。
