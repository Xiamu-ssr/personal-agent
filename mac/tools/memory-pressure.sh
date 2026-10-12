#!/bin/bash
# Build or run an owned, local-only stress executable. No application install or certificate signing.
set -euo pipefail
cd "$(dirname "$0")/.."
LABEL=${1:-after}
OUT="$PWD/verification/v0.6.0/memory-pressure"
mkdir -p "$OUT"
SRC=Sources
if [[ "$LABEL" == before* ]]; then SRC="$OUT/before-sources"; fi
WORK=$(mktemp -d "$OUT/build.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
SDK=$(xcrun --show-sdk-path)
INC=$(dirname "$(xcrun -f swiftc)")/../include/swift
FIX=()
if [[ -f "$INC/module.modulemap" && -f "$INC/bridging.modulemap" ]]; then
  : > "$WORK/empty.modulemap"
  INC=$(cd "$INC" && pwd)
  printf '{"version":0,"case-sensitive":"false","roots":[{"type":"file","name":"%s","external-contents":"%s"}]}' "$INC/module.modulemap" "$WORK/empty.modulemap" > "$WORK/overlay.yaml"
  FIX=(-vfsoverlay "$WORK/overlay.yaml" -Xcc -ivfsoverlay -Xcc "$WORK/overlay.yaml")
fi
SOURCES=()
while IFS= read -r source; do SOURCES+=("$source"); done < <(rg --files "$SRC" -g '*.swift' | sort)
swiftc -swift-version 5 -O -D MAC_VERIFY -D MAC_PERF -parse-as-library -sdk "$SDK" "${FIX[@]}" "${SOURCES[@]}" tools/memory-pressure.swift -o "$OUT/$LABEL"
if [[ "${2:-}" != --build-only ]]; then
  "$OUT/$LABEL" "$LABEL" "$OUT" -server "${LOCAL_SERVICE_URL:-http://127.0.0.1:18865/agent}" -onboarded YES -notifyMessages NO
fi
