#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash Tests/verify-v08.sh
