#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
TEST_WORK=$(mktemp -d /tmp/doudou-v081-tests.XXXXXX)
trap 'rm -rf "$TEST_WORK"' EXIT
export DOUDOU_DATA_DIR="$TEST_WORK/user"
bash tools/compile-check.sh Tests/ProviderTests.swift "$TEST_WORK/providers"
"$TEST_WORK/providers" -server http://127.0.0.1:18808
bash tools/compile-check.sh Tests/V081Tests.swift "$TEST_WORK/tests"
"$TEST_WORK/tests" -server http://127.0.0.1:18808
bash tools/compile-check.sh Tests/AttachmentLayoutReview.swift "$TEST_WORK/layout"
cd ..
"$TEST_WORK/layout" -server http://127.0.0.1:18808
bash mac/Tests/verify-v08.sh
