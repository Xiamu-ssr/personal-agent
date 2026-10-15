# v08-cloud：systemd 239 浏览器部署 result

已按 lead 核实的目标机改为两个独立系统服务：本体 900M，常驻浏览器 host 800M、允许 swap。浏览器和截图共用 host 中的一套 Chrome。版本仍为 0.8.0，App 协议无字段或路径变更。没有连接服务器、执行实际安装或重启、读取真实密钥、commit/push/tag。

## 实现

- `personal-agent-browser.service` 为 `User=agent`、`Group=agent`、`Type=simple`，开机启动小型 Node host。Chrome/Xvfb 仍按需启动，10 分钟无操作后关闭；host 不退出。Chrome 崩溃后下次使用重开。
- 本体通过 loopback 和私有 `system/browser/service.json` 调用 host，核对文件权限、所有者、地址及响应 PID。状态查询不启动 Chrome；本体不再调用 systemctl。配置隔离模式时失败会报错，不回退到本体派生 Chrome。
- 缩略图经同一 host，在同一 Chrome 的临时隔离上下文内渲染。仍只允许本地构件、阻断外部 HTTP/WebSocket，单次截图串行；完成后关闭上下文。真实测试确认截图不关闭或导航用户页，也不另开 Chrome 进程树。host 延迟加载 Playwright 和图片处理依赖，空闲启动不加载这些重模块。
- 浏览器 unit 同时写 `MemoryLimit=800M`、`MemoryMax=800M`；本体两项均为 900M。移除 swap 禁令、OOMPolicy 和过新服务类型。239 官方服务文档未提供 OOMPolicy，资源控制实现支持在 legacy hierarchy 将 MemoryMax 写到 memory.limit_in_bytes，来源及解释见 [browser-memory.md](browser-memory.md)。
- `KillMode=control-group` 处理停止时的整组清理，`Restart=on-failure` 处理 host 异常退出。本体仅 Wants/After 浏览器，没有停止绑定。内核若只杀子进程，不宣称 host 必然退出；全局 OOM 或更小祖先限额仍可能影响本体。
- 两个安装脚本要求 root、可重复运行。完整安装启用本体但不启动或重启它；浏览器 `enable --now` 启动 Node host。重复安装不会重启已运行的 host，lead 更新代码后按文档手动重启 host，再选择时机重启本体。

## 删除与协议

删除 `deploy/personal-agent-browser.slice`、`deploy/personal-agent-thumbnail@.service`、`src/screenshot-host.mjs`，移除运行时用户 manager 调用、用户服务安装流程及其部署说明。缩略图不再创建临时截图 job 目录或单独截图进程。

App 的 `/api/browser/*`、`/ws/browser`、实时帧字段、接管/交还、say 的 browser 卡片均保持原样。只改变 host 私有通信格式，不保留旧 host 格式的兼容读取。`v08-cloud.md` 仅更新部署说明；旧接线 result 的内存段已替换为当前文档入口，避免按旧方案部署。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| `cd cloud && npm test` | **184/184 通过**，0 失败、取消、跳过；包含所有 browser 测试 |
| 本次浏览器、截图定向测试 | **31/31 通过**，包含真实 Chrome host 子进程 |
| 全部 `.mjs` 的 `node --check` | **106/106 通过**，排除依赖目录 |
| `npm run check` | 通过 |
| `bash -n deploy/install.sh deploy/browser-service-install.sh` | 通过 |
| `git diff --check -- cloud` | 通过 |
| 原有假模型 + 真实 SDK + 真 Chrome 演示 | 主聊天、独立后台均完成打开、接管、交还、继续 say；macOS 仍直接懒启动 |

新增/更新测试覆盖：host 启动无 Chrome、私有端点权限和鉴权、缺失/陈旧端点拒绝且不回退、Chrome 崩溃与重开、关闭 Chrome 后 host 存活、查状态不阻止空闲回收、缩略图共享 host 和并发拒绝、239 unit 的资源配置、root 安装脚本拒绝非 root 并可重复执行。systemctl/install/id 由本地假命令替代，未操作本机系统服务。

真实 Chrome 的 host 测试另起 Node 子进程：先确认 endpoint 为 null，打开用户页，再请求资源库缩略图，验证 CDP endpoint 不变、用户页标题不变；关闭浏览器后确认 host PID 不变且状态查询仍可用。

## 演示输出

运行：

```sh
node cloud/scripts/verify-v08-browser.mjs --output /tmp/v08-cloud-demo/browser-system-service
```

日志与验证产物已另存到 **`/tmp/v08-cloud-demo/browser/system-service/`**，不覆盖前一轮演示：`demo.log`、`events.jsonl`、`browser-events.jsonl`、`summary.json`、两张接管截图、`npm-test.log`、`browser-tests.log`、`node-check.log`、`checks.log`。日志没有个人目录路径；浏览器帧日志只保存元数据。

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

结果为 `ok=true`，SDK 0.3.295，Chrome 共启动 1 次，交还 2 次，收到 4 帧（1280×800）；两条原输入流均复用，主聊天只有 1 条真实用户消息。页面、模型和 profile 均为本地隔离 fixture，没有使用真实网站登录或个人 Chrome profile。

## 本次文件

- 浏览器模块（本轮获准修改）：`src/browser/browser.mjs` 同步 host 空闲计时并区分用户页与缩略图隔离页；`host.mjs` 改常驻入口；`systemd-process.mjs` 改为 loopback 客户端；新增 `service-host.mjs`、`service-client.mjs`。没有修改浏览器 MCP、App 路由或输入协议。
- 截图：修改 `src/page-screenshot.mjs`、`src/screenshot-service.mjs`；删除 `src/screenshot-host.mjs`。
- 部署：修改 `deploy/personal-agent.service`、`personal-agent-browser.service`、`install.sh`、`browser-service-install.sh`；删除上述 slice 和缩略图模板。
- 测试：重写 `test/browser-systemd.test.mjs`，旧用户服务 fixture 换成常驻 host 与系统安装 fixture。
- 文档：更新 `docs/browser-memory.md`、`browser.md`、`v08-cloud.md`、`v08-cloud-browser-result.md`；新增本 result。
- 保留其他轮次及其他 worker 的现有改动，没有修改 spec、Android、Mac、design 或 handoff 工具。

## Lead 部署提醒与边界

完整命令见 [browser-memory.md](browser-memory.md) 和 [browser.md](browser.md)。部署后先核对两个 unit 的 ControlGroup 与 `memory.limit_in_bytes`：本体 943718400、浏览器 838860800；再记录 `memory.usage_in_bytes`、`memory.max_usage_in_bytes`、swap 与 PSS。浏览器服务 active 时 Chrome 未必已启动，这是懒启动的预期状态。

lead 提供的知乎约 575 MiB、加 B 站约 740 MiB、Xvfb 约 13 MiB 为本次容量依据，本轮未复测。800M 还包含 host、页缓存和截图峰值；两个上限之和接近 RAM，不能视作同时满载稳定性的证明。页面死循环导致截图超时会重置共享 Chrome，当前网页操作可能中断；本体和 host 保持运行，下次工具重开。

Linux unit 的实际加载、cgroup v1 生效、Xvfb、沙箱、swap 压力与 OOM 隔离仍需目标机验收。本机 macOS 验证没有代替这些检查；不需要修改系统提示词或 App 接口。
