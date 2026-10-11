#!/bin/bash
# Real capability sources + an offline Socket fixture. Never launches the paired app or requests TCC.
set -euo pipefail
cd "$(dirname "$0")/.."
TEMP=$(mktemp -d "${TMPDIR:-/tmp}/doudou-caps-build.XXXXXX")
PROFILE=""
trap 'if [[ -n "$PROFILE" && -x "$TEMP/caps-test" ]]; then "$TEMP/caps-test" --persist-clean "$PROFILE" >/dev/null 2>&1 || true; fi; rm -rf "$TEMP"' EXIT
SDK=$(xcrun --show-sdk-path)
FIX=()
INC=$(dirname "$(xcrun -f swiftc)")/../include/swift
if [[ -f "$INC/module.modulemap" && -f "$INC/bridging.modulemap" ]]; then
  : > "$TEMP/empty.modulemap"
  INC=$(cd "$INC" && pwd)
  printf '{"version":0,"case-sensitive":"false","roots":[{"type":"file","name":"%s","external-contents":"%s"}]}' \
    "$INC/module.modulemap" "$TEMP/empty.modulemap" > "$TEMP/overlay.yaml"
  FIX=(-vfsoverlay "$TEMP/overlay.yaml" -Xcc -ivfsoverlay -Xcc "$TEMP/overlay.yaml")
fi
SOURCES=(Sources/Prefs.swift Sources/Capabilities.swift Sources/DeviceClient.swift Sources/Device/*.swift tools/caps-fixture.swift tools/caps-test.swift)
if [[ "${1:-}" == "--typecheck" ]]; then
  for arch in arm64 x86_64; do
    swiftc -swift-version 5 -parse-as-library -typecheck -target "$arch-apple-macos14" \
      -sdk "$SDK" "${FIX[@]}" "${SOURCES[@]}"
  done
else
  swiftc -swift-version 5 -parse-as-library -sdk "$SDK" "${FIX[@]}" "${SOURCES[@]}" -o "$TEMP/caps-test"
  if [[ "${1:-}" == "--cleanup-profile" ]]; then
    "$TEMP/caps-test" --persist-clean "$2"
    exit 0
  fi
  "$TEMP/caps-test" -deviceId caps-local-test -deviceName caps-test
  PROFILE=$(/usr/bin/uuidgen)
  cat > "$TEMP/persist.html" <<'HTML'
<!doctype html><meta charset="utf-8"><title>Local profile test</title><main id="report"></main>
<script>
if (location.search.includes('write')) localStorage.setItem('doudou-caps', 'saved');
document.getElementById('report').textContent = 'caps-storage=' + localStorage.getItem('doudou-caps');
</script>
HTML
  "$TEMP/caps-test" --persist-write "$PROFILE" "$TEMP/persist.html"
  "$TEMP/caps-test" --persist-read "$PROFILE" "$TEMP/persist.html"
  "$TEMP/caps-test" --persist-clean "$PROFILE"
  PROFILE=""
fi
