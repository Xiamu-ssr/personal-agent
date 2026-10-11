# 第 3 轮云端实现与验收记录（2026-10-11）

基于 `1294812`，依赖仍锁定 Agent SDK **0.3.295**；本机配套 native CLI **2.1.295**。没有修改 App、提交、推送、部署或 SSH。没有真实模型/邮箱调用，付费模型调用 **0 次、0 tokens**。

## 实现

1. **自发回合**：原生 `session_state_changed.running` 开始回合，与用户 dispatch 共用 `beginMainTurn`，重置 active、failure、reply、toolsUsed、compacting。`requires_action` 置忙，但不把回合间的等待误当成新回复。没有用户 envelope 的回合发 `reason: "task_result"`，active 为 null，失败恢复不会重放通知。每轮 SDK `init` 元数据也能识别还未 idle 的后续原生回合；不匹配聊天文本。
2. **结束和队列**：`result` 保存回复/发 `turn_end`；收到结果和原生 idle 后才解除 busy、派发下一条。支持 result 在 idle 前/后两种顺序。restore 控制请求 await 后再次检查 busy，防止该间隙自发回合抢先开始时交错输入。无状态事件的 mock/旧查询保留 result 兜底。自发回合进程异常结束也走中文失败/恢复路径。
3. **后台任务/停止**：新 `BackgroundTasks` 用原生 `background_tasks_changed` 完整替换运行集合，task edges 负责描述、进度、结果。过滤 ambient，保留 run_id 的新旧检查；进程起止清空列表，不持久化。主查询声明 `perTaskStopAffordance: true`，隔离维护没有 App 按任务控制，不作此声明。WS stop_task 和 HTTP stop 共用 `Harness.stopTask` → `main.q.stopTask(id)`，已结束/不存在/控制失败都返回中文结构化错误。
4. **简报**：cron、HTTP `/api/run` 共用 `runScheduledTask`，普通任务（含 `kind: brief`）调用 `harness.send(..., "schedule")` 进入同一 turnQueue。闹钟内容为 `[定时] 该出「<名称>」了` 加任务说明。提示词指示主 agent 派出后台 fork、简短确认；原生完成通知负责重新唤醒主会话。没有额外的人造回流消息。
5. **输出卡片**：主查询的 PostToolUse 传递 `agent_id`，按子任务收集 `data/briefs/` / `data/sites/` 下的 HTML outputs。任务通知结束时写一次 jobs/chat card，发原有 `job.done`；文件访问端点和 outputs 形状不变，只增加可选 `taskId`。失败/停止的已写文件标为未完成。
6. **维护**：compact、cleanup 分支保持原行为。设备重连的补读未改；调度/手动运行中以 `[补读]`、`[夜间整理]` 开头的任务也继续隔离。它们靠持久化数据和游标工作，不需要继承主聊天；避免长读写过程扩大主会话和 fork 的上下文。

## 必须配套的原生状态开关

三项 env 都在 Harness 的 SDK env overlay 中明确设置，主查询、隔离查询及其子 agent 继承；不读取/修改生产 env 文件：

| env | 值 | 核对得到的原因 |
| --- | --- | --- |
| `CLAUDE_CODE_FORK_SUBAGENT` | `1` | 使 headless SDK 可以用 fork；继承主会话上下文 |
| `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` | `1` | SDK 默认只设置 SDK_READS_SESSION_STATE；CLI 会给那种事件标 sdk_host_only，sdk.mjs 内部消费后不 yield 给 harness。显式 emit 才能观察原生帧 |
| `CLAUDE_CODE_BG_TASKS_REPORT_RUNNING` | `0` | CLI 默认把仍运行的后台 agent 也算作 session running，父回复结束后没有 idle。设置 0 后 busy 表示主线程；后台计数由任务 level 独立提供 |

本地真实 SDK 测试最初实证了“只有 running 没有 idle”的阻塞；设置后实证父回复 idle 且 fork 仍运行、用户可再发消息。测试也在实际 `spawnClaudeCodeProcess` 边界断言三个值，不只检查 options。

## SDK / CLI 依据

类型引用是已安装 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`；CLI 引用来自已安装的 `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` 内嵌 JS。以下 byte offset 是本机二进制位置，Linux 包偏移可能不同；函数/字符串可用来重新定位。未修改 node_modules。

| 事项 | 本地依据 |
| --- | --- |
| 原生回合开始/结束 | sdk.d.ts:5896–5906：state 为 idle/running/requires_action，idle 是 authoritative turn-over signal；CLI `notifyStateChanged`（byte 194400059 附近）按 EMIT 标志直接发布，否则 SDK_READS 标志发布 sdk_host_only；sdk.mjs 中 `if("sdk_host_only" in e && e.sdk_host_only===true) continue` 消费该帧 |
| busy 与后台分开 | CLI `oa()`（byte 221086327）：`return a.CLAUDE_CODE_BG_TASKS_REPORT_RUNNING!==false`。`F_` / `L_`（byte 221087259 附近）仅在 oa() 为真时因后台/待通知而阻止 idle；设 0 后由主线程结束逻辑发布 idle。后台等待/通知循环仍然存在，实际测试确认完成能自动再开回合 |
| 每轮元数据 | sdk.d.ts:5944 起的 SDKSystemMessage 说明 init 是每轮的 metadata，通常先于该轮其他消息；与 running 信号配合处理连续原生回合 |
| 后台集合 | sdk.d.ts:3708–3753：level 是完整替换；与 started/notification 的相对顺序不保证，进程启动没有初始 level，host 必须清空集合 |
| interrupt 边界 | sdk.d.ts:1788–1808：声明后 open-input interactive stream-json 保留后台 agents/workflows；未声明 fail closed；string prompt / stdin 关闭的一次性调用仍会杀 hold-back tasks |
| CLI 真正 interrupt 分支 | initialize 处理 `perTaskStopAffordance===true` 调用 `Dxo(true)`（byte 221653688）；`von()` 从 surfaceCapabilities 读取声明（byte 186184966）。控制器 `wn`（byte 221476672）分支：`if(von()) ... e$t(P) ... else ... mie(P)`，后者遍历并 kill 本地 agent/workflow。closed-input 的 `I_` / `Vp.release` 保留例外路径 |
| 按 id 停止 | sdk.d.ts:3216–3220 声明 `stopTask(taskId): Promise<void>` 并说明产生 status stopped 的 task_notification；sdk.mjs `stopTask` 发送 `{subtype:"stop_task",task_id:id}`；CLI control switch `case "stop_task"`（byte 192907364）检查 id 并调用注册的停止回调 |
| fork gate 与上下文 | CLI `gNo` / `hNo` / `Nte`（byte 196402682 附近）显式 env true 开 gate；内置 fork definition 的 model 为 inherit。`A8r`（byte 196403536）把父 Agent tool_use 配对成 fork 的 tool_result，并附 worker directive；任务启动的 `forceAsync: Jt`（byte 202462356 附近）支持后台。真实 HTTP fixture 的 fork 请求含父闹钟历史，证明流式模式继承有效 |

[Claude Code 官方环境变量文档](https://code.claude.com/docs/en/env-vars) 也说明 `CLAUDE_CODE_FORK_SUBAGENT=1` 能在 Agent SDK / `claude -p` 开启 fork。本轮以锁定版本的实际 CLI 和 fake 协议测试为准。

## App 协议

详见 [app-protocol-tasks.md](app-protocol-tasks.md)。新增 state/hello `tasks`、task snapshot、WS stop_task/task_stop 和 HTTP `/api/tasks/<id>/stop`。保留 task started/updated/progress/notification，结束 status 为 completed/failed/stopped。App 应以 snapshot 替换集合，按 id 幂等维护；busy 和后台数量分开。schedule 的 user 记录可隐藏气泡；task_result 允许无 user 先导的 delta。简报仍用 card / job.done / outputs / files 端点。

## 改动文件

- `cloud/src/agent.mjs`：原生回合、env、停止、fork 输出卡片。
- `cloud/src/background-tasks.mjs`：进程内 SDK 任务注册表和结构化错误。
- `cloud/src/scheduler.mjs`：闹钟/维护分流、共同手动入口、可测试 tick。
- `cloud/src/server.mjs`：state/hello、WS 和 HTTP 按任务停止、手动闹钟。
- `cloud/test/harness.test.mjs`：队列/状态重置、双向信号顺序、自发恢复、任务集合/停止失败与 restore 竞态。
- `cloud/test/http-tasks.test.mjs`：隔离 curl/WS 鉴权、停止/错误、手动简报和维护。
- `cloud/test/scheduler.test.mjs`：分钟去重、brief 闹钟、compact/cleanup/补读/夜间整理。
- `cloud/test/sdk-tasks.test.mjs`：真实 SDK/native CLI + 本地 fake-anthropic，fork/interrupt/stop/通知/卡片。
- `cloud/docs/app-protocol-tasks.md`、`cloud/docs/task-runtime.md`：客户端协议与本报告。
- `spec/prompts/system-prompt.md`：精炼的闹钟/fork/完成处理说明。

## 验证及边界

本地 **Node 20.19.4**：`npm run check` 通过；`npm test` **46/46** 通过（包括原有 connector、IMAP、95K 触发/128K 输出、压缩 retry 和 stuck-resume 恢复测试）。所有运行数据位于 `/tmp`，token/key 为测试假值，模型 API 只访问 loopback 的 fake-anthropic。

- 真实 SDK 流式调用：fork 带父历史、后台运行；父回复中 interrupt 后 fork 存活并完成；其完成通知自动产生主回合；该回合期间两条用户消息排队，通知回复先落盘，再按序处理用户。
- 真实 SDK stopTask：两个 fork 同时运行，只停 A 得到 stopped；B 继续完成；已结束/不存在清晰返回错误。
- 实际 HTML 由 native fork 的 Write 执行，hook 收到 agent_id，形成一张 card 和一次 job.done，outputs 可对应真实本地文件。
- mock 覆盖旧 failure/active/reply/toolsUsed 清空、自发上下文恢复不重放、result/idle 两种顺序、等待 restore 时 native turn 抢先开始、SDK 控制失败重试、CLI 进程结束后计数清空。
- curl/WS 覆盖鉴权、state/hello tasks、400/404/409、手动 alarm/隔离维护、错误后服务仍可用。

**未验证**：生产 ZenMux/Haiku 的模型是否每次遵从 fork 指令；真实设备/App UI、后台推送、生产 Linux CLI 的事件时序、跨服务重启的后台任务本身能否续跑。原生能力已验证，模型行为仍受提示词/权限配置影响。自动卡片依赖文件 hook，Bash 写文件不被收集；提示词要求 Write。CLI/query 重建会清空进程内任务集合，也可能终止原来的任务；本轮没有实现后台任务跨进程托管或自动重放。运行卡片和 data 文件不会因此删除。

没有偏离本轮约定的简报方案。维护保留隔离是明确选择；env 增加的两个状态开关来自锁定 CLI 的实际行为，是“主线程 busy、后台另计”正常运行所必需。SDK 升级时需要重查这些内部开关并重跑 native fake 测试。

## Claude 上线后验收

1. 保持 SDK lock 0.3.295，部署后重启服务使新 systemPrompt 生效。不需要修改生产 env；三个开关由 options 注入。
2. 手动触发一个极短简报（只写一张短 HTML，避免真实长调用），确认 `[定时]` 的 source 为 schedule；主会话简短确认，task started/snapshot 出现，父回复 idle 时 `/api/state` 可为 busy false 且 tasks 非空。
3. fork 运行时继续聊天并停止当前主回复，确认后台任务仍在；让任务完成，确认出现 task notification、busy task_result、主会话完成回复、chat card，App 能经现有 files 端点打开简报。
4. 通知回合正在输出时连发两条短消息，确认不混入该回合，结果顺序正确且 App 显示忙闲。
5. 同时运行两个小任务，通过 WS 和 HTTP 分别停其中一个，确认只收到该 id 的 stopped、另一个继续；重复停止检查 409，不存在检查 404。
6. 重启服务/断线重连，确认初始 tasks 为空/当前原生活动快照，不从旧卡片恢复计数；检查补读/夜间整理仍发隔离 job。压缩预算继承上一轮策略；若遇到自发回合压缩失败，确认中文恢复提示、data/记忆/待办保留且不自动重放通知。

# 第 4 轮：定时简报的运行层 fork 守卫（2026-10-11）

基于已提交的第 3 轮 `67023dd`。线上闹钟和 fork 能力已经生效，但提示词没有阻止模型直接在主线程做简报；本轮增加工具调用前的约束。本地没有提交、推送、部署、SSH 或真实模型调用，付费模型调用 **0 次、0 tokens**。

## 实现方式

- cron 和手动 `/api/run` 共用 `runScheduledTask`。闹钟保留 App 解析名称所需的 `[定时] 该出「<名称>」了` 前缀，紧接着明确要求 Agent（`subagent_type: "fork"`、`run_in_background: true`）后台派发，主会话只回一句简短确认，再附任务说明。系统提示词同步精简。
- `beginMainTurn` 保存本轮 reason，并重置派发标记、拒绝次数、fail-open 标记、日志标记及原始 fork 请求 id 集合。只在非隔离查询挂上新的 PreToolUse hook；只有仍开放的 schedule 主回合且 `agent_id` 为空时守卫才生效。
- 派发前仅允许参数严格正确的 Agent fork（兼容同一工具的旧名 Task），其他工具、普通 Agent、缺失/false/字符串形式的 background 值都返回中文 `permissionDecisionReason`。fork 放行后标记已派发，本轮后续工具不再受此守卫限制。子任务、user/task_result 回合、隔离补读和夜间整理照常运行；原有连接器和记忆路径守卫仍然执行。
- 第三次调用仍被拒绝，同时设置 fail-open；第四次及之后按原路径执行，避免模型反复选错工具造成死锁。fail-open 只解除本轮的 fork 守卫，下轮重新计数。它是明确的兜底：这一轮可能重新由主线程做简报。
- 在对应原生 `task_started` 到达后才记录成功派发日志，关联 task id 和 tool-use id。单纯放行、工具参数校验失败或模型口头说“已派出”都不算成功日志。原有后台 Write → outputs → task notification → `job.done`/chat card 路径不变，无 App 协议新增。

## SDK 0.3.295 的参数处理依据

一个容易误拦的细节：开启 fork 后，CLI 的 Agent 输入 schema 会移除 `run_in_background`。即使模型原始请求明确写了 true，PreToolUse 收到的已解析输入也没有该字段。守卫因此同时核对原生 assistant `tool_use`：仅记录严格请求 fork + boolean true 的 id；hook 的 background 被省略时，必须命中同一 id 且仍是 fork。没有原始凭据的省略值照样被拒绝，显式 false 也不能借原始记录放行。原始工具参数不写日志，只在本回合内保存匹配 id。

本机 native CLI **2.1.295** 的内嵌 JS 依据（byte offset 仅适用于本机 darwin-arm64 包；Linux 应按函数/字符串定位）：

| 依据 | 核对结果 |
| --- | --- |
| `sdk.d.ts:171–183`，`BaseHookInput.agent_id` | 仅子 agent hook 带 agent_id，主线程不带；应使用这个字段区分调用来源 |
| `sdk.d.ts:2741–2754` | PreToolUse 提供 tool_name、已解析 tool_input、tool_use_id；可返回 deny 及中文理由 |
| `sdk.d.ts:6098–6115` | task_started 提供 task_id、tool_use_id、subagent_type 和后台状态 |
| CLI `RFr`，byte **202452679** | `e=Bbr()||Nte()`，`y=e?n.omit({run_in_background:!0}):...`；fork gate 开启时移除该参数 |
| CLI `Nte`，byte **196403036**；`Jt`/`uo`，byte **202462733**/**202445494** 附近 | fork env 开 gate；主线程启动子 agent 使用 forceAsync，后台判定包含该值。本地任务事件和完成通知验证了实际后台运行 |
| CLI `yt="Agent"`、`em="Task"`，byte **190594125**/**190594427**；工具 definition `aliases:[em]`，byte **202484228** | Task 是同一个 Agent 工具的旧别名，不允许 TaskCreate/TaskUpdate 代替 fork |

真实 SDK + fake-anthropic 测试已直接断言 hook 中字段被移除、正确的原始请求仍能启动 fork；因此没有为了适配 SDK 而把“没有明确后台参数”当成合法请求。

## 改动文件

- `cloud/src/agent.mjs`：schedule 回合状态、PreToolUse 守卫、原始参数 id 关联、拒绝/派发日志。
- `cloud/src/scheduler.mjs`：闹钟中的明确后台 fork 指令。
- `cloud/test/schedule-fork.test.mjs`：新运行层守卫和真实 SDK/fake-anthropic 验证。
- `cloud/test/scheduler.test.mjs`、`cloud/test/http-tasks.test.mjs`：更新闹钟断言，覆盖原名称前缀、派发要求和任务正文。
- `cloud/docs/task-runtime.md`：本轮报告与上线检查点。
- `spec/prompts/system-prompt.md`：与闹钟要求一致的精炼说明。

## 实际验证

本地 **Node 20.19.4**：`npm run check` 通过，`npm test` **50/50** 通过。此前 46 项均保留通过，新增 4 项；全部模型流量来自 loopback fake-anthropic，测试数据、会话配置和假凭据只在 `/tmp`。

- 定时主线程先调 Bash：中文拒绝，命令没有执行；随后严格 Agent fork 被放行，父回合先结束，子任务仍在后台。
- fork 的 Bash 和 Write hook 带原生 agent_id，不消耗拒绝次数；实际 HTML 写入 `data/briefs/`，完成通知原生唤醒主会话，产生一次 `job.done` 和一张带 outputs 的 card。task_result 主回合的 Bash 也正常执行。
- 连续三次主线程 Bash 都被拒绝，第四次实际执行；fail-open 日志只出现一次，下个 schedule 的状态和计数重置。
- user 主回合 Bash 实际执行；严格参数、同 id 关联、子任务豁免、隔离 hook 不挂守卫及 user/task_result 的重置另有直接测试。
- cron、手动运行的名称前缀不变；既有 queue、interrupt/stopTask、压缩阈值、卡死恢复、连接器和假 IMAP 测试没有回退。

**未验证**：生产 Linux CLI/ZenMux/Haiku 对拒绝理由的实际响应，以及真实 App 打开卡片。守卫本身已经通过真实本地 CLI 验证；按要求没有真实模型调用，也没有部署。模型只输出文本、一直不调工具时，PreToolUse 无法强迫产生工具调用；被拒三次后的 fail-open 也允许原来的主线程路径。

## 上线后看这些日志

1. 重启服务载入新代码和提示词，手动触发一个只用 Write 生成短 HTML 的简报。闹钟前缀仍为 `[定时] 该出「<名称>」了`，主会话应简短确认，然后后台 task 出现。
2. 如果模型先尝试自己做，会出现 `[schedule] fork guard denied count=1 tool=Bash`（工具名和次数随实际调用变化）。被拒工具不应执行。正确派发必须随后出现 **`[schedule] fork dispatched task_id=<id> tool_use_id=<id>`**，可按 task id 关联原生任务 started/完成事件和简报 card。
3. **`[schedule] fork guard fail-open`** 表示本轮已经拒绝三次，后续放开，是兜底信号；正常派发不应出现这行。若频繁出现，保留该轮工具名称/次数及 task 事件供审查，不能把主会话口头确认当成成功派发。
4. 确认 fork 内的文件/连接器工具正常，完成后主会话转述、卡片打开实际 HTML；继续发普通用户消息，确认没有 schedule 拒绝日志。下一次闹钟的拒绝次数应从 1 重新开始。
