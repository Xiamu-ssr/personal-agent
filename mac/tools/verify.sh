#!/bin/bash
# Default: in-memory protocol fixtures. All UI reviews require an explicit loopback service.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p verification/v0.6.0
VERIFY_WORK=$(mktemp -d "$PWD/verification/v0.6.0/verify.XXXXXX")
trap 'rm -rf "$VERIFY_WORK"' EXIT
SDK=$(xcrun --show-sdk-path)
FIX=()
INC=$(dirname "$(xcrun -f swiftc)")/../include/swift
if [[ -f "$INC/module.modulemap" && -f "$INC/bridging.modulemap" ]]; then
  : > "$VERIFY_WORK/empty.modulemap"
  INC=$(cd "$INC" && pwd)
  printf '{"version":0,"case-sensitive":"false","roots":[{"type":"file","name":"%s","external-contents":"%s"}]}' "$INC/module.modulemap" "$VERIFY_WORK/empty.modulemap" > "$VERIFY_WORK/overlay.yaml"
  FIX=(-vfsoverlay "$VERIFY_WORK/overlay.yaml" -Xcc -ivfsoverlay -Xcc "$VERIFY_WORK/overlay.yaml")
fi
SOURCES=()
while IFS= read -r source; do SOURCES+=("$source"); done < <(rg --files Sources -g '*.swift' | sort)
TARGET=verification/v0.6.0/verify
if [[ "${1:-}" == "--ui-contract" ]]; then
  shift
  CONTRACT_SOURCES=()
  for source in "${SOURCES[@]}"; do
    [[ "$source" == "Sources/Capabilities.swift" || "$source" == "Sources/DeviceClient.swift" || "$source" == Sources/Device/* ]] || CONTRACT_SOURCES+=("$source")
  done
  SOURCES=("${CONTRACT_SOURCES[@]}" tools/ui-capability-fixture.swift)
  TARGET=verification/v0.6.0/verify-ui-contract
  echo "VALIDATION SCOPE: UI capability contract fixture; system capability implementation excluded."
fi
swiftc -swift-version 5 -D MAC_VERIFY -parse-as-library -sdk "$SDK" "${FIX[@]}" "${SOURCES[@]}" tools/verify.swift tools/task-fixtures.swift tools/connector-fixtures.swift tools/local-menu.swift tools/v06-fixtures.swift tools/v06-logic-fixtures.swift tools/v06-review.swift tools/memory-pressure-fixtures.swift -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PWD/Info.plist" -o "$TARGET"
ARGS=(-server "${LOCAL_SERVICE_URL:-http://127.0.0.1:18765/agent}" -onboarded YES -notifyMessages NO)
case "${1:-}" in
  --local-review) "$TARGET" --local-review "${ARGS[@]}" ;;
  --local-menu) "$TARGET" --local-menu --open-menu-on-launch "${ARGS[@]}" ;;
  --input-review) "$TARGET" --input-review "${ARGS[@]}" ;;
  "") "$TARGET" "${ARGS[@]}" ;;
  *) echo "Use --local-review, --local-menu or --input-review (loopback only)." >&2; exit 2 ;;
esac
