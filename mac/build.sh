#!/bin/bash
# Build 豆豆.app (universal, ad-hoc signed) and a DMG with only the Command Line Tools — no Xcode needed.
#   VERSION=0.2.0 bash mac/build.sh   ->  mac/build/doudou-0.2.0.dmg
set -euo pipefail
cd "$(dirname "$0")"
VERSION=${VERSION:-0.2.0}
BUILD=${BUILD:-1}
OUT=build
APP="$OUT/豆豆.app"
rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
SDK=$(xcrun --show-sdk-path)

# Some CLT installs ship a stale usr/include/swift/module.modulemap next to bridging.modulemap, which
# breaks `import SwiftUI` ("redefinition of module 'SwiftBridging'"). Hide it with a VFS overlay.
FIX=()
INC=$(dirname "$(xcrun -f swiftc)")/../include/swift
if [[ -f "$INC/module.modulemap" && -f "$INC/bridging.modulemap" ]]; then
  : > "$OUT/empty.modulemap"
  INC=$(cd "$INC" && pwd)
  printf '{"version":0,"case-sensitive":"false","roots":[{"type":"file","name":"%s","external-contents":"%s"}]}' \
    "$INC/module.modulemap" "$PWD/$OUT/empty.modulemap" > "$OUT/overlay.yaml"
  FIX=(-vfsoverlay "$OUT/overlay.yaml" -Xcc -ivfsoverlay -Xcc "$OUT/overlay.yaml")
fi

for arch in arm64 x86_64; do
  swiftc -swift-version 5 -O -parse-as-library -target "$arch-apple-macos14" -sdk "$SDK" "${FIX[@]}" Sources/*.swift -o "$OUT/Doudou-$arch"
done
lipo -create -output "$APP/Contents/MacOS/Doudou" "$OUT/Doudou-arm64" "$OUT/Doudou-x86_64"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" Info.plist > "$APP/Contents/Info.plist"

swiftc -O -sdk "$SDK" "${FIX[@]}" tools/icon.swift -o "$OUT/icon"
"$OUT/icon" "$OUT/AppIcon.iconset"
iconutil -c icns "$OUT/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

codesign --force --deep --sign - "$APP"

STAGE="$OUT/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "豆豆" -srcfolder "$STAGE" -ov -format UDZO "$OUT/doudou-$VERSION.dmg" >/dev/null
echo "$OUT/doudou-$VERSION.dmg"
