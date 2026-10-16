#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
VERIFY_WORK=$(mktemp -d /tmp/doudou-providers-local.XXXXXX)
mkdir -p /tmp/v081-mac-shots
bash tools/compile-check.sh Tests/ProvidersLocalTests.swift "$VERIFY_WORK/tests"
node tools/providers-local-cloud.mjs > /tmp/v081-mac-shots/providers-local-cloud.log 2>&1 &
FIXTURE_PID=$!
trap 'kill "$FIXTURE_PID" 2>/dev/null || true; wait "$FIXTURE_PID" 2>/dev/null || true' EXIT
for ((i=0; i<200; i++)); do
  if [[ -f /tmp/v081-mac-shots/providers-local-cloud.json ]] && python3 -c 'import json,sys; sys.exit(json.load(open("/tmp/v081-mac-shots/providers-local-cloud.json"))["pid"] != int(sys.argv[1]))' "$FIXTURE_PID"; then break; fi
  kill -0 "$FIXTURE_PID" 2>/dev/null || { cat /tmp/v081-mac-shots/providers-local-cloud.log; exit 1; }
  sleep 0.1
done
python3 -c 'import json,sys; sys.exit(json.load(open("/tmp/v081-mac-shots/providers-local-cloud.json"))["pid"] != int(sys.argv[1]))' "$FIXTURE_PID"
SERVER=$(python3 -c 'import json; print(json.load(open("/tmp/v081-mac-shots/providers-local-cloud.json"))["server"])')
DOUDOU_DATA_DIR="$VERIFY_WORK/user" "$VERIFY_WORK/tests" -server "$SERVER" -notifyMessages NO
