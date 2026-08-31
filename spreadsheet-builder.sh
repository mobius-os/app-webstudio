#!/usr/bin/env bash
set -euo pipefail
: "${PROJECT_ROOT:?PROJECT_ROOT is required}"
: "${PROJECT_SOURCE:?PROJECT_SOURCE is required}"
: "${PROJECT_OUTPUT_DIR:?PROJECT_OUTPUT_DIR is required}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$SCRIPT_DIR/spreadsheet-builder.py"
