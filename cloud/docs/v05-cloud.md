# 云端 0.5 本地交付报告

2026-10-11。按 `spec/app-v4.md` 和 `.codex-handoff/v05-common.md` 实现，只改 `cloud/**`、`spec/prompts/**`。没有 commit、push、发布、部署或 SSH；没有请求真实 ZenMux/云端、连接账号、上传、运行真实定时任务。Android、Mac 和 Spec worker 的改动未修改。

云端新增 HTML 简报、共享模型/权限设置、任务记录及续聊；保留 Claude Code 内置系统提示词和压缩。当前协议见 [app-protocol-tasks.md](app-protocol-tasks.md)。`v04-cloud.md` 等旧报告是历史记录，不是 0.5 操作说明。

## 实现方式

### 系统提示词、定时消息与压缩

- 主查询和隔离查询统一 `systemPrompt: {type: "preset", preset: "claude_code", append: ...}`；原生 fork 继承同一接法。业务 append 在进程内只读、填占位符一次，不掺时间、在线设备或当前任务，字节保持稳定。真实 CLI 的请求包含内置提示词和豆豆业务提示词。
- `system-prompt.md` 删除 JSON 简报格式、最小示例，以及通用工具/编码执行规则、Agent 拆分/并行操作说明、「子 agent 看不到对话」的错误限制、定时 fork 技术包装。产出物表改为 `data/briefs/<日期>/<任务名>.html`，按「简报写法」写。保留豆豆人设、语气、目录与记忆规则、业务数据来源、账号接入、健康快照、站点标题/描述、夜间整理和补读规则。
- 新建 `brief-guide.md`：360px 画板、320–480px 自适应、每卡 560px、四套配色变量、组件 class、信息层次与最小示例。参考 Today AI `refs/frames/brief-strip.png` 的日期 chip、一句话判断、横排小卡和底部动作；不把指南塞进系统提示词。
- 晨报、晚报、健康周报只在原始定时 prompt 后附指南；其他定时 prompt 原样派发。运行层的 UserPromptSubmit 增加一句「这份定时任务请放到后台做，完成后通知用户」。既有 fork 守卫保留，只接受当前的 Agent 工具，去掉旧 Task 别名。
- seed 中三份简报 prompt 只保留内容要求和 HTML 目标路径。健康 `latest.json` 是健康页快照，仍保留其独立结构要求。
- 删除 `COMPACT_INSTRUCTIONS`、对应脚本及自定义短摘要测试。PreCompact 不再提供摘要文字；仍通过 SDK 临时切到 low effort，PostCompact/任务结束后恢复 max。`/compact` 直接使用内置压缩。

### HTML 简报与迁移

- 云端持有 `brief-base.css`、`brief-button.js`。默认银蓝 + 香槟金，另有 mist/晨雾、mint/薄荷、dusk/暮光；section 上的 data-palette 选择局部 CSS 变量。提供 chip、title、summary、timeline、tiles/tag、metrics、list、note、button。
- `/api/briefs?days=7` 只扫描 HTML，按 time 倒序返回 `{items:[{date,name,time,path,cards:[{html}]}]}`。每个 html 都是完整文档，注入基础样式、作者 style、单张 card 和按钮脚本。name/time 可由 brief-name/brief-time meta 指定，未指定取文件名/mtime。
- 按钮只需要 data-prompt。受信脚本将原文 URL 编码到 `doudou://prompt?text=...`；独立文档有 CSP，允许这份脚本的哈希、内联样式及 data 图片/字体，禁止连接网络。
- Write/Edit/MultiEdit/NotebookEdit 共用 PostToolUse HTML 校验：1–6 个顶层 section.card、禁止嵌套、文件 ≤80KiB、没有外部资源/@import/作者脚本/事件属性；按文字量、组件行列和元素数估算高度，超过 560px 或 120 个元素用中文要求修改。无效文件不计完成产出。JSON 简报写入明确拒绝，文件路由也不再提供简报 JSON。
- `scripts/migrate-0.5.mjs --root <工作目录>` 默认 dry-run，加 `--apply` 执行。把 v1 JSON 同名转换成 HTML，沿用全部旧组件内容及按钮文字，必要时在区块边界拆卡。先生成并校验 HTML，再将原 JSON 移到 `backup/migrate-0.5/<时间>/data/briefs/...`，不删除原文件。
- 同名 HTML 内容不同、无法解析或无法通过新校验时保留原件并报告错误；同名 HTML 正好等于生成结果可补完中断迁移。重复执行无新修改/备份。跳过符号链接。已有 schedule 的简报格式短语和 JSON 目标路径也迁移，先备份，保留自定义任务。删除旧的反向 `migrate-0.4.mjs`。

### 模型、权限、上下文

- 选择原子保存于 `system/app-settings.json`（600 权限）；默认 `anthropic/claude-haiku-5.5` + auto。模型只有 Haiku 5.5、`xiaomi/mimo-v2.6-pro`、`z-ai/glm-5.3-flashx`；权限只有 auto、bypassPermissions。GET/PUT 返回完整选项和一行 note；非法字段/值不改原文件。
- 删除 AGENT_MODEL、AGENT_PERMISSION_MODE、AGENT_EFFORT 等环境覆盖，SDK 子进程也清掉继承的旧覆盖。基础设施、名字、称呼、时区等仍用原服务配置。业务 effort 固定 max。
- 忙时保存设置，当前回复先完成，原生 idle 后下一轮应用。权限用 `setPermissionMode`；模型先 `setModel`，再以同一 mainSessionId 重建/resume query。队列和主会话上下文保留；运行中的 fork 以同一 task id 恢复，继续使用新模型。
- 需要重建的实际原因：SDK 0.3.295 的 `updateSettings` 拒绝修改 env，单独 `setModel` 不能刷新 CLI 的子任务默认模型和审批分类器模型。新 CLI 同步设置三种默认模型、强制子任务模型、`CLAUDE_CODE_AUTO_MODE_MODEL` 和 `CLAUDE_CODE_BG_CLASSIFIER_MODEL`。已确认该 CLI 有独立的审批模型配置项；不是缺少接口的推断。
- 三模型的 modelPicker 共享 CLI 能力 profile `claude-haiku-5-5`，发给模型服务的 model 仍是选中的原 ID。固定 200K 窗口、禁用 1M 档、约 167K 自动压缩；不再把 MiMo/GLM 当未知模型限制到 128K。
- native CLI 所需输出上限为 128000；输出预留 20000，摘要预留 13000，因此输入压缩点约为 200000−20000−13000=167000。CLI 还考虑下一次请求的增长，不能把它当作严格精确的某个 token 数。输入统计包含 cache creation/read，避免漏算或重复相加。
- 主、fork、补读、夜间整理、隔离任务续聊共用设置/200K 策略。auto 和完全放行都不向 App 发授权请求。

### 任务记录和续聊：SDK 0.3.295 / CLI 2.1.295

选用原生 **SendMessage**，而非重新拼用户/模型记录或新建 Agent：`to` 为原 task id，`message` 为用户原文。对运行中的任务，消息进入同一 agent 的后续请求；对已完成的任务，CLI 恢复原 subagent transcript，保持 task id、产生新的 run id，仍在后台做并发原生完成通知。本地真实 CLI 验证了两种情况，续聊请求包含原任务 prompt 和先前结果。模型切换后的完成任务和仍在运行的任务也验证了原上下文保留。

运行层守卫只允许给指定任务发送原文，不允许主会话代做或另建 Agent。独立维护任务则 resume 自己的 sessionId；运行中的独立任务续聊排在当前回合之后。主任务查询临时 unavailable 时返回明确错误。

- `GET /api/tasks/<id>/history` 从当前 harness 私有 sessions 目录读对应 transcript，输出 prompt/text/tool/result；不扫描其他用户会话，不返回 thinking、原始工具输出、base64 或压缩内部消息。工具摘要只有一行，文本使用既有 redact 并补充常见凭据模式遮蔽。
- CLI 对运行中 SendMessage 的投递可能合并进工具回合，而不单写 user transcript 行。因此另保存用户提交原文的脱敏副本，补齐缺失的 prompt，并与 transcript 去重。模型步骤、文本和结果仍完全来自 transcript。
- 元数据持久化于 `system/task-index.json`（600 权限），含 id、父 session、状态和本轮产出；拒绝非法 id，忽略迟到的旧 run 事件。当前和已结束任务都可查记录，`/api/jobs` 每项均带 id。客户端对 running history 每 3 秒刷新。
- job.done 保留 path，并补 id、name/time；聊天显示简报名和时间，对应今日页的同一路径。没写文件的后台任务也会进入任务历史/完成事件，不插空产出卡片。

## 实际验证

环境：Node 26.5.0；锁定 SDK 0.3.295；原生 darwin-arm64 Claude Code 2.1.295。模型服务全部为 localhost 假 Anthropic；任务/简报/会话均在隔离临时目录，账号及密钥为假数据。仅离线更新 lockfile，没有升级 SDK。

| 检查 | 实际结果 |
| --- | --- |
| `npm run check` | 通过，所有 src/connectors/scripts/test mjs 语法检查 |
| `node --check src/brief-button.js` | 通过 |
| `npm test` | **80/80 通过，0 失败、0 跳过**；原生 CLI 测试并发上限 2，约 14.5 秒 |
| HTML 与按钮 | 数量/顶层/资源/脚本/大小/估高、CSS 转义、四套配色、独立文档注入、中文文本、URL 编码、自然日排序、HTML-only、符号链接边界；真实 SDK 的主/fork/隔离 Write/Edit 收到中文错误并修正 |
| 迁移 | 全部旧组件、转义、拆卡、dry-run 不写、原件备份、冲突和坏文件保留、中断恢复、重复无操作、schedule 自定义任务保留 |
| 迁移 CLI 入口 | 另以临时 fixture 调用脚本 dry-run → --apply → 重复 --apply，原件备份内容逐字相同，重复 0 项 |
| 设置/接口 | 默认值、600/原子写、部分 PUT、非法字段/权限/JSON、旧 env 不生效、鉴权、history/send、任务列表 id |
| 真实 SDK 模型切换 | Haiku → MiMo → GLM 下一轮 wire model 改变，session id 相同，原消息仍在请求内，max effort，业务 append 字节相同；分类器/子任务模型配置实际进入新 CLI 子进程 |
| 真实 CLI 200K/压缩 | 三个模型的 modelUsage.contextWindow 都为 200000；假 usage 总计 165K 后不压缩、167K+ 后触发内置压缩，low 后恢复 max；没有自定义短摘要指令。已有主/fork/隔离压缩及故障恢复测试通过 |
| 真实 SDK 任务续聊 | 已完成 fork 的同 id/新 run/原 prompt+原结果；运行中收到新消息；模型切换中恢复运行 fork；隔离任务续聊保持 session 和原结果；history 提交消息不重、不漏 |
| 权限与生命周期 | auto ↔ bypassPermissions 下一轮控制调用生效，保留 session/query；后台快照、完成通知、原生 idle 放行队列、单任务 stop、主 stop 与 fork 分开；无 App 授权事件 |

旧的 schedule 单测曾要求接受 Task 别名，已按不做兼容的要求改成拒绝，只接受 Agent；最终全套通过。

## 没验证的和剩余限制

- **没有连接真实 ZenMux。** 本地证明 CLI 配置、请求结构、上下文恢复和协议；没有证明三家真实模型接受 adaptive thinking/max effort/128000 输出参数、工具调用、审批判断、长上下文、压缩质量、价格或缓存命中。业务 append 的字节稳定已测，真实 prompt cache 是否命中未测。
- 200K 验证使用假服务报告的 usage 触发真实 CLI 压缩；没有向真实模型发送 167K 实际长文。
- 高度校验是粗估，不能预测任意作者 CSS 的最终布局。没有启动 App/WebView 或跑跨端 UI；实际 scrollHeight、屏幕 75% 内滚动、doudou 拦截、禁止网络和今日定位需两端验收。任意 Bash 写文件绕过 PostToolUse 时不会自动收集产出。
- 正常 SDK query 重建会 resume 原主 session。若旧会话发生不可恢复的上下文故障，既有恢复机制会建立全新父 session；旧任务记录仍可读取，但目前对旧父会话的续聊返回 **503 session_unavailable**，需要恢复其原父 session。没有复制成缺失上下文的新任务。
- 未执行真实数据迁移，也未重启生产服务；没有设备安装或系统授权操作，无需用户现在授予本机权限。

## 用户/Claude 集成后需要做的服务器验收

这些是待执行步骤，本 worker 没有执行。

1. 在停止服务后，以服务用户、实际工作目录先 dry-run，再 apply，再重复一次；检查 report.errors、备份原件、生成 HTML 和保留的自定义 schedule。不要按旧报告运行已删除的 0.4 脚本。

   ```sh
   node cloud/scripts/migrate-0.5.mjs --root /srv/agent
   node cloud/scripts/migrate-0.5.mjs --root /srv/agent --apply
   node cloud/scripts/migrate-0.5.mjs --root /srv/agent --apply
   ```

   默认设置文件首次启动创建；过去的模型/权限/effort 环境变量不再决定模型，按需在 App 选择。不要把服务凭据抄进报告或聊天。

2. 对三个模型分别发真实消息和一次本地可逆工具操作，确认服务请求/log 的 model ID、max effort、adaptive thinking、输出参数被接受。检查主、fork、隔离补读/夜间整理，以及 auto 判断实际都请求选中的模型；覆盖 auto 拦下危险动作和完全放行，确认 App 不弹权限请求。
3. 忙时切模型/权限，核对当前回复完成后才生效，原 session/history/排队消息保留；切换时已有 fork 必须同 id 恢复并最终通知，不能出现幽灵任务或重复执行已有副作用。
4. 用真实长上下文核对 200K/约 167K 压缩、缓存读写计量、内置摘要质量及 low→max 恢复；观察真实缓存结算，确认稳定 append 的收益。
5. 对运行中、已完成、失败/停止、服务重启后恢复的任务打开 history 并续聊，确认原上下文、新 run、同 id、中文脱敏记录和完成通知；也检查不可恢复的新父 session 情况会给明确错误。
6. 手动触发三份简报并等一次真实定时点，检查 fork 守卫、指南附加、HTML 修正、`/api/briefs` 顺序和独立文档。两端用宽 320/360/480 的卡片检查层级/配色、动画、按钮、内部滚动、阻断跳转/网络和聊天卡片跳今日定位。

## 改动文件

以下路径相对 personal-agent；不包含其他三个 worker 的文件。

- 运行/API：`cloud/src/agent.mjs`、`app-settings.mjs`（新增）、`config.mjs`、`context-policy.mjs`、`scheduler.mjs`、`server.mjs`、`task-history.mjs`（新增）。
- 简报：`cloud/src/briefs.mjs`、`brief-base.css`（新增）、`brief-button.js`（新增）。
- 提示词/任务：`spec/prompts/system-prompt.md`、`spec/prompts/brief-guide.md`（新增）、`cloud/seed/system/schedule.json`。
- 脚本/依赖：`cloud/scripts/migrate-0.5.mjs`（新增）、`probe-model.mjs`、`cloud/package.json`、`package-lock.json`；删除 `cloud/scripts/compact-instructions.mjs`、`migrate-0.4.mjs`。
- 文档：`cloud/docs/app-protocol-tasks.md`、`cloud/docs/v05-cloud.md`（本报告）。
- 测试新增：`cloud/test/migrate-0.5.test.mjs`、`prompt-v05.test.mjs`、`sdk-v05.test.mjs`、`settings-history.test.mjs`。
- 测试更新：`cloud/test/briefs.test.mjs`、`context-policy.test.mjs`、`harness.test.mjs`、`http-tasks.test.mjs`、`native-fixture.mjs`、`runtime-v04.test.mjs`、`schedule-fork.test.mjs`、`scheduler.test.mjs`、`sdk-context.test.mjs`、`sdk-tasks.test.mjs`；删除 `cloud/test/migrate-0.4.test.mjs`、`prompt-v04.test.mjs`。
