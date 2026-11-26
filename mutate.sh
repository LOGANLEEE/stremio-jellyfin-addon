#!/bin/sh
# Usage: mutate.sh <M1|M2|M3|M4> <ACn>. Mutates a COPY of src/server.js, serves it on :8796 in place of
# the launchd service, runs one check, then restores the service. Exit code = the check's exit code.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
LABEL=${LAUNCHD_LABEL:-io.github.stremio-jellyfin-addon}
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
W=$(mktemp -d)
mkdir -p "$W/src" "$W/evidence"
cp "$HERE/check.mjs" "$W/"; cp "$HERE/src/server.js" "$W/src/"; cp "$HERE/evidence/ac0-install.png" "$W/evidence/" 2>/dev/null || true
case "$1" in
  M1) sed -i '' 's/!tokenOk(decodeURIComponent(parts\[0\]))/false/' "$W/src/server.js" ;;
  M2) sed -i '' "/cf-connecting-ip/d" "$W/src/server.js" ;;
  M3) sed -i '' 's|url: `${base}/play/${item.id}`|url: `${base}/play/${item.id}?api_key=${KEY}`|' "$W/src/server.js" ;;
  M4) sed -i '' "s/server.listen(PORT, BIND_ADDRESS/server.listen(PORT, '0.0.0.0'/" "$W/src/server.js" ;;
esac
if cmp -s "$HERE/src/server.js" "$W/src/server.js"; then echo "mutation $1 changed nothing"; exit 2; fi
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
PID=""
restore() { [ -n "$PID" ] && kill "$PID" 2>/dev/null; sleep 1; launchctl bootstrap "gui/$(id -u)" "$PLIST"; }
trap restore EXIT
node "$W/src/server.js" > "$W/out.log" 2>&1 &
PID=$!
sleep 3
node "$W/check.mjs" "$2"
