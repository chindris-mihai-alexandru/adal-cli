#!/bin/bash
# install-launchd.sh — Install adal-compress as a macOS LaunchAgent
#
# This script:
# 1. Creates a LaunchAgent plist that auto-starts the compression proxy on login
# 2. Sets ADAL_APP_URL via launchctl so GUI apps (like AdaL Desktop) inherit it
# 3. Loads the agent immediately
#
# Usage:
#   ./install-launchd.sh          Install and start
#   ./install-launchd.sh --remove Uninstall

set -euo pipefail

LABEL="com.sylphai.adal-compress"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/$LABEL.plist"
PORT="${ADAL_COMPRESS_PORT:-9876}"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(which node 2>/dev/null || echo '/opt/homebrew/bin/node')"

# --- Uninstall ---
if [[ "${1:-}" == "--remove" || "${1:-}" == "--uninstall" ]]; then
    echo "🗑  Removing adal-compress LaunchAgent..."
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST_FILE"
    launchctl unsetenv ADAL_APP_URL 2>/dev/null || true
    echo "   ✅ Removed. Proxy will not start on next login."
    echo "   💡 Remove 'export ADAL_APP_URL=...' from ~/.zshrc if present."
    exit 0
fi

# --- Install ---
echo "⚡ Installing adal-compress LaunchAgent..."
echo "   Port: $PORT"
echo "   Node: $NODE_BIN"
echo "   Script: $SCRIPT_DIR/bin/adal-compress-desktop.mjs"

# Verify node exists
if [[ ! -x "$NODE_BIN" ]]; then
    echo "   ❌ Node not found at $NODE_BIN"
    echo "   Set NODE_BIN or ensure node >= 18 is in PATH"
    exit 1
fi

# Create LaunchAgents directory if needed
mkdir -p "$PLIST_DIR"

# Write plist
cat > "$PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$SCRIPT_DIR/bin/adal-compress-desktop.mjs</string>
        <string>--daemon</string>
        <string>--port</string>
        <string>$PORT</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/tmp/adal-compress.log</string>

    <key>StandardErrorPath</key>
    <string>/tmp/adal-compress.err</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF

echo "   📄 Plist written: $PLIST_FILE"

# Set ADAL_APP_URL for GUI apps (persists until logout)
launchctl setenv ADAL_APP_URL "http://localhost:$PORT"
echo "   🌍 launchctl setenv ADAL_APP_URL=http://localhost:$PORT"

# Load the agent
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE"
echo "   🚀 Agent loaded and running"

# Verify
sleep 1
if launchctl print "gui/$(id -u)/$LABEL" > /dev/null 2>&1; then
    echo ""
    echo "   ✅ adal-compress is running on port $PORT"
    echo "   ✅ ADAL_APP_URL set for all GUI apps"
    echo ""
    echo "   The proxy will auto-start on every login."
    echo "   AdaL Desktop will route through it automatically."
    echo ""
    echo "   To remove: $0 --remove"
else
    echo "   ⚠️  Agent may not have started. Check: /tmp/adal-compress.log"
fi
