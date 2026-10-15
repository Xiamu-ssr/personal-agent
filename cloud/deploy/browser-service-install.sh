#!/usr/bin/env bash
# Install the on-demand USER unit; never start Chrome during installation.
set -euo pipefail
task_deploy_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
task_systemd_version="$(systemctl --version | awk 'NR==1 {print $2}')"
[[ "${task_systemd_version}" =~ ^[0-9]+$ ]] && (( task_systemd_version >= 243 )) || {
  echo "浏览器隔离 unit 需要 systemd 243+，请先由管理员核对版本。" >&2
  exit 1
}
[[ -f /sys/fs/cgroup/cgroup.controllers ]] && grep -qw memory /sys/fs/cgroup/cgroup.controllers || {
  echo "浏览器内存隔离需要 cgroup v2 memory controller；请先由管理员确认，未修改启动参数。" >&2
  exit 1
}
task_agent_uid="$(id -u agent)"
task_agent_home="$(getent passwd agent | cut -d: -f6)"
sudo install -d -o agent -g agent -m 700 "${task_agent_home}/.config/systemd/user"
for task_unit in personal-agent-browser.service personal-agent-browser.slice personal-agent-thumbnail@.service; do
  sudo install -o agent -g agent -m 644 "${task_deploy_dir}/${task_unit}" "${task_agent_home}/.config/systemd/user/${task_unit}"
done
sudo loginctl enable-linger agent
sudo systemctl start "user@${task_agent_uid}.service"
sudo -u agent env "XDG_RUNTIME_DIR=/run/user/${task_agent_uid}" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${task_agent_uid}/bus" systemctl --user daemon-reload
echo "浏览器用户 unit 已安装（450M 上限），尚未启动；主服务下一次使用浏览器时才启动。"
