#!/bin/bash
# Build 豆豆.app (universal, fixed local identity) with only the Command Line Tools.
#   bash mac/tools/make-signing-identity.sh   # user runs once; may show Keychain dialogs
#   VERSION=1.2.0 bash mac/build.sh         # -> mac/build/doudou-1.2.0.dmg
set -euo pipefail
cd "$(dirname "$0")"
VERSION=${VERSION:-1.2.0}
BUILD=${BUILD:-7}
OUT=${OUT:-build}
APP="$OUT/豆豆.app"
SIGNING_IDENTITY=""
if [[ "${DOUDOU_SKIP_SIGNING:-0}" != "1" ]]; then
  SIGNING_IDENTITY=$(security find-identity -v -p codesigning | awk '/"Doudou Local Signing"/ {print $2; exit}')
  if [[ -z "$SIGNING_IDENTITY" ]]; then
    echo "找不到 Doudou Local Signing 代码签名身份。请先运行：bash personal-agent/mac/tools/make-signing-identity.sh" >&2
    exit 1
  fi
fi
rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
OUT=$(cd "$OUT" && pwd)
APP="$OUT/豆豆.app"
SDK=$(xcrun --show-sdk-path)

# Some CLT installs ship a stale usr/include/swift/module.modulemap next to bridging.modulemap, which
# breaks `import SwiftUI` ("redefinition of module 'SwiftBridging'"). Hide it with a VFS overlay.
FIX=()
INC=$(dirname "$(xcrun -f swiftc)")/../include/swift
if [[ -f "$INC/module.modulemap" && -f "$INC/bridging.modulemap" ]]; then
  : > "$OUT/empty.modulemap"
  INC=$(cd "$INC" && pwd)
  printf '{"version":0,"case-sensitive":"false","roots":[{"type":"file","name":"%s","external-contents":"%s"}]}' \
    "$INC/module.modulemap" "$OUT/empty.modulemap" > "$OUT/overlay.yaml"
  FIX=(-vfsoverlay "$OUT/overlay.yaml" -Xcc -ivfsoverlay -Xcc "$OUT/overlay.yaml")
fi

SOURCES=()
while IFS= read -r -d '' source; do SOURCES+=("$source"); done < <(find Sources -name '*.swift' -print0)
for arch in arm64 x86_64; do
  swiftc -swift-version 5 -O -parse-as-library -target "$arch-apple-macos14" -sdk "$SDK" "${FIX[@]}" "${SOURCES[@]}" -o "$OUT/Doudou-$arch"
done
lipo -create -output "$APP/Contents/MacOS/Doudou" "$OUT/Doudou-arm64" "$OUT/Doudou-x86_64"
bash tools/sync-mascot.sh
cp -R Resources/. "$APP/Contents/Resources/"
cp Info.plist "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" -c "Set :CFBundleVersion $BUILD" "$APP/Contents/Info.plist"

swiftc -O -sdk "$SDK" "${FIX[@]}" tools/icon.swift -o "$OUT/icon"
"$OUT/icon" "$OUT/AppIcon.iconset"
iconutil -c icns "$OUT/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

if [[ "${DOUDOU_SKIP_SIGNING:-0}" == "1" ]]; then
  echo "本次本地验证跳过签名；生成物未签名，不用于发布。" >&2
else
  codesign --force --deep --sign "$SIGNING_IDENTITY" "$APP"
  codesign --verify --deep --strict "$APP"
fi

STAGE="$OUT/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "豆豆" -srcfolder "$STAGE" -ov -format UDZO "$OUT/doudou-$VERSION.dmg" >/dev/null
echo "$OUT/doudou-$VERSION.dmg"
