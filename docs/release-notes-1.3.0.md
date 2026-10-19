点子和动态讨论现在先引用到聊天输入框。可以补充文字，也可以直接发送引用；发送失败保留草稿，历史记录保留被采纳点子的完整快照。

- 修复活动列表缺少 started，以及 Android 活动详情不识别 tool_result 的问题。Mac 同步呈现工具调用与执行结果。
- 两端改用安静的灰蓝配色，缩小头像、减少重复标题和装饰卡片，调整字号与间距。
- 动态、点子更新带入近期主聊天快照，共享原生记忆；用户采纳、Goal、提醒和心跳继续使用同一个主 Session。
- 搜索使用已连接的 Tavily 账号，已知网页使用 web_fetch。模型供应商和搜索服务分别计费。

**Android、Mac 和 cloud 必须一起升级至 1.3。** 使用协议 2，删除旧点子点击执行入口和旧动态讨论发送分支。已有配对、记忆、配置、Goal 和原生 Session 保留，无需重跑迁移。

验收：云端 112 项测试；Android 调试和发布构建各 160 项单元测试，签名发布 APK 在模拟器连接生产 HTTPS 完成 19 项界面检查；Mac 完成 25 项原生界面检查。用户实体手机未测试。Mac 为 Apple 芯片 / Intel 通用包，固定本地证书签名，尚未 Apple 公证。

[验收记录](https://github.com/Xiamu-ssr/personal-agent/tree/v1.3.0/verification/v1.3.0) · [界面截图](https://github.com/Xiamu-ssr/personal-agent/tree/v1.3.0/docs/images/v1.3.0)
