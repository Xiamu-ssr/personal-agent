#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
CHECK_WORK=${CHECK_WORK:-$(mktemp -d /tmp/doudou-v08-compile.XXXXXX)}
mkdir -p "$CHECK_WORK"
SDK=$(xcrun --show-sdk-path)
FIX=()
INC=$(dirname "$(xcrun -f swiftc)")/../include/swift
if [[ -f "$INC/module.modulemap" && -f "$INC/bridging.modulemap" ]]; then
  : > "$CHECK_WORK/empty.modulemap"
  INC=$(cd "$INC" && pwd)
  printf '{"version":0,"case-sensitive":"false","roots":[{"type":"file","name":"%s","external-contents":"%s"}]}' "$INC/module.modulemap" "$CHECK_WORK/empty.modulemap" > "$CHECK_WORK/overlay.yaml"
  FIX=(-vfsoverlay "$CHECK_WORK/overlay.yaml" -Xcc -ivfsoverlay -Xcc "$CHECK_WORK/overlay.yaml")
fi
SOURCES=()
while IFS= read -r source; do SOURCES+=("$source"); done < <(rg --files Sources -g '*.swift' | sort)
swiftc -swift-version 5 -D MAC_VERIFY -parse-as-library -sdk "$SDK" "${FIX[@]}" "${SOURCES[@]}" Tests/TestTransport.swift Tests/ReviewDraggingInfo.swift "$1" -o "$2"
