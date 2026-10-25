#!/bin/bash
# Ad-hoc signs the built app and installs it to ~/Applications/Baton.app (build first: npm run dist).
# Never touches an older "Claude Switch.app" or any of your data; it only prints how to remove the old app.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="release/mac-arm64/Baton.app"
[ -d "$APP" ] || { echo "missing $APP — run: npm run dist"; exit 1; }
codesign --force --deep -s - "$APP"
codesign --verify --deep --strict "$APP" && echo "signature ok (ad-hoc)"
mkdir -p "$HOME/Applications"
DEST="$HOME/Applications/Baton.app"
if [ -d "$DEST" ]; then osascript -e 'tell application id "com.vamsijanaki.baton" to quit' 2>/dev/null || true; sleep 1; rm -rf "$DEST"; fi
ditto "$APP" "$DEST"
echo "installed: $DEST"
OLD="$HOME/Applications/Claude Switch.app"
if [ -d "$OLD" ]; then
  echo
  echo "The old app (same tool, previous name) is still installed: $OLD"
  echo "Baton keeps using its data (~/.claude-switch) as is. When you are ready, quit it and move it to the Trash with:"
  echo "  osascript -e 'tell application \"Finder\" to delete POSIX file \"$OLD\"'"
fi
