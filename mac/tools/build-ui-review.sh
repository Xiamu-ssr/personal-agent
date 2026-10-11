#!/bin/bash
# Local UI acceptance bundle only. No DMG, deployment or installation.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$PWD/verification/v0.4.0"
mkdir -p "$OUT"
BUILD_WORK=$(mktemp -d "$OUT/build.XXXXXX")
trap 'rm -rf "$BUILD_WORK"' EXIT
SDK=$(xcrun --show-sdk-path)
INC=$(dirname "$(xcrun -f swiftc)")/../include/swift
FIX=()
if [[ -f "$INC/module.modulemap" && -f "$INC/bridging.modulemap" ]]; then
  : > "$BUILD_WORK/empty.modulemap"
  INC=$(cd "$INC" && pwd)
  printf '{"version":0,"case-sensitive":"false","roots":[{"type":"file","name":"%s","external-contents":"%s"}]}' "$INC/module.modulemap" "$BUILD_WORK/empty.modulemap" > "$BUILD_WORK/overlay.yaml"
  FIX=(-vfsoverlay "$BUILD_WORK/overlay.yaml" -Xcc -ivfsoverlay -Xcc "$BUILD_WORK/overlay.yaml")
fi
SOURCES=()
while IFS= read -r source; do
  if [[ "${1:-}" == "--ui-contract" && ( "$source" == "Sources/Capabilities.swift" || "$source" == "Sources/DeviceClient.swift" || "$source" == Sources/Device/* ) ]]; then continue; fi
  SOURCES+=("$source")
done < <(rg --files Sources -g '*.swift' | sort)
NAME=DoudouUIReview
if [[ "${1:-}" == "--ui-contract" ]]; then
  SOURCES+=(tools/ui-capability-fixture.swift)
  NAME=DoudouUIContract
  echo "VALIDATION SCOPE: UI contract fixture; system capabilities excluded."
elif [[ -n "${1:-}" ]]; then
  echo "Only --ui-contract is supported." >&2; exit 2
fi
APP="$OUT/$NAME.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -swift-version 5 -O -parse-as-library -target "$(uname -m)-apple-macos14" -sdk "$SDK" "${FIX[@]}" "${SOURCES[@]}" -o "$APP/Contents/MacOS/Doudou"
cp Info.plist "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.xiamu.agent.mac.$NAME" -c "Set :CFBundleName 豆豆界面验收" -c "Set :CFBundleDisplayName 豆豆界面验收" -c "Set :CFBundleShortVersionString 0.4.0" "$APP/Contents/Info.plist"
if [[ -f build/豆豆.app/Contents/Resources/AppIcon.icns ]]; then cp build/豆豆.app/Contents/Resources/AppIcon.icns "$APP/Contents/Resources/"; fi
codesign --force --deep --sign - "$APP"
echo "$APP"
