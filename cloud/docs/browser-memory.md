# 浏览器部署与内存隔离

现有 `deploy/personal-agent.service` 的 `MemoryMax=900M` 覆盖整个服务 cgroup；直接 spawn Chrome/Xvfb，或只把它们放进这个服务下的子 cgroup，都无法绕过祖先上限。独立的用户 unit 由另一棵用户服务树派生，可以保留本体 900M，并给浏览器单独限额。有效上限仍取决于所有祖先设置，不能据此保证不会发生整机内存压力。[systemd 资源控制说明](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.resource-control.xml)

## 已准备的方式

```text
system.slice/personal-agent.service                 900 MiB
  Node + 主 SDK + 串行后台 SDK + HTTP/WS
  systemctl --user 只负责请求启动，不在这里派生 Chrome

user.slice/.../user@UID.service/
  personal.slice/personal-agent.slice/personal-agent-browser.slice
    ├─ personal-agent-browser.service              实时 Chrome + Xvfb + 小型 Node host
    └─ personal-agent-thumbnail@UUID.service        临时构件截图 + 压缩
  slice 合计：MemoryHigh=320M / MemoryMax=450M / MemorySwapMax=0
```

这两棵树不是父子。`systemd-run --user --scope` 也可以创建独立用户 scope，但需要自行维护进程归属、停止、端点与退出检测。本实现使用固定浏览器 unit 与截图模板，更容易核对 cgroup 和清理，不向服务用户授予启动任意系统 unit 的 root 权限。

- 主服务增加 `AGENT_BROWSER_SERVICE=personal-agent-browser.service`，900M 上限保留。
- CloudBrowser 使用 SystemdBrowserProcess，首次工具操作才 start 用户 unit。读取私有 `system/browser/service.json`，核对 MainPID 后连接 loopback CDP；不采用陈旧端点。每两秒检查 unit；退出/崩溃会通知控制器，下次工具调用重开。配置此模式时，用户服务不可用会明确失败，不退回主服务派生 Chrome。
- 独立 `browser/host.mjs` 管理原 BrowserProcess，不读主服务的 EnvironmentFile；Chrome、Xvfb 仍保留原先的 profile、默认沙箱和空闲关闭。需要自定义可执行文件时用用户 unit drop-in 设置 AGENT_BROWSER_EXECUTABLE。
- 资源库缩略图也经独立模板 unit 执行，保留原 HTTP/MCP 返回格式与截图限制，不再漏算进主服务的直接 Chrome 子进程。请求和 JPEG 经过私有临时目录交换，停止 unit 后删除。
- 浏览器与缩略图归同一个 slice，避免各自占满 450M 而使总预算翻倍。两者竞争内存时可能使其中一个浏览器任务失败，App 会收到现有错误格式；本体不在这个内存域内。
- unit 使用 KillMode=control-group、OOMPolicy=kill、Restart=no；超限时清理该 unit 全部成员，不自动反复重启。OOMPolicy 的 kill 会将该 unit 设为内存 OOM 整组终止。[systemd 服务说明](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.service.xml)

900+450=1350 MiB 是上限预算，不是实测用量；余量留给 OS、代理、用户 manager、页缓存等。browser worker 的 macOS 本地页报告 Chrome 进程 RSS 求和约 770–900 MiB，包含共享页重复统计，也不含 Linux Xvfb，不能据此推算 Linux 独占物理内存。**450M 是保守试运行值，复杂网页可能超限，当前没有证据保证目标机容量足够。** 先用真实业务页面测 PSS/峰值，再决定是否降低工作负载或增加主机内存；不要只提高所有上限。

## Lead 部署步骤

未在服务器执行以下命令。需要 systemd 243+、cgroup v2 的 memory controller、agent 普通用户、Chrome/Xvfb 和可用的 Chrome 沙箱。现有旧发行版可能不满足，应先核对；安装脚本遇到不满足会停止，不修改内核启动参数或自动关闭沙箱。

```sh
# 仓库根目录；浏览器安装与 user unit 安装互相独立
sudo bash cloud/deploy/browser-setup.sh
bash cloud/deploy/browser-service-install.sh
```

第二个脚本只安装用户 unit/slice、开启 agent linger、启动用户 manager 并 daemon-reload；不启动 Chrome、不重启本体。`deploy/install.sh` 已加入这一步，随后才照原流程更新本体 unit。linger 使用户未登录时仍有用户 manager，这是系统服务通过用户 bus 按需启动浏览器的前提。[loginctl 说明](https://raw.githubusercontent.com/systemd/systemd/main/man/loginctl.xml)

手动部署需另外安装更新后的 personal-agent.service 并按既有流程 reload/restart；不要把用户浏览器 unit 当成系统 unit 安装。修改 Chrome 路径、profile 根或沙箱选项时，在用户 unit 中配置，不能依赖主服务 EnvironmentFile 自动传入；自定义 AGENT_ROOT 时本体和两个用户 unit 必须一致。

目标机验收：

1. 核对 cgroup v2 与 systemd 版本，agent 的用户 bus 在无登录会话时可用；必要时检查 user@UID.service 是否委托 memory controller。
2. 确认本体 ControlGroup 在 system.slice，浏览器和截图在用户树的 personal-agent-browser.slice；实际读取 memory.max 为 450×1024×1024。若 memory controller 未生效，不把 unit 文件已保存当作隔离完成。
3. 同时运行主聊天、一个后台任务和已登录网页；测各进程 `/proc/PID/smaps_rollup` 的 PSS、两个 cgroup 的 memory.current、memory.events 和有则读取的 memory.peak。包括 Xvfb、host、renderer、截图，不只看 Chrome 主进程。
4. 测登录页、实时画面、接管、返回、缩略图和浏览器空闲清理。确认无 CDP/X11 公网监听、没有关闭默认沙箱，profile 权限仍为 0700。
5. 在独立测试实例触发浏览器 unit 停止/超限，核对本体 PID 和会话保持、App 错误可见、下一次浏览器工具能重开。全局 OOM、父级更小的限制和宿主机压力仍可能影响本体，不能宣称完全不会被内存问题牵连。

macOS 本地开发不设置 AGENT_BROWSER_SERVICE，继续由控制器懒启动系统 Chrome。仓库测试以假 systemctl 验证调用、PID/端点与失败清理；真 Chrome 演示验证 HTTP/WS/SDK 接线。Linux systemd、cgroup 内存与 OOM 故障隔离仍须 lead 目标机实测。
