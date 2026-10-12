# 豆豆 0.6.0 云端交接

本轮实现和本地验收完成，只编辑 `personal-agent/cloud/**`。未 commit、push、发布、部署或 SSH；未调用真实云端、模型、设备或 Wind 账号。仓库已有的 seed 角色改动由 Claude 提供，本 worker 未修改该文件；seed 定时表只增加健康同步项，保留 Claude 已改好的 prompt。

## 实现

### 简报与页面截图

- 写入校验改为每卡估算最多 960px、240 个元素，中文错误同步更新。`dates`、`tiles`、`metrics` 横排按一行计；`steps`、`compare` 按行数估算。读取和服务简报仍不检查高度。
- 基础 CSS 覆盖三套皮肤 × 四个配色；默认 silver，paper 标题宋体，night 正文字重较轻，数字用 tabular-nums。新增指南全部组件、推荐列高亮、18px 内边距、16px 圆角和轻阴影。
- `GET /api/briefs/item?path=` 返回完整单项，不限日期；非法路径、越界、符号链接逃逸和不存在的简报返回 404。
- 新增 in-process `mcp__page__screenshot({path,skin?})`：390px，逐卡用现有 `cardDocument` 文档截图再拼接；站点最多三屏。只允许本地简报和站点，拦 HTTP、公网资源、WebSocket、弹窗、WebRTC、service worker；站点本地资源限制在自身目录。JPEG 最多 300KiB。
- 全进程一次一个浏览器，每次启停，30 秒包含清理预算。关闭浏览器后才压缩图片；Sharp 单线程并关闭缓存。浏览器未安装返回「页面截图暂不可用」。
- 提供可重复运行的 `scripts/install-screenshot.sh`：安装 AL3/RHEL8 x86_64 依赖、匹配 Playwright 锁定版本的 Chrome Headless Shell、Noto Sans/Serif CJK；安装到 root 所有、agent 只读的 `/opt/personal-agent-browser/`。

### 模型与任务历史

- 删除运行时 MiMo，GLM 5.3 Flash 位于 Haiku 与 FlashX 之间；未知持久化模型重置 Haiku 并原子写回，保留权限设置。定价表和估算使用输入 $0.15、缓存读 $0.03、输出 $0.50 / 百万 token。缓存写入价格未在合同中指定，目前估算按输入计；估算日志不代表网关结算。
- `/api/jobs` 按 `before` 毫秒游标分页，默认 30、limit 1–100，无历史总数 50 条上限；只有首页带 running。同一毫秒的一组记录完整返回，可能略超 limit，防止下一页漏项。
- 启动扫描本数据根的 `system/sessions/projects/*/<session>/subagents/agent-<id>.jsonl`，只补缺失索引。标题取首次交代前约 40 字，首末时间戳、sessionId、结果推断状态写入索引；已有记录不覆盖。
- history 首条 prompt 标 `from:agent`，后续为 user；保留用户附件元数据，过滤 thinking、原始工具结果和图片 base64。
- 主聊天和任务续聊共用附件校验与消息拼装，限制到已上传文件，图片进入 SDK 消息块。附件续聊会移到隔离后台 query；若原任务仍运行，先请求停止原 worker。
- 原父会话不存在时，用标题、原交代、步骤摘要、结果和用户后续交代重建隔离后台任务，仍使用原 task id，旧 transcript 留在索引中。后续可 resume 新隔离会话；完成事件与设备通知保留，包括无文件产出的续聊。

### 健康、日历与启动迁移

- 每 3 小时的 `kind:health-sync` 直接调用在线且开启 health 的设备，不经过模型。先按合同请求 `{from:7天前,days:7}`；Android 的 from 含当天、这段范围结束于昨天，必要时再补今天一天，两次共享 20 秒预算。
- 指标按日期合并、取整，部分缺失不抹掉旧值；`data/health/days.json` 保留最近 90 天。离线、未开启或超时时保留数据，只更新中文 note。
- GET `/api/health` 打开页面时同步，POST `/api/health/sync` 手动同步，返回含今天的最近七天（空值 null）、全部健康周报和健康 Markdown 记录。周报范围为含简报当天的七天，summary 取第一张卡片 `.title`。
- 已有 PreToolUse 接入 `data/health` 写保护；允许读，拒绝 Write/Edit 等及可识别的 Bash 修改。连接器标记的技能目录同样受保护。Bash 检查属于现有 hook 层的保守拦截，未新增操作系统沙箱。
- 启动幂等补健康定时项、不动其他项；删除旧 `data/memory/health/latest.json`。除了迁移删除与测试 fixture，运行时代码不再读写旧文件。
- UserPromptSubmit 加两行短日历信息：农历、当天节气、工作日/周末/法定假日/调休及未来七天特殊日期。使用 `chinese-days@1.5.9`，验证 2026-10-01 国庆、10-08 寒露、10-10 调休；节假日数据需随包更新维护。
- 角色文件缺「说话习惯」才追加 seed 的该节，并更新第一行日期；其他正文逐字保留，有该节时不改。损坏的定时表报错，不覆盖。

### Wind AI

- 单账号、唯一 secret 字段 apiKey，文案按要求。七个远程 MCP 服务使用 SDK Streamable HTTP/Bearer；每次初始化、调用后关闭。401/403 返回「API Key 不对或已失效」，结果脱敏并限制长度。
- 常驻只暴露 `call`、`list_tools`、`list_skills`、`install_skill`、`ask_alice`，不注册几十个远程工具。
- 先读了官方三个 SKILL.md 和 Alice 请求脚本。Alice 同 Key 的 A2A/SSE `message/stream` 协议已实现并由 mock 验证；返回正文和附件引用，不自动下载附件。没有真实 Key，尚未证明账号权限、实际服务响应或积分计费。
- 通用 connector install/uninstall 钩子在账号验证成功后、删除最后账号及启动时执行。Wind 从指定 codeload URL 下载到数据根 `system/connector-cache/wind/`，SHA/version 检查，24 小时内相同版本复用缓存；解包禁止越界和链接，并限制体积。
- 自动装三项核心技能，额外技能按需安装。添加 MCP 调用说明、改写 CLI/发现方式、去除读 Key/配置和自更新脚本，保留业务说明与参考资料；用 `.connector-managed.json` 标记所有权。卸载仅删连接器自己的 Wind 技能，不覆盖或删除豆豆自行编写的同名技能。
- 官方技能正文只在临时/运行数据根中，未加入本仓库。实际只读下载时共发现 **78** 项（不是预估的 80 多项），三项核心和一项额外技能改写安装通过。证据见 `verification/v0.6/wind-install.json`，临时根 `/tmp/wind-v06-live-install-EXz8xn`。
- 图标取自 [Wind 官方 favicon](https://www.wind.com.cn/favicon.ico)，转换为 PNG。技能来源为 [Wind 官方仓库](https://github.com/Wind-Information-Co-Ltd/wind-skills)。

## 实际改动文件

以下路径都相对 `cloud/`；不包含 Claude 预先改好的 seed 角色文件。

| 用途 | 文件 |
| --- | --- |
| 简报 | `src/briefs.mjs`、`src/brief-base.css` |
| 截图 | `src/page-screenshot.mjs`、`scripts/install-screenshot.sh`、`scripts/verify-v06.mjs` |
| 模型/定价 | `src/app-settings.mjs`、`src/context-policy.mjs`、`src/usage-pricing.mjs` |
| 任务/附件 | `src/task-history.mjs`、`src/attachments.mjs`、`src/local-paths.mjs` |
| 健康/迁移/保护 | `src/health.mjs`、`src/calendar-context.mjs`、`src/migrate-v06.mjs`、`src/data-guard.mjs`、`seed/system/schedule.json` |
| 运行接入 | `src/agent.mjs`、`src/server.mjs`、`src/devices.mjs`、`src/scheduler.mjs`、`src/main.mjs`、`src/config.mjs` |
| 连接器 | `src/connectors.mjs`、`src/private-json.mjs`、`connectors/index.mjs`、`connectors/wind/index.mjs`、`connectors/wind/skills.mjs`、`connectors/wind/icon.png` |
| 依赖/版本 | `package.json`、`package-lock.json`（0.6.0；新增 chinese-days、playwright-core、sharp、tar） |
| 新测试 | `test/v06.test.mjs`、`test/v06-fixtures.mjs`、`test/sdk-v06.test.mjs`、`test/page-screenshot.test.mjs`、`test/wind-v06.test.mjs` |
| 更新既有测试 | `test/briefs.test.mjs`、`test/connectors-v04.test.mjs`、`test/context-policy.test.mjs`、`test/prompt-v05.test.mjs`、`test/runtime-v04.test.mjs`、`test/schedule-fork.test.mjs` |
| 协议/报告/证据 | `docs/app-protocol-tasks.md`、本文、`verification/v0.6/` |

## 本地验证

- **Node 20.19.4 下 `npm test`：100/100 通过，0 失败、0 取消、0 跳过**，约 15.5 秒。完整日志 `verification/v0.6/npm-test-node20.log`。
- `npm run check`、`bash -n scripts/install-screenshot.sh`、`git diff --check -- cloud 范围` 均通过。安装浏览器/字体的官方下载 URL 已验证可读取；未在本机跑 sudo 安装。
- 卡片测试包含 brief-guide 的 HTML 示例、三列六行耳机对比卡、步骤卡；超高/超元素数卡片被退回。真实 Chrome 检查全部十二种皮肤配色、paper 标题字体、整列高亮和 320px 无横向溢出。
- HTTP 假实例验证 briefs/item、分页/82 条回填及时间戳重复、history 来源和附件、健康接口/合并/超时/离线、迁移和鉴权。restart 续聊另用真实 Agent SDK + 本地假 Anthropic 服务，验证原任务上下文、图片块、新 transcript、原 id 和完成事件；不依赖生产模型。
- Wind 使用本地 SDK mock MCP/SSE 服务验证七服务的 test/list/call、错误、截断和 Alice；技能先用自写 tar fixture，再对官方仓库做只读真实下载和改写检查，没有执行官方脚本。
- 截图路径限制、符号链接逃逸、离线资源、外部 HTTP/WebSocket、最多三屏、无浏览器提示、恶意 JS 超时清理均覆盖。验收曾发现 1px 极小视口导致 Chrome 字体/帧等待挂住，已改为正常视口测量并补有界帧等待，修复后完整 Node 20 测试通过。
- 最终临时实例根：`/tmp/doudou-v06-verification-bdxsAy`。假 queryFactory 禁止模型调用，通过真实 in-process MCP 工具生成三张图；`/api/briefs/item` 返回三卡通过。

| 皮肤 | 截图 | 尺寸 | 文件大小 |
| --- | --- | --- | --- |
| silver | [silver.jpg](../verification/v0.6/silver.jpg) | 390×1242 | 39,486 B |
| paper | [paper.jpg](../verification/v0.6/paper.jpg) | 390×1242 | 39,499 B |
| night | [night.jpg](../verification/v0.6/night.jpg) | 390×1242 | 39,935 B |

三图已逐张查看，新组件、推荐列、步骤和皮肤均显示完整，无空白卡或重复截图。示例与机器结果在 `sample.html`、`result.json`。验收后无本任务残留截图浏览器、测试进程或 qemu；本轮没有启动模拟器。

## Claude 部署与后续验收

本地实现可交集成审查，线上操作尚未执行。Claude 部署时：

1. 在 cloud 目录使用 Node ≥20.9，执行 `npm ci` 安装锁定依赖；本次测试使用 20.19.4。
2. 执行 `sudo bash scripts/install-screenshot.sh`。脚本需访问官方 Chrome 和 Noto 下载源；服务 agent 用户不需要浏览器目录写权限。
3. 按现有发布流程重启服务。首次启动自动执行角色/模型/健康定时/旧健康文件迁移及缺失子任务回填，先核对迁移前后数据与原会话目录；已有任务记录和其他定时项保持。
4. 本地验证之外，仍需在 AL3 上确认依赖库、字体渲染、每次浏览器关闭以及 2 核/1.9G 机器的实际内存和耗时。Mac 结果不能证明服务器资源表现。
5. 获得真实 Wind Key 后由用户或 Claude 验证连接、七服务权限及 Alice；真实手机 health 授权/在线同步、重启后真实续聊通知和 Mac/Android 跨端效果需另做验收。未验证真实模型推理或计费。

