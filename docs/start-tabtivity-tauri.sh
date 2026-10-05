#!/usr/bin/env bash
set -euo pipefail

APPIMAGE="$HOME/.local/share/tabtivity/tabtivity.AppImage"
BINARY="$HOME/.local/share/tabtivity/tabtivity"

if [[ -x "$APPIMAGE" ]]; then
  exec "$APPIMAGE" "$@"
elif [[ -x "$BINARY" ]]; then
  exec "$BINARY" "$@"
else
  printf '%s\n' "Tabtivity package missing." \
    "Run 'npm run package' to build and install Tabtivity first." >&2
  exit 1
fi
