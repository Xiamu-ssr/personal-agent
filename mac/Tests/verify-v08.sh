#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
TEST_ROOT=$(mktemp -d /tmp/doudou-v08-tests.XXXXXX)
trap 'rm -rf "$TEST_ROOT"' EXIT
export DOUDOU_DATA_DIR="$TEST_ROOT/user"
bash tools/compile-check.sh Tests/V08Tests.swift "$TEST_ROOT/v08-tests"
"$TEST_ROOT/v08-tests" -server http://127.0.0.1:18808
bash Tests/verify-server-address.sh
