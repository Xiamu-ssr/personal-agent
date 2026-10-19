# 1.3.1 动态任务执行修正

这是云端更新，API 协议仍为 2，Android / Mac 1.3.0 无需重装。

## 原因与改动

- 生产记录中，6 次动态任务在约 5 分钟时以 `terminated` 失败；原生日志同时记录 `HTTP client disconnected`。OpenResponses 在工具执行期间不发送文本事件，旧版 fetch 连接的默认 300 秒响应体静默超时中止了仍在执行的任务。
- 用可显式取消的本地 HTTP 流替换该连接，执行期限由 OpenClaw 管理。真实错误、输出耗尽和没有完成事件的响应不会记成成功；没有自动重放任务。
- 当前 DeepSeek 的上下文被配置成 131,072 tokens。按[硅基流动目录](https://www.siliconflow.com/)修正 DeepSeek V4.1 Flash、GLM 5.3 Flash 和 GLM 5.3 为 1,048,576，消除错误元数据导致的提前溢出。
- 关闭外层 OpenClaw Tool Search，保留一层产品工具目录和完整调用参数。生产日志曾出现把 `tavily.search` 当外层工具 id、漏掉内层 name 等多次无效调用。

## 本地验证

- `npm test`：120 项通过。
- `npm run check`：通过。
- `npm run verify:kernel`：真实 OpenClaw 2026.10.4 + 本地模型 fixture，验证直接工具参数、原生记忆检索、工具执行、主会话续接、重启续接和停止任务；5 次模型请求。
- 305 秒完全无响应体输出的 HTTP 对照：旧 fetch 在 301,466 ms 报 `UND_ERR_BODY_TIMEOUT / terminated`，新连接在 305,012 ms 收到完成事件。它是传输回归测试，不是外部模型任务。
- 新增流边界测试覆盖 UTF-8 / SSE 分块、取消、中途断流、缺少完成事件、模型错误、输出上限和 HTTP 错误。

原始机器可读结果：[传输对照](transport-regression.json)、[原生内核](native-kernel.json)。

## 改动文件

- `cloud/src/openresponses.mjs`、`openclaw-runtime.mjs`：执行连接及工具配置。
- `cloud/src/provider-presets.mjs`：模型上下文。
- `cloud/test/openresponses.test.mjs`、`provider-presets.test.mjs`、`cloud/scripts/verify-openclaw.mjs`：验证。
- `cloud/package.json`、`package-lock.json`、`cloud/docs/v13-cloud.md`：版本与说明。

## 生产验证

- 云端 1.3.1 就绪，部署前创建私有离线备份，记忆、模型账号、连接器账号和动态配置哈希一致。
- 用生产硅基流动模型和现有动态要求执行一次真实刷新：338 秒正常完成，发布 2 条动态；32 次原生工具返回，0 次工具错误，0 次外层嵌套调用。
- API 读回的两条帖子都有正文、来源和原文链接；配图完成像素解码，分别为 600×400 JPEG、1132×1031 PNG。
- 从外部 HTTPS 访问状态、动态接口均为 200，读到云端版本 1.3.1 和有效帖子。
- 本轮没有重新打包或操作客户端界面；Android / Mac 继续使用 1.3.0。

脱敏结果：[生产记录](production.json)。服务器地址、账号、提示词和用户内容仅留在私有部署存储。
