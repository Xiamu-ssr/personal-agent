# 0.8.1 自定义模型服务 result

- 按三端约定增加服务 CRUD/test、providers 分组、`{provider,id}` 选择及 settings WS 同步。Key 存在 `system/providers.json`（0600），只返回 keyHint；新旧 Key 和测试失败的 Key 都接入脱敏，禁止模型直接访问私有配置。
- 启动时一次性迁移旧 model 字符串，保留 0600 备份；运行时只读新格式。换服务/Key 后主聊天等本轮结束，续原 session 重开；已运行的后台和 fork 保留原环境完成。动态、旁聊、标题摘要等均读取所选项，语音转文字不变。
- 自定义服务用 Bearer Key、不传 ANTHROPIC_API_KEY，保留代理。SDK 关闭非基础参数及 messages 中的 system 角色，实测窗口 200K；仍附带一条 `claude-code-20250219` 头，无 ModelGateway。HTTP 和 HTTPS 代理隧道均有本地测试。
- 改动集中在 providers/messages-api/migrate-v081、settings/agent/server/summary/config/guard/history 及配套脚本、测试；接口详见 [v08-cloud.md](v08-cloud.md)。
- `npm test` **226/226 通过**，失败/跳过/取消均为 0；`.mjs` 语法检查 **127/127 通过**。未连接服务器、读取真实密钥、部署或提交。

本地真实 SDK + 最小 Messages/SSE 假服务抓包（Key 打码）：

```json
{"channel":"probe","model":"fixture-basic-v1","auth":"x-api-key + Bearer","keyHint":"2468","max_tokens":8}
{"channel":"main","model":"fixture-basic-v1","Authorization":"Bearer ••••2468","x-api-key":null,"thinking":null,"output_config":null}
{"channel":"feed","model":"fixture-basic-v1","Authorization":"Bearer ••••2468","x-api-key":null,"thinking":null,"output_config":null}
{"channel":"summary","model":"fixture-basic-v1","Authorization":"Bearer ••••2468","max_tokens":1024}
```

`resumedSameSession:true`、`deferredUntilIdle:true`、`contextWindow:200000`；主聊天 say、动态落盘、标题摘要均成功。另验证了原 fork 继续访问旧服务、新 fork 使用新服务，以及未知 ID 和 Claude 格式 ID 原样传递。证据：`/tmp/v081-cloud-demo/providers/`；全量测试日志：`/tmp/v081-providers-tests.log`。
