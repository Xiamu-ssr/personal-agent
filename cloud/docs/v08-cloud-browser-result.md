# v08-cloud 第二轮 result

三项后续已在仓库完成：动态说明按运行上下文授权、浏览器接入 SDK 与 App、systemd 独立内存域和启动方式。版本仍为 0.8.0；没有 commit/push/tag、部署、SSH、真实账号操作或密钥文件读取。当前对接协议见 [v08-cloud.md](v08-cloud.md)，部署评估见 [browser-memory.md](browser-memory.md)。

## 1. 动态说明权限

- 主聊天、首次聊天、点子及其他运行可写 `data/feed/动态说明.md`；只有以 `[动态]` 触发的独立后台运行及其原生 fork 拒绝写入。原始 health/uploads 和连接器技能仍只读。
- 限制随当前运行上下文传给 PreToolUse，不根据用户在主聊天里提到「动态」就锁文件。一次动态结束后，用户从活动页发起的普通续聊属于新运行，不永久继承只读标记。
- 文件工具和 Bash 检查同步更新，覆盖真实路径、符号链接别名、写入/删除；Bash 仍是保守工具守卫，不是 OS 沙箱。
- App 的 `GET/PUT /api/feed/settings` 原样保留。模型改说明后沿用 files_changed 事件，App 重读设置即可。
- 没有修改系统提示词或其他 spec 文件；上一轮 result 中的提示词写权限冲突已通过本轮守卫调整解决。

## 2. 浏览器接线

- Harness 创建一个 CloudBrowser，主聊天、原生 fork、独立后台会话和 App 路由共享；每个 SDK query 各建一个 MCP transport，允许 `mcp__browser__*`。
- 工具、状态查询和画面订阅均懒启动。动态也得到工具，但工具说明限定为读取用户已登录的网站；动态 request_takeover 直接返回普通 blocked，不打断用户要求登录。网页是否仍有可用登录状态由模型读取页面判断，没有伪造自动登录检测。
- server 在原有 catch-all 和 WS handler 注册后挂载 attachBrowserRoutes，复用现有 Bearer/cookie 鉴权。原 `/api/browser/*`、`/ws/browser` 结构不变。
- 通过真实 MCP tool-use 元数据记录当前执行工具的会话，排队中或接管期间被挡的调用不会抢走交还归属。原生 fork 按 agent_id 对应的活动继续。
- 交还事件注入内部 `[浏览器交还] 用户已交还浏览器，请重新读取页面后继续原来的工作。不要重复已经完成的点击或提交。`。主聊天直接走原 AsyncIterable，独立后台等待接管时保留 query 和 inbox；提前交还的唤醒在当前 result 后送入同一流。后台继续不占主聊天，也不生成虚假的用户聊天气泡。
- 原生 fork 沿既有 SendMessage 路径继续；已结束/重建的会话可通过活动持久上下文恢复。单独停止等待中的活动会关闭流并取消自动续聊。退出清理包括 SDK、浏览器、WS 与安排。
- 浏览器工具的头像文字为「在浏览网页」；接管期间 waiting 优先，交还后继续 working。
- `{type:"browser"}` 仍不需要 sessionId 或额外字段，始终打开当前共享浏览器会话。历史卡片不会恢复历史页面。

**协议没有破坏性改动**：没有改已有 HTTP/WS 路径、字段、卡片格式或返回结构；浏览器路由现在实际挂载。v08-cloud.md 补全了现有浏览器协议链接、唤醒行为、waiting 含义和动态说明新权限。browser.md 未修改，其「Lead 接线」示例中的旧排队说明不适用于当前 Harness；当前实现使用输入流。

## 3. 内存与部署建议

采用独立的 **agent 用户 unit**，不把 Chrome 放进仍属于本体 900M 祖先域的子 cgroup：

| 资源 | 配置 |
| --- | --- |
| system manager 的 personal-agent.service | 保留 MemoryMax=900M，Node、SDK、HTTP/WS |
| user manager 的 personal-agent-browser.slice | 合计 MemoryHigh=320M、MemoryMax=450M、MemorySwapMax=0 |
| personal-agent-browser.service | 实时 Chrome/Xvfb/小型 Node host，属于上述 slice |
| personal-agent-thumbnail@UUID.service | 现有构件截图 Chrome 与压缩，属于同一 slice |

把缩略图也搬出主服务，避免只隔离实时浏览器却漏掉另一条 Chrome 派生路径。按需启动、MainPID/端点核对、崩溃检测、独立 unit 停止与下次重开均已实现；配置隔离模式时失败会报错，不悄悄退回本体启动 Chrome。OOMPolicy=kill、KillMode=control-group、Restart=no 负责清理单个浏览器 unit，避免反复重启。

主 unit 增加 AGENT_BROWSER_SERVICE。安装脚本安装用户 unit/slice，启用 agent linger、准备用户 manager 和 daemon-reload，但不启动 Chrome；既有 install.sh 已调用该步骤。需要 systemd 243+ 和 cgroup v2 memory controller，脚本会检查，不自动修改内核启动参数。浏览器包安装仍由 browser worker 的 browser-setup.sh 负责，本轮未修改该脚本。

**这不是容量实测结论。** 900+450=1350 MiB 为上限预算，OS/代理等另计。browser worker 本机 Chrome RSS 求和约 770–900 MiB，含共享页重复统计，不能推算 Linux PSS。450M 是保守试运行值，复杂页面或同时截图可能使浏览器任务失败；需按 browser-memory.md 在目标机测 PSS、cgroup 峰值与 OOM。全局 OOM 或更小的祖先限制仍可能影响本体，不能保证永不连累。没有连接服务器、安装 unit、改变 linger 或执行 OOM 压测；本机 macOS 无 Linux cgroup 验收。

## 验证

| 检查 | 实际结果 |
| --- | --- |
| `cd cloud && npm test` | **168/168 通过**；0 失败、取消、跳过，包含 browser worker 原有测试 |
| 全部 `.mjs` 的 `node --check` | **100/100 通过**，排除 node_modules/Git 元数据 |
| `npm --prefix cloud run check` | 通过 |
| `bash -n` 两个安装脚本 | 通过；未执行安装 |
| `git diff --check -- cloud` | 通过 |
| 假模型 + 真实 SDK + 真 Chrome 演示 | 主聊天与独立后台两条接管/交还链路通过 |

新增测试覆盖：不同运行的写权限与后续用户续聊、浏览器 transport 独立/控制器共享、动态不唤起 Chrome/接管、主聊天忙时与 idle 后交还、后台提前/延后交还、原生 fork 精确归属、排队工具不抢归属、停止等待中的活动、HTTP 鉴权与原有路由共存、独立 unit 的启动/PID/陈旧端点/崩溃/失败处理、缩略图任务交换与清理。systemd 调用用本地假 systemctl 验证，不声称运行了真实 Linux unit。

## 真 Chrome 演示

```sh
node cloud/scripts/verify-v08-browser.mjs
```

本机真 Chrome 使用独立临时 profile 和本地 HTTP 页，不访问个人 profile、真实网站或服务器。日志在 `/tmp/v08-cloud-demo/browser/`：demo.log、events.jsonl、browser-events.jsonl、summary.json、main-takeover.jpg、background-takeover.jpg，以及最终 npm-test.log/node-check.log/checks.log。实时帧日志只保存元数据，不保存 base64 帧正文。

关键输出：

```text
MCP + App HTTP/WS connected; Chrome launches=0 (lazy)
main: real Chrome opened local page -> request_takeover -> avatar=waiting; authenticated live frame=1280x800
main: App click -> return=200 -> original query received [浏览器交还] -> snapshot sees USER_CONFIRMED -> say result
background: real Chrome opened local page -> request_takeover -> avatar=waiting; authenticated live frame=1280x800
background: App click -> return=200 -> original query received [浏览器交还] -> snapshot sees USER_CONFIRMED -> say result
background return stayed in isolated SDK stream; main busy=false; no fabricated user chat bubbles
feed with browser tools and no browser calls: no Chrome restart
```

结果：SDK 0.3.295，真实 Chrome；总启动一次，交还两次，两条原始输入流均复用；主聊天仅一条真实用户消息；收到 1280×800 实时画面；关闭浏览器后跑不需浏览器的动态，没有重启 Chrome。原生 fork 的浏览器交还路由由 MCP 元数据测试覆盖，真 Chrome 演示覆盖的是主聊天和独立后台，未另做原生 fork 的真 Chrome 演示。没有 Android/Mac UI、真实通知权限、Linux 沙箱/登录/OOM/长期负载验收。

## 本轮文件清单

- 修改核心：`src/agent.mjs`、`data-guard.mjs`、`avatar.mjs`、`server.mjs`、`main.mjs`、`page-screenshot.mjs`。
- **修改 browser worker 原模块**：`src/browser/mcp.mjs` 增加执行开始的归属回调、动态说明与不接管策略；`src/browser/browser.mjs` 增加可选 systemd manager、工具实际开始时的 onStart 和接管竞态复查。没有修改其 process.mjs、input.mjs、routes.mjs、demo.mjs、browser.test.mjs 或 browser.md。
- 新增 browser 模块：`src/browser/systemd-process.mjs`、`src/browser/host.mjs`。
- 新增截图隔离：`src/screenshot-service.mjs`、`src/screenshot-host.mjs`。
- 修改部署：`deploy/personal-agent.service`、`deploy/install.sh`；新增 `deploy/personal-agent-browser.service`、`personal-agent-browser.slice`、`personal-agent-thumbnail@.service`、`browser-service-install.sh`。
- 新增验证：`scripts/verify-v08-browser.mjs`、`test/browser-integration.test.mjs`、`browser-systemd.test.mjs`、`sdk-browser.test.mjs`；修改 `test/v08-content.test.mjs`、`environment.mjs`。
- 文档：更新 `docs/v08-cloud.md` 与上一轮 result 的后续入口；新增 `docs/browser-memory.md` 与本 result。
- 没有修改 spec、Android、Mac、design、handoff 工具，也没有重置其他 worker 的变更。
