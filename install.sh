#!/bin/sh
# macOS setup: creates the token file (never overwritten), writes a launchd agent, starts it.
# Settings are taken from the environment of this command, for example:
#   BIND_ADDRESS=192.0.2.20 JELLYFIN_KEY_FILE=$HOME/.config/stremio-jellyfin-addon/jellyfin-key ./install.sh
# Supported: BIND_ADDRESS PORT JELLYFIN_URL JELLYFIN_KEY_FILE TOKEN_FILE REFRESH_SECONDS ADDON_ID ADDON_NAME
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)
CONF="$HOME/.config/stremio-jellyfin-addon"
LABEL=${LAUNCHD_LABEL:-io.github.stremio-jellyfin-addon}
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE=$(command -v node)
TOKEN=${TOKEN_FILE:-$CONF/token}

mkdir -p "$(dirname "$TOKEN")" "$HOME/Library/LaunchAgents"
if [ ! -s "$TOKEN" ]; then
  (umask 077; openssl rand -hex 32 > "$TOKEN")
  chmod 600 "$TOKEN"
fi

xml() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }
ENVXML=""
for v in BIND_ADDRESS PORT JELLYFIN_URL JELLYFIN_KEY_FILE TOKEN_FILE REFRESH_SECONDS ADDON_ID ADDON_NAME; do
  eval "val=\${$v-}"
  [ -n "$val" ] && ENVXML="$ENVXML<key>$v</key><string>$(xml "$val")</string>"
done

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/src/server.js</string></array>
<key>WorkingDirectory</key><string>$DIR</string>
<key>EnvironmentVariables</key><dict>$ENVXML</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>$HOME/Library/Logs/stremio-jellyfin-addon.log</string>
<key>StandardErrorPath</key><string>$HOME/Library/Logs/stremio-jellyfin-addon.log</string>
</dict></plist>
PL

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL (token file: $TOKEN)"
[ -n "${BIND_ADDRESS-}" ] || echo "note: BIND_ADDRESS not set, the add-on listens on 127.0.0.1 only"
