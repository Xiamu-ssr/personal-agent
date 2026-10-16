#!/usr/bin/env bash
# Run as root from the checkout installed at /opt/personal-agent.
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "请用 sudo bash cloud/deploy/install.sh 运行" >&2; exit 1; }
cd /opt/personal-agent/cloud
dnf install -y poppler-utils python3.11 python3.11-pip
/usr/bin/python3.11 -m pip install pypdf pdfplumber python-docx openpyxl
chmod 755 deploy/bin/pip deploy/bin/pip3
npm ci --omit=dev 2>/dev/null || npm install --omit=dev
while IFS= read -r -d '' task_source; do node --check "${task_source}"; done < <(find src -name '*.mjs' -print0)

id agent >/dev/null 2>&1 || useradd -m -d /home/agent -s /bin/bash agent
install -d -o agent -g agent -m 750 /srv/agent
if ! grep -q '^AGENT_TOKEN=' /etc/personal-agent.env; then
  echo "AGENT_TOKEN=$(openssl rand -hex 24)" >> /etc/personal-agent.env
  chmod 600 /etc/personal-agent.env
  echo "generated AGENT_TOKEN in /etc/personal-agent.env"
fi

install -m 644 deploy/personal-agent.service /etc/systemd/system/personal-agent.service
install -m 644 deploy/agent-location.inc /etc/nginx/agent-location.inc
bash deploy/browser-service-install.sh
systemctl enable personal-agent.service
nginx -t && systemctl reload nginx
echo "系统 unit 已安装，本体未重启；lead 核对后执行 systemctl restart personal-agent.service。"
