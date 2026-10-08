#!/usr/bin/env bash
# Run on the ECS from the repo checkout at /opt/personal-agent (as a sudo-capable user).
set -euo pipefail
cd /opt/personal-agent/cloud
npm ci --omit=dev 2>/dev/null || npm install --omit=dev
for f in src/*.mjs; do node --check "$f"; done

id agent >/dev/null 2>&1 || sudo useradd -m -d /home/agent -s /bin/bash agent
sudo mkdir -p /srv/agent && sudo chown agent:agent /srv/agent && sudo chmod 750 /srv/agent

if ! sudo grep -q '^AGENT_TOKEN=' /etc/personal-agent.env; then
  echo "AGENT_TOKEN=$(openssl rand -hex 24)" | sudo tee -a /etc/personal-agent.env >/dev/null
  echo "generated AGENT_TOKEN in /etc/personal-agent.env"
fi

sudo install -m 644 deploy/personal-agent.service /etc/systemd/system/personal-agent.service
sudo install -m 644 deploy/agent-location.inc /etc/nginx/agent-location.inc
sudo systemctl daemon-reload
sudo systemctl enable personal-agent >/dev/null 2>&1
sudo systemctl restart personal-agent
sudo nginx -t && sudo systemctl reload nginx
sleep 2
systemctl --no-pager --lines=5 status personal-agent | tail -6
