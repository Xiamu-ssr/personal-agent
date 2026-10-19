#!/usr/bin/env bash
# Claude runs this with sudo on Alibaba Cloud Linux 3 / RHEL 8 x86_64.
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo '请用 sudo 运行本脚本'; exit 1; }
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo '仅支持 Linux x86_64'; exit 1; }
browser_root=/opt/doudou-screenshot
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
dnf install -y curl unzip fontconfig python3 nss nspr atk at-spi2-atk at-spi2-core \
  cups-libs libdrm libX11 libXcomposite libXdamage libXext libXfixes libXrandr libXcursor libXi libXtst \
  libxcb libxkbcommon mesa-libgbm pango alsa-lib dbus-libs glib2 cairo expat libuuid
# Match the locked playwright-core release. Override only when testing another installed browser.
browser_version=${SCREENSHOT_CHROME_VERSION:-$(python3 - "$script_dir/../node_modules/playwright-core/browsers.json" <<'PY'
import json,sys
with open(sys.argv[1]) as f: browsers=json.load(f)['browsers']
print(next(b['browserVersion'] for b in browsers if b['name']=='chromium-headless-shell'))
PY
)}
[[ $browser_version =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo '浏览器版本号不正确'; exit 1; }

install -d -o root -g root -m 755 "$browser_root"
work_dir=$(mktemp -d /tmp/doudou-screenshot-install.XXXXXX)
trap 'rm -rf -- "$work_dir"' EXIT
if [[ ! -x $browser_root/chrome-headless-shell-linux64/chrome-headless-shell || ! -f $browser_root/version || $(cat "$browser_root/version") != "$browser_version" ]]; then
  curl --fail --location --retry 3 --connect-timeout 20 --max-time 300 \
    "https://storage.googleapis.com/chrome-for-testing-public/$browser_version/linux64/chrome-headless-shell-linux64.zip" -o "$work_dir/browser.zip"
  unzip -q "$work_dir/browser.zip" -d "$work_dir"
  rm -rf -- "$browser_root/chrome-headless-shell-linux64"
  mv "$work_dir/chrome-headless-shell-linux64" "$browser_root/"
  printf '%s\n' "$browser_version" > "$browser_root/version"
fi
# Noto's official repository supplies both Chinese font families even without EPEL.
font_dir=$browser_root/fonts
install -d -o root -g root -m 755 "$font_dir"
for family in Sans Serif; do
  font_file=Noto${family}CJK-Regular.ttc
  if [[ ! -s $font_dir/$font_file ]]; then
    curl --fail --location --retry 3 --connect-timeout 20 --max-time 300 \
      "https://raw.githubusercontent.com/notofonts/noto-cjk/main/$family/OTC/$font_file" -o "$work_dir/$font_file"
    install -o root -g root -m 644 "$work_dir/$font_file" "$font_dir/$font_file"
  fi
done
cat > /etc/fonts/conf.d/99-personal-agent-cjk.conf <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig><dir>$font_dir</dir></fontconfig>
EOF
chown -R root:root "$browser_root"
find "$browser_root" -type d -exec chmod 755 {} +
find "$browser_root" -type f -exec chmod 644 {} +
chmod 755 "$browser_root/chrome-headless-shell-linux64/chrome-headless-shell"
if [[ -f $browser_root/chrome-headless-shell-linux64/chrome_crashpad_handler ]]; then chmod 755 "$browser_root/chrome-headless-shell-linux64/chrome_crashpad_handler"; fi
fc-cache -f "$font_dir"
# Print missing library names only. Never inspect the service environment.
if ldd "$browser_root/chrome-headless-shell-linux64/chrome-headless-shell" | grep -q 'not found'; then
  ldd "$browser_root/chrome-headless-shell-linux64/chrome-headless-shell" | grep 'not found'
  echo '仍缺依赖库，请先补齐再启用截图'; exit 1
fi
"$browser_root/chrome-headless-shell-linux64/chrome-headless-shell" --version
fc-match 'Noto Sans CJK SC'
fc-match 'Noto Serif CJK SC'
echo '页面截图浏览器已安装，agent 用户只读；重启服务后即可使用。'
