#!/usr/bin/env bash
# Launcher for a SANDBOXED hot-reload dev session.
#
# Same `tauri dev` as start-tabtivity-tauri-hotreload.sh, but the app's data is
# redirected under $SANDBOX so this window never touches the real instance's
# state. The intended split (AGENTS.md "Running"):
#   - daily driver: the packaged Tabtivity (`npm run package`), holding the real
#     projects and agent sessions — immune to HMR reloads and dev relaunches,
#   - this window: a disposable test surface that edits may reload at will.
#
# Isolated (fresh under $SANDBOX):
#   TABTIVITY_STATE_DIR → $SANDBOX/state   projects.json, settings, sessions, mail, …
#   TABTIVITY_HOME      → $SANDBOX/tabtivity  projects/, root/, trash/, boxes/, archive/
# NOT isolated: ~/.claude and the agent-session hooks, the OS keychain, and
# machine-wide OpenVPN tunnels — leave machine-wide subsystems off in here.
#
# Output stays on the terminal (this is meant to be run from one); the
# desktop-entry launcher is the one that logs to hotreload.log.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_DISPLAY, $APP_SLUG, $APP_BIN_NAME, …
. "$ROOT/scripts/lib/brand.sh"
SANDBOX="$(app_env SANDBOX_DIR "$APP_SHARE_DIR-dev")"

SANDBOX_STATE="$SANDBOX/state"
SANDBOX_HOME="$SANDBOX/$APP_SLUG"
app_export STATE_DIR "$SANDBOX_STATE"
app_export HOME "$SANDBOX_HOME"
mkdir -p "$SANDBOX_STATE" "$SANDBOX_HOME"

cd "$ROOT"

# Still one dev session at a time: sandboxing separates the data, not port
# 1420. (Runs again via the `pretauri:dev` npm hook; that is harmless.)
"$ROOT/scripts/guard-single-instance.sh"

# Rust tools may not be in PATH when launched outside a login shell.
export PATH="$HOME/.cargo/bin:$PATH"

# See start-tabtivity-tauri-hotreload.sh: force the legacy scrollbar that
# WebKitGTK renders itself and themes from our CSS.
export GTK_OVERLAY_SCROLLING=0

printf 'sandbox: state=%s home=%s\n' "$SANDBOX_STATE" "$SANDBOX_HOME"

exec npm run tauri:dev
