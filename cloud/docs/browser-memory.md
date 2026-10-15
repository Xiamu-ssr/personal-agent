# 浏览器部署与内存隔离

目标机是 Alibaba Cloud Linux 3 / RHEL 8，systemd 239，cgroup v1（hybrid），1.8G RAM、1G swap。本体是系统服务 `personal-agent.service`，`User=agent`。浏览器也使用常驻的系统服务，不依赖用户 manager。

## 进程与预算

```text
system.slice/
  ├─ personal-agent.service                 900 MiB
  │    Node + Agent SDK + HTTP/WS
  └─ personal-agent-browser.service         800 MiB，允许 swap
       常驻 Node host
       └─ 按需 Xvfb + Chrome（含临时缩略图上下文）
```

两项服务是兄弟 cgroup。Chrome、Xvfb 和缩略图压缩都由浏览器 host 派生，计入浏览器的 800M；本体不再派生另一套截图 Chrome。host 开机启动，只有浏览器工具、App 打开/接管或资源库截图才启动 Chrome。无操作 10 分钟后清理 Chrome/Xvfb，Node host 继续监听。观看画面、查状态不会延长空闲时间。

lead 在目标机实测的进程 PSS：知乎一页约 575 MiB，再开 B 站标签页约 740 MiB，Xvfb 约 13 MiB。这些是 lead 提供的容量依据，本轮没有连接服务器复测。生产控制器保留一个用户标签页；截图另建临时隔离上下文，完成即关闭，复用同一个 Chrome。PSS 与 cgroup 计费不同，800M 还要包括 host、页缓存及截图峰值，应按下面的 cgroup 数字验收。

两个 unit 同时写 `MemoryLimit=` 与 `MemoryMax=`，本体均为 900M、浏览器均为 800M。systemd 239 已支持 `MemoryMax`；其 legacy 路径会把该值写到 `memory.limit_in_bytes`，并兼容旧 `MemoryLimit`。两项设成相同值，避免版本差异造成歧义。[239 资源控制文档](https://raw.githubusercontent.com/systemd/systemd/v239/man/systemd.resource-control.xml)、[239 cgroup 实现](https://raw.githubusercontent.com/systemd/systemd/v239/src/core/cgroup.c)

不设置 `MemorySwapMax` 或 `memory.memsw` 限额，允许使用现有 swap；有效 swap 能力仍取决于内核和祖先 cgroup。239 的服务文档没有 `OOMPolicy`，unit 已移除该字段，使用该版本支持的 `Type=simple`。`KillMode=control-group` 用于停止/重启时清理整组，`Restart=on-failure` 用于 host 自身异常退出后重启；它们不承诺内核只杀 Chrome 子进程时整组立刻退出。[239 服务文档](https://raw.githubusercontent.com/systemd/systemd/v239/man/systemd.service.xml)

Chrome 退出或崩溃时 host 保持在线并清理 Xvfb；下次使用重开。本体通过私有的 `system/browser/service.json` 取得 loopback 地址、host PID 和随机鉴权值，核对私有文件权限与响应 PID 后连接。`system/browser` 与 profile 目录为 0700，状态文件为 0600；不要打印或复制其中的鉴权值。host 重启后重新发布端点，本体下次请求会重新读取。隔离模式不可用时明确报错，不回退到本体启动 Chrome。

本体仅 `Wants/After` 浏览器服务，没有 `Requires/BindsTo/PartOf`，浏览器停止不会停止本体。全局 OOM 或祖先 cgroup 更小的限额仍可能影响两者。900+800=1700 MiB 是上限之和，接近整机 RAM，不代表可同时占满；swap 会增加余量，也可能增加页面延迟。

## 部署

以下命令供 lead 在目标机运行，本轮没有执行。仓库安装位置为 `/opt/personal-agent`，数据根为 `/srv/agent`。

```sh
cd /opt/personal-agent
sudo bash cloud/deploy/browser-setup.sh
sudo bash cloud/deploy/install.sh
```

`browser-setup.sh` 安装 Chrome、Xvfb、字体与运行库。`install.sh` 要求 root，可重复执行；创建缺失的 agent 用户，安装本体及浏览器系统 unit，执行 daemon-reload，启用本体，并 `enable --now personal-agent-browser.service`。只启动轻量 Node host，不启动 Chrome，不自动启动或重启本体。

已有本体与依赖时，只更新浏览器 unit 可运行：

```sh
sudo bash cloud/deploy/browser-service-install.sh
```

该脚本同样要求 root，agent 用户须已存在；可重复执行，不调用用户 manager。对已运行的 host，`enable --now` 不会重新载入 Node 代码。更新后由 lead 选择时机手动重启 host 和本体：

```sh
sudo systemd-analyze verify /etc/systemd/system/personal-agent.service /etc/systemd/system/personal-agent-browser.service
sudo systemctl restart personal-agent-browser.service
sudo systemctl restart personal-agent.service
```

重启浏览器 host 会关闭当前浏览器；profile 保留。两个 unit 的 `User/Group`、`AGENT_ROOT` 必须一致。自定义 Chrome 路径时通过浏览器系统服务的 drop-in 设置 `AGENT_BROWSER_EXECUTABLE`；host 不加载本体的 EnvironmentFile。默认保留 Chrome 沙箱，目标机须验证用户命名空间沙箱与 `NoNewPrivileges=true` 配合正常。

## cgroup v1 验收命令

先验证实际服务状态与配置；不要以安装脚本退出成功代替运行验收：

```sh
systemctl --version
findmnt /sys/fs/cgroup
systemctl is-enabled personal-agent.service personal-agent-browser.service
systemctl is-active personal-agent.service personal-agent-browser.service
systemctl show personal-agent.service personal-agent-browser.service -p MainPID -p ControlGroup -p MemoryAccounting -p MemoryLimit -p MemoryMax -p Restart -p Result
swapon --show
free -m
```

找到 memory controller 的挂载点后读取 legacy 文件，不用 cgroup v2 的 `memory.current`：

```sh
task_memory_mount="$(findmnt -rn -t cgroup -o TARGET,OPTIONS | awk '$2 ~ /(^|,)memory(,|$)/ {print $1; exit}')"
test -n "$task_memory_mount"
for task_unit in personal-agent.service personal-agent-browser.service; do
  task_group="$(systemctl show "$task_unit" -p ControlGroup --value)"
  task_memory_dir="${task_memory_mount}${task_group}"
  echo "$task_unit"
  for task_counter in memory.limit_in_bytes memory.usage_in_bytes memory.max_usage_in_bytes memory.failcnt; do
    echo "$task_counter"
    cat "${task_memory_dir}/${task_counter}"
  done
  if test -r "${task_memory_dir}/memory.memsw.usage_in_bytes"; then
    echo 'memory.memsw.usage_in_bytes (RAM + swap)'
    cat "${task_memory_dir}/memory.memsw.usage_in_bytes"
    echo 'memory.memsw.limit_in_bytes'
    cat "${task_memory_dir}/memory.memsw.limit_in_bytes"
  fi
done
```

预期 limit 分别为 **943718400**、**838860800** 字节。`memory.usage_in_bytes` 是当前用量，`memory.max_usage_in_bytes` 是该 cgroup 生命周期内峰值；重建 unit/cgroup 后峰值会重置。`memory.failcnt` 记录触及限额的次数，不能单凭它认定发生 OOM。需要细看时再读同目录的 `memory.stat`、`memory.oom_control` 和 `journalctl -u personal-agent-browser.service`。`memory.memsw.*` 需要内核启用 swap accounting，缺失时不等于服务禁用了 swap。

确认进程归属与 PSS（有权限时以 sudo 读取）：

```sh
task_browser_group="$(systemctl show personal-agent-browser.service -p ControlGroup --value)"
task_browser_dir="${task_memory_mount}${task_browser_group}"
cat "${task_browser_dir}/cgroup.procs"
for task_pid in $(cat "${task_browser_dir}/cgroup.procs"); do
  cat "/proc/${task_pid}/cgroup"
  awk '/^Pss:/ {print FILENAME, $2 " kB"}' "/proc/${task_pid}/smaps_rollup"
done
```

首次启动时浏览器 cgroup 只有小型 Node host，不应有 Chrome/Xvfb。打开网页并截图后，host、Chrome、renderer、Xvfb 应全部归浏览器 cgroup，本体/SDK 在另一组。若存在子 cgroup，要连同其中进程一起核对。用真实页面、主聊天和后台任务同时运行，记录上述当前用量、峰值、swap 与 PSS；不要用各进程 RSS 相加代替独占物理内存。

通过 App 验证实时画面、接管、交还和资源库缩略图；确认截图不改变用户页。停止操作并等待超过 10 分钟，Chrome/Xvfb 消失，但浏览器服务保持 active。仅查状态或观看实时画面不能阻止回收。页面死循环导致截图超时时会关闭共享 Chrome，下一次浏览器工具重开；Node host 与本体保持运行，当前网页操作可能中断。

在可中断的测试窗口，可记录本体 MainPID，手动停止浏览器服务，确认本体 PID 和聊天会话不变，浏览器操作报错；再启动浏览器服务并调用工具，确认恢复。此步骤会中断浏览器，安装脚本不会自动做。没有在目标机执行限额/OOM 压测，不能据此宣称全局 OOM 不影响本体。

## 本机验证边界

macOS 不设置 `AGENT_BROWSER_SERVICE`，控制器继续直接懒启动系统 Chrome。测试使用假 host 验证私有通信、崩溃检测、空闲回收和缩略图并发；假 systemctl 验证 root 安装脚本可重复执行且不重启本体。另用真实 Chrome 的独立 host 子进程验证共享截图与关闭后 host 存活，真实 SDK 演示验证 macOS 直接懒启动、接管/交还继续与动态无需 Chrome 时不启动。

Linux systemd 239 的实际 unit 加载、cgroup v1 计费、Xvfb、沙箱和内存压力仍由 lead 按上述命令验收。本轮未连接服务器。
