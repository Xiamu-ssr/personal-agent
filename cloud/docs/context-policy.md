# 云端上下文与压缩恢复（修订第 2 轮）

本轮只修改 cloud，没有提交、部署或访问服务器。本地审计版本是 Agent SDK **0.3.295**，附带 Claude Code **2.1.295**（manifest commit `07e8f67ea3282bf154a9e05673a0942b1b173cef`）。package 和 lock 都已固定 SDK 版本，升级时应重新核对本页的内部算法。

改动文件：`src/agent.mjs`、`src/config.mjs`、`src/context-policy.mjs`、`src/conversation-recovery.mjs`、`scripts/compact-instructions.mjs`、`scripts/probe-model.mjs`、`test/harness.test.mjs`、`test/context-policy.test.mjs`、`test/recovery.test.mjs`、`test/sdk-context.test.mjs`、`test/fake-anthropic.mjs`、`package.json`、`package-lock.json`，以及本报告。spec、Mac、Android 和部署配置均未修改。

## 32K 的来源与 thinking

CLI 模型规范化函数 `Cw/ZN` 识别 `claude-haiku-5-5`，不能直接识别当前网关名 `anthropic/claude-haiku-5.5` 的点号版本。未知模型的 `koe()` 默认输出 `Yv=32000`、上限 `_F=128000`；`tQt()` 读取 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`，再用 `SFe()` 按模型上限校验/截断。真实 SDK 配合本地假 API，已复现未修正时发出的 `max_tokens:32000`。

截图里的英文由 CLI 请求循环在 `stop_reason === "max_tokens"` 时生成，报出的数是该次请求的 `max_tokens`。因此它不是 Haiku 官方只支持 32K 的证明。

压缩的缓存共享分支 `_en → TA` 继承父 toolUseContext；回退分支 `_en` 直接使用 `CKe(context)` 和 `qh(context)`，继承 thinking/effort。用户怀疑的继承机制成立；[官方说明](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5)也确认 thinking 计入输出、max 会更长。但没有读取线上请求或 thinking usage，不能断言截图那次 32K 全被 thinking 消耗。

实现保留网关原名作为 wire model，通过 `settings.modelOverrides` 把它映射到规范模型能力；显式传入 128000。这是[普通 Messages 的上限](https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5)，没有使用 Batch 上限。

## 触发公式和总输入口径

记 `C` 为模型实际上下文窗口、`A` 为配置的压缩策略窗口、`O` 为生效的输出上限、`P` 为百分比覆盖：

```text
W = min(C, A)                         // dv()
E = W - min(O, 20000)                // p5()
T = E - 13000                       // $Y() 默认触发点
有合法 0 < P <= 100 时：
T = min(floor(E * P / 100), E - 13000)
估计下一请求输入 M >= T 时触发       // t9o() → Dae() → hLe()
```

`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 是 **A**，并非触发点，也不改变模型物理窗口 C；本版 CLI 将它限制在 100000–1000000，再与 C 取小值。`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 是 **E 的百分比**，仍受到 13000 摘要预留的限制。

默认策略如下，主会话、隔离任务和 SDK 子 agent 共用：

| 项目 | 值 |
| --- | ---: |
| 总输入价格目标 | 100000 |
| 工具/新消息增长余量 | 5000 |
| 实际软触发点 T | **95000** |
| Haiku 5.5 模型窗口 C | 1000000 |
| 输出上限 O | 128000 |
| 策略窗口 A | **128000** |
| 有效窗口 E | 108000 |
| 百分比 P | 100 |

因此 `128000 - 20000 - 13000 = 95000`。不是把上下文窗口设为 100K，也不是把 128K 输出全额从策略窗口扣除。较小输出模型用 `min(O,20000)` 重新计算 A，保持 T=95000。

输入是 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，系统提示词和已发送工具定义已经在这些数中，不额外相加。CLI 的 `Pre/FI/dLe/ym` 取最近模型调用的 usage，包含其输出（下一次会重发成历史），然后估算之后新增消息/工具结果的 tokens；有服务端 iterations 时取最后一个模型 message/fallback_message iteration，排除 compaction/advisor，而不是累计所有调用或 SDK result 的累计 usage。清除/裁剪还会有内部修正量。

所以这是 **95000 的下一请求输入估计线**，不是在每次请求前调用精确 token-count API 的硬收费闸门。大工具结果、新用户消息、长模型输出和估算误差可以跨过 100K。CLI 还有 `compact` 本身和 `RNe` 的内部助手源豁免（prompt_suggestion、away_summary、agent_summary、hook_prompt）；普通 SDK 主会话及 Agent tool 子 agent 的触发已实测，不能将配置视为所有内部辅助 HTTP 请求的硬拦截。压缩请求还会附加摘要指令并携带待整理历史；尤其首次恢复线上积累的旧会话时，它本身可能超过 100K，**那一次仍可能按高价档收费**。

## 精炼摘要与恢复

`PreCompact` 用 SDK 的 `applyFlagSettings` 临时设置 `effortLevel/maxEffortLevel=low`，`PostCompact` 恢复业务配置；子 agent 停止和下一轮派发也清理失败后遗留的覆盖。隔离任务改用单条 streaming input，因此同样可使用这个控制接口。控制是同一个 SDK 进程的 flag 层，重叠压缩按 agent 跟踪；压缩期间该进程并发请求也可能受 low cap 影响，主会话与隔离任务是不同进程。

保留 adaptive thinking，使用内置 `short` 摘要模板（`CLAUDE_CODE_CURRIED_TRINKET`），去掉默认模板要求另写 `<analysis>` 的长篇摘要思路。PreCompact command hook 追加中文要求：目标不超过 1500 tokens，保留历史要点、决定、记忆线索、文件路径、待办，省略重复内容与长工具输出。1500 是指令目标，SDK 没有公开的每次压缩单独硬输出上限；该请求仍允许 128K。

CLI 有输入过长自救：`zir()` 最多重试 3 次，`men/Sye` 按超限差值或约 20% 的旧消息组裁剪后重试；reactive 路径 `bye()` 也有差值指导的分组裁剪。真实 CLI + 本地 400 prompt-too-long mock 已验证后一次请求更短并成功。但输出耗尽或其他摘要错误不能靠裁剪输入保证解决。

兜底会检测 SDK status/local_command_output/assistant/result 或进程异常中的上下文失败，保留原文到遮罩日志，发中文提示「整理上下文失败，已重新开始对话，记忆不受影响」。只更新 state.json 的会话指向，用原子 600 文件保存有长度上限的近期聊天摘录和记忆指针，新 query 不再 resume 旧会话。旧 SDK transcript、完整 chat.jsonl、data/、待办和 schedule.json 全保留。

恢复摘要最多读取聊天尾部 256 KiB/40 条，摘录正文最多 12000 字符，附记忆文件路径和完整聊天档案指针。失败前尚未落入聊天档案的部分回复也会保存有长度上限的摘录，标注为未完成并要求核对实际文件。它是摘录式交接，较早且尚未写入记忆的细节不会全部进入新提示词，但仍可从原档案检索。已调用过工具的失败消息不自动重放；未调用工具的失败消息只自动重试一次；再次失败要求分批发送。手动 `/compact` 本身不重放。鉴权/额度/限流等普通错误只翻译，不清掉可恢复的 session ID。

## 配置与上线核验

新增配置：`AGENT_MAX_OUTPUT_TOKENS`（缺省按模型表）、`AGENT_MODEL_CANONICAL`（自定义网关名的能力映射）、`AGENT_CONTEXT_INPUT_LIMIT=100000`、`AGENT_CONTEXT_HEADROOM=5000`、`AGENT_COMPACT_EFFORT=low`。业务 `AGENT_EFFORT` 保持原值。未知模型必须显式给输出值；已知模型不允许配置超过正常 Messages 上限。

本地已验证真实 SDK 子进程继承 env、普通/隔离/子 agent 发出 128K、93K 缓存合计不触发/95K 以上触发、摘要 low/之后恢复 max、中文摘要指令、输入过长裁剪重试，以及真实 resume → 摘要输出耗尽 → 新 session → 自动继续。原待办内容、其它 state 字段、600 权限和错误翻译都有断言；连接器原有回归也运行。

`npm run check` 与 `npm test` 在本地 Node 20.19.4 和 Node 24.16.0 下均通过，38/38 项。本地是 macOS arm64，Linux 生产运行和真实长历史/摘要质量尚未验收。

真实 ZenMux 只尝试 **1 次**，短用户消息、128000 输出参数、adaptive + low。返回 **HTTP 400**，未返回 usage 或生成文本；当次请求还包含换行 stop sequence，之后探测脚本已简化去掉它，但没有再发请求。未采集到当次错误说明，因此 **不能确认网关接受 128K，也不能把 400 归因于该上限**。输入文本约数十 tokens，服务端未给出实际 token/费用，不能声称验证了扣费。脚本现在会遮罩并输出错误说明，供 Claude 在相同生产配置下核对。

Claude 上线时需要：

1. 用 lock 安装，确认 SDK 0.3.295/CLI 2.1.295。服务首次启动查看 `[sdk env] max_output=128000 compact_window=128000 compact_pct=100`，不要打印整个环境。
2. 用服务同一组模型/网关环境执行 `node scripts/probe-model.mjs`，确认 status=200、accepted=true，检查极短回复的 usage。脚本只请求 OK、effort=low。若仍失败，先按遮罩后的错误说明处理兼容/授权问题，不能把本地 mock 当网关验收。
3. 对已卡死主会话发送一句短消息，观察成功压缩，或中文恢复提示及新 session；确认能继续聊天并正确读取原记忆/待办。
4. 随实际使用检查 `[context]` / `[compact]` 元数据与网关该次 usage，确认缓存合计口径、接近 95K 的整理及整理后输入回落。Linux/ZenMux 集成和真实长历史摘要质量仍需上线验收，无需为了验收生成 128K 输出或灌入真实巨量历史。

## 本地 CLI 定位依据

以下字节位置指本地 `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` 的嵌入 JS，Linux 二进制偏移不同；应按函数名/常量定位同版逻辑。

| 逻辑 | 函数/标识 | 本地字节位置 |
| --- | --- | ---: |
| Haiku 5.5 1M/128K 能力表 | `id:"claude-haiku-5-5"` | 186673041 |
| 点号名没有规范化匹配 | `Cw/ZN` | 189068412 |
| 未知模型默认 32000/上限 128000 | `Yv/_F` | 189081369 |
| 输出值与 env 校验 | `koe/tQt`, `SFe` | 189084146, 188950646 |
| 最近 iteration 的 input/cache/output | `Pre/FI` | 190669112 |
| usage 锚点与新增消息估计 | `dLe/ym` | 195282681 |
| 摘要预留/百分比 | `$Y` | 195287596 |
| window env、输出预留和最终判断 | `dv/p5/Nie/Dae`, `t9o` | 195289091, 195290817, 197005749 |
| 压缩继承上下文 | `_en`, `TA`, `CKe` | 196989812, 196956823, 190603357 |
| 简短摘要模板选择 | `n3o/yye` | 196911300 附近, 196920166 |
| 输入过长重试/裁剪 | `zir`, `men/Sye` | 196977963, 196975113 |
| max_tokens 英文错误合成 | stop reason 分支 | 197278104 |

精确函数名以本版嵌入 JS 为准，不应把这些内部环境变量当成跨版本稳定的 SDK 公共接口。
