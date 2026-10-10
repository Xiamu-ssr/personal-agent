#!/bin/bash
# No real chat, uploads, task execution or socket connection. 201 s per run; independent hang watchdog.
# Modes: after, before, {before,after}-stream-only, after-long-turn, after-long-turn-steady.
# Before modes use the preserved v0.2.0 sources in verification/performance/before-sources.
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${1:-after}"
out="$PWD/verification/performance"
mkdir -p "$out"
sdk_path=$(xcrun --show-sdk-path)
sources=Sources
if [[ "$mode" == before* ]]; then
  sources=verification/performance/before-sources
fi
swiftc -swift-version 5 -O -D MAC_VERIFY -D MAC_PERF -parse-as-library -sdk "$sdk_path" \
  -vfsoverlay "$PWD/build/overlay.yaml" -Xcc -ivfsoverlay -Xcc "$PWD/build/overlay.yaml" \
  "$sources"/*.swift tools/perf.swift -o "$out/perf-$mode"
"$out/perf-$mode" "$mode" "$out"
