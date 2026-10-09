#!/bin/bash
# Run fixture checks; add --live to browse and snapshot real pages without sending/uploading/running jobs.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p verification
SDK=$(xcrun --show-sdk-path)
FIX=()
if [[ -f build/overlay.yaml ]]; then
  FIX=(-vfsoverlay "$PWD/build/overlay.yaml" -Xcc -ivfsoverlay -Xcc "$PWD/build/overlay.yaml")
fi
swiftc -swift-version 5 -D MAC_VERIFY -parse-as-library -sdk "$SDK" "${FIX[@]}" Sources/*.swift tools/verify.swift -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "build/豆豆.app/Contents/Info.plist" -o verification/verify
if [[ "${1:-}" == "--live" ]]; then
  verification/verify --live "$PWD/verification/screenshots"
elif [[ "${1:-}" == "--memory-review" ]]; then
  verification/verify --memory-review "$PWD/verification/review-1/screenshots"
else
  verification/verify
fi
