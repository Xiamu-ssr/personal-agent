#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
REVIEW_WORK=$(mktemp -d /tmp/doudou-v08-review.XXXXXX)
APP="$REVIEW_WORK/豆豆验收.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" /tmp/v08-mac-shots
cp Info.plist "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.xiamu.agent.mac.v08review' "$APP/Contents/Info.plist"
bash tools/sync-mascot.sh
cp -R Resources/. "$APP/Contents/Resources/"
bash tools/compile-check.sh Tests/V08Review.swift "$APP/Contents/MacOS/Doudou"
SERVER=$(python3 -c 'import json; print(json.load(open("/tmp/v08-mac-shots/local-cloud.json"))["server"])')
export DOUDOU_DATA_DIR="$REVIEW_WORK/user"
"$APP/Contents/MacOS/Doudou" -server "$SERVER" -notifyMessages NO
