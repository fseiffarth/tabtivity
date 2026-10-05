#!/usr/bin/env bash
# Launcher for the hot-reload Tauri dev server.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_DISPLAY, $APP_SLUG, $APP_BIN_NAME, …
. "$ROOT/scripts/lib/brand.sh" || {
  # Nothing is logged yet (the log's path needs the name), and a desktop entry
  # has no terminal: say it where it is seen.
  notify-send -u critical 'The hot-reload session was not started' "scripts/lib/brand.sh could not read the app's name in $ROOT." 2>/dev/null || true
  exit 1
}
LOG_DIR="$APP_SHARE_DIR"
LOG_FILE="$LOG_DIR/hotreload.log"
LOG_MAX_BYTES=$((64 * 1024 * 1024))

mkdir -p "$LOG_DIR"

# `tauri dev` streams every cargo build bar and vite HMR line in here, so the
# log grows without bound (it reached 2 GB once). Keep one generation.
if [ -f "$LOG_FILE" ] && [ "$(stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
  mv -f "$LOG_FILE" "$LOG_FILE.1"
fi

exec >>"$LOG_FILE" 2>&1

# The rotation above only runs at launch, which caps the log across sessions and
# not within one -- and a hot-reload session is measured in days. A single run
# had put 255 MB into the live file and 613 MB into the generation before it
# (2026-09-01), i.e. four times the cap in the one file the cap is about.
#
# So keep a watchdog on it. It TRUNCATES IN PLACE (tail into a temp, copy back
# over the same inode) rather than rotating: every writer above holds this file
# open in append mode, and a `mv` would leave `tauri dev`, vite and cargo all
# writing to an unlinked inode for the rest of the session -- a log that looks
# rotated and then never grows again. `O_APPEND` writers resume at the new end
# of a shortened file, so shortening it under them is safe.
#
# The watchdog dies with the launcher: `$$` is checked each pass so an orphan
# left by a `kill -9` stops on its own, and the EXIT trap kills it outright.
LOG_KEEP_BYTES=$((16 * 1024 * 1024))
(
  while sleep 300; do
    kill -0 "$$" 2>/dev/null || exit 0
    size="$(stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)"
    [ "$size" -gt "$LOG_MAX_BYTES" ] || continue
    tmp="$LOG_FILE.trim.$$"
    if tail -c "$LOG_KEEP_BYTES" "$LOG_FILE" >"$tmp" 2>/dev/null; then
      cat "$tmp" >"$LOG_FILE" 2>/dev/null || true
    fi
    rm -f "$tmp"
  done
) &
LOG_TRIMMER=$!

printf '\n=== HOTRELOAD START %s ===\n' "$(date -Is)"
trap 'status=$?; kill "$LOG_TRIMMER" 2>/dev/null || true; printf "=== HOTRELOAD EXIT %s status=%s ===\n" "$(date -Is)" "$status"' EXIT

cd "$ROOT"

# Refuse to become a second instance. Also runs again via the `pretauri:dev`
# npm hook below, which is what covers a bare `npm run tauri:dev`.
"$ROOT/scripts/guard-single-instance.sh"

# Desktop entries don't source ~/.bashrc, so Rust tools may not be in PATH.
export PATH="$HOME/.cargo/bin:$PATH"

# With GTK overlay scrolling on (the default on Cinnamon/GNOME), WebKitGTK draws
# a native GTK overlay scrollbar and ignores the app's CSS `scrollbar-color`, so
# the themed (blue) scrollbars fall back to the system GTK theme (white/grey in
# Adwaita light). Disabling it forces the legacy scrollbar, which WebKitGTK
# renders itself and themes from our CSS. Harmless where it's already off.
export GTK_OVERLAY_SCROLLING=0

printf 'root=%s\n' "$ROOT"
printf 'PATH=%s\n' "$PATH"
# Preflight the build toolchain, and SAY SO on the desktop when it is missing.
#
# These four probes used to be bare `command -v` lines. Under `set -e` the
# first missing tool killed the script right there -- before vite, before
# cargo, before any window -- and the only trace was one line in this log,
# which is not where anyone looks when an icon they clicked appears to do
# nothing. That is exactly how a reinstalled host presented itself on
# 2026-09-07: a fresh root that still had the WebKitGTK *runtime* (so the
# frozen "Tabtivity (dev)" build opened fine) but none of node, npm, cargo or
# rustc, and a hot-reload entry that looked like it was being ignored.
#
# So collect every missing tool, name them all in one notification, and exit
# deliberately. Nothing here can fix a missing toolchain; being told which
# piece is gone is the whole job.
missing=""
for tool in node npm cargo rustc; do
  if path="$(command -v "$tool" 2>/dev/null)"; then
    printf '%s=%s\n' "$tool" "$path"
  else
    missing="${missing:+$missing }$tool"
  fi
done
if [ -n "$missing" ]; then
  printf 'REFUSING TO START: build toolchain incomplete (missing: %s)\n' "$missing" >&2
  printf '  the hot-reload session builds from source and needs all of node, npm, cargo, rustc\n' >&2
  notify-send -u critical -a "$APP_DISPLAY" "$APP_DISPLAY hot-reload not started" \
    "Missing build tools: $missing. Install them, or use the frozen $APP_DISPLAY (dev) build." 2>/dev/null || true
  exit 1
fi
node --version
npm --version
cargo --version
rustc --version

# The one directory this binary may serve a newer phone bundle from
# (src-tauri/src/services/mobile_control/live_pwa.rs). Exported here rather than
# in package.json because an inline assignment in an npm script is not portable
# to the Windows shell CI runs, and this launcher is Linux-only anyway. Without
# it the dev window's sidecar has no overlay path compiled in and keeps serving
# the bundle `beforeDevCommand` built at session start — fine for an hour, stale
# by the end of a long session.
app_export MOBILE_LIVE_DIR "$ROOT/target/mobile-pwa"
# The checkout the header's dev-build chip reads HEAD from (services::dev_build).
# Unset — CI, a release — means no chip.
app_export DEV_SOURCE_ROOT "$ROOT"

exec npm run tauri:dev
