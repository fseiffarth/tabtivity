#!/usr/bin/env bash
# Refuse to start a second Tabtivity dev session.
#
# Two concurrent dev sessions corrupt the shared workspace state under
# ~/.local/share/tabtivity (start-tabtivity-dev-sandbox.sh redirects that state, but
# both sessions still want port 1420, so one-at-a-time stands regardless).
# Worse, a second `tauri dev` whose vite loses the race
# for port 1420 logs the bind failure and carries on anyway, pointing its window
# at the *first* session's dev server — so the new window renders that session's
# stale, half-hot-reloaded module graph and looks like an old build. That is not
# obvious from the window, only from the log, which is why this is mechanical
# rather than a rule someone has to remember.
#
# Invoked from two places, so every documented launch path is covered:
#   - start-tabtivity-tauri-hotreload.sh (the desktop entry)
#   - the `pretauri:dev` npm hook, which catches a bare `npm run tauri:dev`
# Running twice in one launch is harmless: nothing has started yet either time.
#
# A *packaged* Tabtivity (npm run package) deliberately matches neither pgrep
# below: running the stable build as a daily driver beside one dev session is
# the supported dogfooding setup — see start-tabtivity-dev-sandbox.sh. The frozen
# "Tabtivity (dev)" build (npm run package:dev) is NOT that: it shares the real
# state with the hot-reload window and the two alternate, so it is refused
# further down.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_DISPLAY, $APP_SLUG, $APP_BIN_NAME, …
. "$ROOT/scripts/lib/brand.sh"
DEV_PORT=1420

bail() {
  printf 'REFUSING TO START: %s\n' "$1" >&2
  printf '  %s\n' "$2" >&2
  notify-send -u critical -a "$APP_DISPLAY" "$APP_DISPLAY is already running" "$1" 2>/dev/null || true
  exit 1
}

app_pids="$(pgrep -f "^$ROOT/target/debug/$APP_BIN_NAME" || true)"
dev_pids="$(pgrep -f "$ROOT/node_modules/.bin/tauri" || true)"

if [ -n "$app_pids" ] || [ -n "$dev_pids" ]; then
  bail "an $APP_DISPLAY dev session is already up (app=${app_pids:-none} dev=${dev_pids:-none})." \
       "Use that window, or stop it: pkill -f '$ROOT/node_modules/.bin/tauri'; pkill -f '$ROOT/target/debug/$APP_BIN_NAME'"
fi

# The frozen "Tabtivity (dev)" build (scripts/package-dev.sh) is the other window
# of the one-at-a-time workflow: work in it, or in the hot-reload window, never
# both (user, 2026-09-02). It runs on the real state, and a second instance on
# that state corrupts it — a sandboxed session is refused too, so that the rule
# has no exception to remember.
FROZEN_BIN="$APP_SHARE_DIR/$APP_DEV_BIN_NAME"
frozen_pids="$(pgrep -f "^$FROZEN_BIN" || true)"
if [ -n "$frozen_pids" ]; then
  bail "$APP_DISPLAY (dev) is running (pid $frozen_pids); only one $APP_DISPLAY runs at a time." \
       "Close that window first, then start the hot-reload session."
fi

# A build made before the app was renamed runs under the old binary names,
# which nothing above looks for — and it holds the same real state.
old_pids="$(app_legacy_pids "$ROOT" | tr '\n' ' ')"
if [ -n "${old_pids// /}" ]; then
  bail "a build from before the rename is running (pid ${old_pids% }); only one $APP_DISPLAY runs at a time." \
       "Close that window first, then start the hot-reload session."
fi

# No dev session of ours, but the port is taken: an orphaned vite whose
# supervisor died. Starting now would silently attach to it.
if (exec 3<>"/dev/tcp/127.0.0.1/$DEV_PORT") 2>/dev/null; then
  exec 3>&-
  bail "port $DEV_PORT is held by an orphaned dev server (no $APP_DISPLAY process owns it)." \
       "Clear it first: fuser -k $DEV_PORT/tcp"
fi
