#!/bin/bash
# Draws the app icon + menu-bar template from SVG, then builds build/icon.icns with iconutil.
set -euo pipefail
cd "$(dirname "$0")/.."
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}
mkdir -p build
T=$(mktemp -d)
swiftc -O assets/render.swift -o "$T/render" 2>/dev/null
"$T/render" assets/icon.svg build/icon.png 1024
"$T/render" assets/tray.svg build/trayTemplate@2x.png 44
"$T/render" assets/tray.svg build/trayTemplate.png 22
ICON="$T/icon.iconset"; mkdir -p "$ICON"
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out "$ICON/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) build/icon.png --out "$ICON/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICON" -o build/icon.icns
rm -rf "$T"
echo "icons ok"
