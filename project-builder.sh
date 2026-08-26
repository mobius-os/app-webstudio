#!/usr/bin/env bash
set -euo pipefail
: "${PROJECT_ROOT:?PROJECT_ROOT is required}"
: "${PROJECT_SOURCE:?PROJECT_SOURCE is required}"
: "${PROJECT_OUTPUT_DIR:?PROJECT_OUTPUT_DIR is required}"
rm -rf "$PROJECT_OUTPUT_DIR"
mkdir -p "$PROJECT_OUTPUT_DIR"
find "$PROJECT_ROOT" -mindepth 1 -maxdepth 1 ! -name artifacts -exec cp -a {} "$PROJECT_OUTPUT_DIR"/ \;
test -f "$PROJECT_OUTPUT_DIR/$PROJECT_SOURCE"
