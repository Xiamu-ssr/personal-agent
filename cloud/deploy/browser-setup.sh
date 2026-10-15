#!/usr/bin/env bash
# Alibaba Cloud Linux 3 / RHEL 8 family. Run manually with sudo; no service restart.
# Chrome + Xvfb + libraries + CJK fonts: about 0.8-1.5 GiB installed.
# Allow 2 GiB free for package downloads, then reserve profile/download space separately.
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "请用 sudo bash cloud/deploy/browser-setup.sh 运行" >&2
  exit 1
fi
command -v dnf >/dev/null || { echo "需要 Alibaba Cloud Linux 3 / RHEL 8 的 dnf" >&2; exit 1; }
task_arch="$(uname -m)"
dnf -y --setopt=install_weak_deps=False install \
  xorg-x11-server-Xvfb fontconfig liberation-fonts \
  gtk3 nss alsa-lib at-spi2-atk mesa-libgbm libX11 libXcomposite libXdamage libXrandr

task_font=""
for task_candidate in google-noto-sans-cjk-ttc-fonts google-noto-sans-cjk-fonts wqy-microhei-fonts wqy-zenhei-fonts; do
  if rpm -q "$task_candidate" >/dev/null 2>&1 || dnf -q list --available "$task_candidate" >/dev/null 2>&1; then
    dnf -y --setopt=install_weak_deps=False install "$task_candidate"
    task_font="$task_candidate"
    break
  fi
done
if [[ -z "$task_font" ]]; then
  echo "当前仓库缺少中文字体。请启用本机发行版的字体仓库后重跑；未自动添加 EPEL。" >&2
  exit 1
fi
fc-cache -f

task_browser=""
for task_candidate in google-chrome-stable google-chrome chromium chromium-browser; do
  if command -v "$task_candidate" >/dev/null; then task_browser="$task_candidate"; break; fi
done
if [[ -z "$task_browser" && "$task_arch" == "x86_64" ]]; then
  # dnf verifies Google's package signatures using the official signing key.
  cat > /etc/yum.repos.d/personal-agent-chrome.repo <<'REPO'
[personal-agent-chrome]
name=Google Chrome for Personal Agent
baseurl=https://dl.google.com/linux/chrome/rpm/stable/x86_64
enabled=1
gpgcheck=1
gpgkey=https://dl.google.com/linux/linux_signing_key.pub
REPO
  dnf -y --setopt=install_weak_deps=False install google-chrome-stable
  task_browser="google-chrome-stable"
elif [[ -z "$task_browser" ]]; then
  if dnf -q list --available chromium >/dev/null 2>&1; then
    dnf -y --setopt=install_weak_deps=False install chromium
    task_browser="chromium"
  else
    echo "此架构的现有仓库没有 Chromium，请先配置发行版支持的浏览器仓库再重跑。" >&2
    exit 1
  fi
fi

command -v Xvfb >/dev/null
"$task_browser" --version
echo "浏览器、Xvfb、中文字体（${task_font}）已就绪；未启动或重启服务。"
echo "安装量约 0.8-1.5 GiB；profile、下载和 dnf 缓存另计。"
echo "Chrome 默认保留沙箱，以普通服务用户运行。模块按需创建 profile 和下载目录。"
