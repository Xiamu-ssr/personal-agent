#!/usr/bin/env bash
# Install and enable the system host. Chrome/Xvfb remain lazy.
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "请用 sudo bash cloud/deploy/browser-service-install.sh 运行" >&2; exit 1; }
task_deploy_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
id agent >/dev/null 2>&1 || { echo "请先创建 agent 服务用户，或运行 deploy/install.sh" >&2; exit 1; }
install -d -o agent -g agent -m 750 /srv/agent
install -m 644 "${task_deploy_dir}/personal-agent-browser.service" /etc/systemd/system/personal-agent-browser.service
systemctl daemon-reload
systemctl enable --now personal-agent-browser.service
echo "浏览器系统 host 已启用（800M，允许 swap）；Chrome 按需启动，未重启本体。"
