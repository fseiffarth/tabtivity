#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_DISPLAY, $APP_SLUG, $APP_BIN_NAME, …
. "$ROOT/scripts/lib/brand.sh"
APP_DIR="$APP_SHARE_DIR"
DESKTOP_DIR="$HOME/.local/share/applications"
BINARY_DEST="$APP_DIR/$APP_BIN_NAME"
DESKTOP_STABLE_DEST="$DESKTOP_DIR/$APP_DISPLAY.desktop"
DESKTOP_HOTRELOAD_DEST="$DESKTOP_DIR/${APP_DISPLAY}HotReload.desktop"

mkdir -p "$APP_DIR" "$DESKTOP_DIR"

cd "$ROOT"

# Try AppImage bundle first; fall back to raw binary if linuxdeploy fails (e.g. no FUSE).
APPIMAGE_SRC=""
if APPIMAGE_EXTRACT_AND_RUN=1 npm run tauri:bundle 2>&1; then
  APPIMAGE_SRC="$(find "$ROOT/target/release/bundle/appimage" -maxdepth 1 -name '*.AppImage' -print -quit 2>/dev/null || true)"
fi

if [[ -n "${APPIMAGE_SRC:-}" && -f "$APPIMAGE_SRC" ]]; then
  install -Dm755 "$APPIMAGE_SRC" "$BINARY_DEST.AppImage"
  BINARY_DEST="$BINARY_DEST.AppImage"
  echo "Installed AppImage to: $BINARY_DEST"
else
  # AppImage bundling unavailable (no FUSE); use the raw release binary.
  RAW_BIN="$ROOT/target/release/$APP_BIN_NAME"
  if [[ ! -f "$RAW_BIN" ]]; then
    # Bundle failed before linking — do a plain cargo build. `--features
    # custom-protocol` is what the tauri CLI would have supplied: without it the
    # app compiles in dev mode, embeds no frontend, and opens devUrl — i.e. an
    # installed Tabtivity showing "Could not connect to localhost" (2026-09-02).
    export PATH="$HOME/.cargo/bin:$PATH"
    cargo build --release --features custom-protocol \
      --manifest-path "$ROOT/src-tauri/Cargo.toml"
  fi
  "$ROOT/scripts/assert-embedded-frontend.sh" "$RAW_BIN"
  install -Dm755 "$RAW_BIN" "$BINARY_DEST"
  echo "AppImage bundling unavailable (no FUSE); installed raw binary to: $BINARY_DEST"
fi

cat >"$DESKTOP_STABLE_DEST" <<EOF
[Desktop Entry]
Type=Application
Name=$APP_DISPLAY
Comment=A tab for each project. A tab for everything in it.
Exec=$BINARY_DEST
Icon=$ROOT/src-tauri/icons/128x128.png
Terminal=false
Categories=Utility;TerminalEmulator;Development;
StartupWMClass=$APP_BIN_NAME
EOF
chmod 755 "$DESKTOP_STABLE_DEST"

cat >"$DESKTOP_HOTRELOAD_DEST" <<EOF
[Desktop Entry]
Type=Application
Name=${APP_DISPLAY}HotReload
Comment=Terminal workspace manager hot reload
Exec=$ROOT/start-$APP_SLUG-tauri-hotreload.sh
Icon=$ROOT/src-tauri/icons/128x128.png
Terminal=false
Categories=Utility;TerminalEmulator;Development;
StartupWMClass=$APP_BIN_NAME
EOF
chmod 755 "$DESKTOP_HOTRELOAD_DEST"
# The entries an install made under the app's old name: remove them, so the
# menu shows each launcher once.
if [ "$APP_LEGACY_DISPLAY" != "$APP_DISPLAY" ]; then
  rm -f "$DESKTOP_DIR/$APP_LEGACY_DISPLAY.desktop" "$DESKTOP_DIR/${APP_LEGACY_DISPLAY}HotReload.desktop"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

echo "Desktop entry: $DESKTOP_STABLE_DEST"
echo "HotReload desktop entry: $DESKTOP_HOTRELOAD_DEST"
