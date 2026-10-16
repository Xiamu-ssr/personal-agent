# 0.8.1 ModelGateway 撤回 result

- 删除 `src/model-gateway.mjs`、`test/model-gateway.test.mjs` 及 agent 接线；SDK 子进程原样继承 `ANTHROPIC_BASE_URL`、`HTTPS_PROXY`、PATH。
- 保留 E、主/独立会话 `setModel`、新任务与标题读取当前设置、分类器环境变量和子代理强制模型。已运行 fork 使用启动模型完成，新 fork 使用当前模型；协议文档已同步。
- `npm test`：**211/211 通过**，失败/跳过/取消均为 0，含真实 SDK 切模型与真 Chrome 回归；`.mjs` 语法检查 **118/118 通过**。
- 仅本地验证；未连接服务器、部署或提交。
