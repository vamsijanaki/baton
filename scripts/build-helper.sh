#!/bin/bash
# Compiles helper/baton-desktop-helper.swift → build/baton-desktop-helper (bundled into the app's Resources).
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=helper/baton-desktop-helper.swift
OUT=build/baton-desktop-helper
if [ -x "$OUT" ] && [ "$OUT" -nt "$SRC" ]; then exit 0; fi
swiftc -O -target "$(uname -m)-apple-macos13.0" -o "$OUT" "$SRC"
echo "built $OUT"
