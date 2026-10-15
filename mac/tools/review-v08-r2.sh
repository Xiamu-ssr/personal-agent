#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
REVIEW_WORK=$(mktemp -d /tmp/doudou-v08-r2.XXXXXX)
APP="$REVIEW_WORK/豆豆二轮验收.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" /tmp/v08-mac-shots/r2
cp Info.plist "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.xiamu.agent.mac.v08r2review' "$APP/Contents/Info.plist"
bash tools/sync-mascot.sh
cp -R Resources/. "$APP/Contents/Resources/"
bash tools/compile-check.sh Tests/V08R2Review.swift "$APP/Contents/MacOS/Doudou"
SERVER=$(python3 -c 'import json; print(json.load(open("/tmp/v08-mac-shots/r2/local-cloud.json"))["server"])')
DOUDOU_DATA_DIR="$REVIEW_WORK/user" "$APP/Contents/MacOS/Doudou" -server "$SERVER" -notifyMessages NO
DOUDOU_DATA_DIR="$REVIEW_WORK/restored-user" "$APP/Contents/MacOS/Doudou" -server "$SERVER" -notifyMessages NO --restore-side
