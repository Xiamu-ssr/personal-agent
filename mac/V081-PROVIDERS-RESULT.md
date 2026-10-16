# Mac 0.8.1 自定义模型服务

- 模型页按 ZenMux（内置）和自定义服务分组，名称、一行说明、单选即保存；使用 `model:{provider,id}`，删除旧扁平模型解析。
- 添加/编辑表单支持名称、Base URL、密码框及显示切换、固定 Anthropic、多模型增删；完整校验，保存中显示进度，由云端测试成功后保存，失败留在表单显示错误。
- 编辑只显示 `••••abcd`，空 Key 不提交；删除当前服务直接显示云端「先换到别的模型」。Key 不持久化到 Mac，调试描述及错误脱敏；设置事件同步选中项。

验证全部通过：`bash mac/Tests/verify-v081.sh`，**68 条模型服务 + 66 条 0.8.1 + 80 条原有断言，共 214 条**，另有 1 项原生附件布局和 4 组地址/登录检查。原生窗口 **16 项**验收；真实本地 cloud HTTP/WS、Harness、Agent SDK **17 项**对接，包括选中服务后下一轮确实请求自定义假模型。失败请求 stdout/stderr 与验收日志均未出现提交的假 Key。

`VERSION=0.8.1 bash mac/build.sh` 和产物校验通过：arm64 + x86_64、签名、15 个头像资源。产物 `mac/build/doudou-0.8.1.dmg`；`git diff --check -- mac` 通过。

截图均为自身窗口 `screencapture -l`，接原编号，使用假 Key 和 `https://example.test`：

| 路径 | 内容 |
| --- | --- |
| `/tmp/v081-mac-shots/24-models-light.png` | 浅色分组模型列表，含自定义服务。 |
| `/tmp/v081-mac-shots/25-models-dark.png` | 深色分组模型列表。 |
| `/tmp/v081-mac-shots/26-provider-add.png` | 添加表单、密码框和两行模型。 |
| `/tmp/v081-mac-shots/27-provider-test-error.png` | 服务测试失败，保留草稿并遮蔽回显 Key。 |
| `/tmp/v081-mac-shots/28-provider-edit-masked.png` | 编辑页只显示 Key 尾号，留空不改。 |

记录：同目录 `providers-acceptance.json`、`providers-local-acceptance.json`、`providers-local-evidence.json`、`providers-final-check.json`；截图哈希并入 `manifest.json`。自启 App、SDK 和云端已关闭。

本次文件（相对 `mac/`）：产品为 `Sources/ModelProviders.swift`、`AgentSettings.swift`、`Settings.swift`、`Console.swift`、`Nav.swift`、`Pages.swift`；测试为 `Tests/ProviderTests.swift`、`ProvidersReview.swift`、`ProvidersLocalTests.swift`、`verify-v081.sh`；工具为 `tools/providers-fake-cloud.mjs`、`providers-local-cloud.mjs`、`review-providers.sh`、`verify-providers-local.sh`；结果为本文和 `V081-RESULT.md` 的补充链接。

只改 `mac/**`，版本仍为 0.8.1，没有提交或发布。测试均用隔离数据和本地假模型，未连接真实服务、读取真实 Key/token 或用户正在使用的数据。收尾时云端接口已实现并补测；`v08-cloud.md` 的模型服务段尚未更新，按 `v081-providers.md` 约定对接。
