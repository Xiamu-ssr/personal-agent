#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
REVIEW_WORK=$(mktemp -d /tmp/doudou-providers-review.XXXXXX)
APP="$REVIEW_WORK/豆豆模型验收.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" /tmp/v081-mac-shots
cp Info.plist "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.xiamu.agent.mac.providersreview' "$APP/Contents/Info.plist"
cp -R Resources/. "$APP/Contents/Resources/"
bash tools/compile-check.sh Tests/ProvidersReview.swift "$APP/Contents/MacOS/Doudou"
node tools/providers-fake-cloud.mjs > /tmp/v081-mac-shots/providers-fake.log 2>&1 &
FIXTURE_PID=$!
trap 'kill "$FIXTURE_PID" 2>/dev/null || true; wait "$FIXTURE_PID" 2>/dev/null || true' EXIT
for ((i=0; i<100; i++)); do
  if [[ -f /tmp/v081-mac-shots/providers-fake-cloud.json ]] && python3 -c 'import json,sys; sys.exit(json.load(open("/tmp/v081-mac-shots/providers-fake-cloud.json"))["pid"] != int(sys.argv[1]))' "$FIXTURE_PID"; then break; fi
  kill -0 "$FIXTURE_PID" 2>/dev/null || { cat /tmp/v081-mac-shots/providers-fake.log; exit 1; }
  sleep 0.1
done
python3 -c 'import json,sys; sys.exit(json.load(open("/tmp/v081-mac-shots/providers-fake-cloud.json"))["pid"] != int(sys.argv[1]))' "$FIXTURE_PID"
SERVER=$(python3 -c 'import json; print(json.load(open("/tmp/v081-mac-shots/providers-fake-cloud.json"))["server"])')
cd ..
DOUDOU_DATA_DIR="$REVIEW_WORK/user" "$APP/Contents/MacOS/Doudou" -server "$SERVER" -notifyMessages NO
