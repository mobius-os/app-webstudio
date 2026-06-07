#!/bin/bash
# On-demand Web Studio build, invoked by POST /api/apps/{id}/run-job (app_id is
# $1). Reads the main page from build/target.txt, assembles the static site by
# copying everything under files/ into build/site/, and writes the verdict to
# build/status.json. A static site IS its files — there is no compile step; the
# baseline is a verbatim recursive copy. (If files/package.json defines a build
# script we run it as a best-effort enhancement, but the copy is the guarantee.)
# A stray scheduled run with no target is a harmless no-op (writes an error
# status the app ignores).
set -uo pipefail
APP_ID="${1:-}"
STORAGE_DIR="/data/apps/${APP_ID}"
mkdir -p "$STORAGE_DIR/build"
TARGET="$(cat "$STORAGE_DIR/build/target.txt" 2>/dev/null || echo "")"

write_status() {  # $1=status $2=entry(or empty) $3=log
  # Echo the target this verdict was built FROM ($TARGET, set below). target.txt
  # + status.json are a single shared pair per app, so the app-side poller uses
  # this to ignore a verdict produced by a concurrent build of a DIFFERENT page
  # (another tab/device) instead of mapping its output onto the wrong source.
  python3 - "$1" "$2" "$3" "$TARGET" "$STORAGE_DIR/build/status.json" <<'PY'
import json, sys, datetime
status, entry, log, target, out = sys.argv[1:6]
json.dump({
  "status": status,
  "entry": entry or None,
  "target": target or None,
  "log": log,
  "built_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}, open(out, "w"))
PY
}

if [ -z "$TARGET" ]; then
  write_status error "" "No build target set."
  exit 0
fi

# The main page path is "files/<rel>"; strip the prefix to validate the relative
# part. target.txt is app-written but treated as untrusted: reject parent-dir
# traversal, absolute paths, and a leading dash (which a downstream tool could
# read as a flag), and require an .html/.htm entry. Subdirectories
# (files/sub/index.html) stay valid.
case "$TARGET" in
  files/*) REL="${TARGET#files/}" ;;
  *) write_status error "" "build target must be under files/"; exit 0 ;;
esac
case "$REL" in
  -* | */-* | *..* | /* | "") write_status error "" "invalid build target"; exit 0 ;;
esac
case "$REL" in
  *.html | *.htm) : ;;
  *) write_status error "" "build target must be an .html page"; exit 0 ;;
esac

SRC="$STORAGE_DIR/files"
SITE="$STORAGE_DIR/build/site"

if [ ! -d "$SRC" ]; then
  write_status error "" "No files/ directory to build."
  exit 0
fi
if [ ! -f "$SRC/$REL" ]; then
  write_status error "" "Main page not found: $TARGET"
  exit 0
fi

# Fresh build: clear any previous site output, then mirror files/ -> build/site/
# verbatim. `cp -a files/. build/site/` copies the directory CONTENTS (the
# trailing /. means "contents, not the dir itself") preserving the tree, so the
# entry resolves to build/site/<rel>. Drop the agent's own bookkeeping (.keep
# folder markers are noise in the served site).
rm -rf "$SITE"
mkdir -p "$SITE"
COPY_ERR="$STORAGE_DIR/build/copy.err"
if ! cp -a "$SRC/." "$SITE/" 2>"$COPY_ERR"; then
  write_status error "" "Failed to assemble site: $(cat "$COPY_ERR" 2>/dev/null || echo 'copy error')"
  rm -f "$COPY_ERR"
  exit 0
fi
rm -f "$COPY_ERR"
# Remove empty-folder placeholders from the served output.
find "$SITE" -name .keep -type f -delete 2>/dev/null

# Optional enhancement: if files/package.json declares a build script and npm is
# available, run it inside build/site/ as a best-effort step. The verbatim copy
# above already satisfies the static-site contract, so a failure here is logged
# but does NOT fail the build — v1 ships static sites, npm is a bonus.
NPM_LOG=""
if [ -f "$SITE/package.json" ] && command -v npm >/dev/null 2>&1; then
  if python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("scripts",{}).get("build") else 1)' "$SITE/package.json" 2>/dev/null; then
    NPM_LOG="$( (cd "$SITE" && npm install --no-audit --no-fund && npm run build) 2>&1 || echo "npm build skipped/failed (static copy still served)")"
  fi
fi

# Success. The entry is the main page inside the assembled site; the app fetches
# it (and inlines its same-build assets) to render the in-app preview.
write_status done "build/site/${REL}" "${NPM_LOG}"
exit 0
