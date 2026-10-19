# v1.3.2 · 272K 主动压缩

云端将约 272,000 tokens 设为主动压缩线。模型真实容量保留，OpenClaw 原生运行预算为 292,000，其中 20,000 是压缩预留；小窗口模型按自身容量限制。主会话与隔离任务共用策略，启用原生工具循环中途预检，保持同一个主 Session。

## 验证

- `npm test`：121 项通过，0 失败。
- `npm run check` 与 `node spec/build.mjs`：通过。
- `npm run verify:kernel`：真实 OpenClaw 2026.10.4、本地模型协议，验证记忆检索、工具调用、同一主会话、重启续接及手动停止。
- `npm run verify:context`：使用真实 OpenClaw 与合成模型用量；250,000 输入 tokens 时未压缩，273,000 时触发原生压缩，SQLite 留下 1 条 compaction 记录。压缩摘要保留早期标记，后续请求收到该标记，主 Session ID 没有变化。
- 线上 Cloud 1.3.2 已加载：模型真实容量 1,048,576，运行预算 292,000，原生压缩预留 20,000，主动压缩线约 272,000。所有已配置模型预算符合该策略。
- 部署前离线备份持久化数据；部署后用户资料、记忆、模型与连接器配置的散列一致，主 Session ID 保留。线上 Spec 与构建产物逐字节一致。
- 外部 HTTPS 健康接口和已认证状态接口均返回 200，确认版本 1.3.2 且原生内核已就绪。

边界验证使用本地合成用量与回复，没有向线上用户会话灌入巨量文本，也不代表对外部模型摘要质量的测评。当前策略继续使用 OpenClaw 的摘要质量检查和记忆 flush。

首次部署校验将健康接口的协议字符串 `"2"` 与数字比较，触发自动回退；修正校验脚本后重新部署通过。产品协议未变更。

机器可读结果见 [results.json](results.json)。客户端及协议不变，继续使用 1.3.0 安装包。

## 变更位置

- `cloud/src/provider-presets.mjs`：模型容量与主动压缩运行预算分开。
- `cloud/src/openclaw-runtime.mjs`：原生工具循环中途预检。
- `cloud/test/provider-presets.test.mjs`、`cloud/scripts/verify-context-policy.mjs`：预算与原生压缩续接验证。
- `spec/spec.yaml`、`spec/index.html`：同步 272K 决策。
- `cloud/docs/v13-cloud.md`、版本元数据、README：云端 1.3.2 说明。
