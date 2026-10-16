#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
REVIEW_WORK=$(mktemp -d /tmp/doudou-v081-review.XXXXXX)
APP="$REVIEW_WORK/豆豆验收.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" /tmp/v081-mac-shots
cp Info.plist "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.xiamu.agent.mac.v081review' "$APP/Contents/Info.plist"
cp -R Resources/. "$APP/Contents/Resources/"
bash tools/compile-check.sh Tests/V081Review.swift "$APP/Contents/MacOS/Doudou"
SERVER=$(python3 -c 'import json; print(json.load(open("/tmp/v081-mac-shots/local-cloud.json"))["server"])')
cd ..
DOUDOU_DATA_DIR="$REVIEW_WORK/user" "$APP/Contents/MacOS/Doudou" -server "$SERVER" -notifyMessages NO "$@"
