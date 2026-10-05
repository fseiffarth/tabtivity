#!/usr/bin/env bash
# Launcher for the FROZEN build behind the "Tabtivity (dev)" desktop entry.
#
# Runs the release binary that scripts/package-dev.sh installed, on the REAL
# state (~/.local/share/tabtivity, ~/tabtivity): this is the window real work happens
# in while the hot-reload window is being edited. Nothing here watches the
# checkout, so edits never reach a window that is already open — but each
# launch adopts the newest snapshot the tree has been built into, so `npm run
# package:dev` (or any commit, via the post-commit hook) plus a relaunch moves
# it forward.
#
# One Tabtivity at a time (user, 2026-09-02): either this window or the
# hot-reload one, never both — they share the real state, and two instances on
# it corrupt it. So this refuses (with a desktop notification) while any
# hot-reload session is up, sandboxed or not, and the hot-reload launcher
# refuses while this one is up.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_DISPLAY, $APP_SLUG, $APP_BIN_NAME, …
. "$ROOT/scripts/lib/brand.sh" || {
  # Nothing is logged yet (the log's path needs the name), and a desktop entry
  # has no terminal: say it where it is seen.
  notify-send -u critical 'The frozen dev build was not started' "scripts/lib/brand.sh could not read the app's name in $ROOT." 2>/dev/null || true
  exit 1
}
BINARY="$APP_SHARE_DIR/$APP_DEV_BIN_NAME"
LOG_DIR="$APP_SHARE_DIR"
LOG_FILE="$LOG_DIR/$APP_DEV_BIN_NAME.log"
LOG_MAX_BYTES=$((16 * 1024 * 1024))

mkdir -p "$LOG_DIR"
if [ -f "$LOG_FILE" ] && [ "$(stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
  mv -f "$LOG_FILE" "$LOG_FILE.1"
fi
exec >>"$LOG_FILE" 2>&1
printf '\n=== %s (dev) START %s ===\n' "$APP_UPPER" "$(date -Is)"

bail() {
  printf 'REFUSING TO START: %s\n  %s\n' "$1" "$2" >&2
  notify-send -u critical -a "$APP_DISPLAY" "$APP_DISPLAY (dev) not started" "$1" 2>/dev/null || true
  exit 1
}

if pgrep -f "^$BINARY" >/dev/null; then
  bail "$APP_DISPLAY (dev) is already running." "Use that window."
fi

dev_pids="$(pgrep -f "^$ROOT/target/debug/$APP_BIN_NAME" || true)"
tauri_pids="$(pgrep -f "$ROOT/node_modules/.bin/tauri" || true)"
if [ -n "$dev_pids" ] || [ -n "$tauri_pids" ]; then
  bail "a hot-reload $APP_DISPLAY is running (app=${dev_pids:-none} dev=${tauri_pids:-none}); only one $APP_DISPLAY runs at a time." \
       "Close that window first, then start $APP_DISPLAY (dev)."
fi

# A build made before the app was renamed runs under the old binary names,
# which nothing above looks for — and it holds the same real state.
old_pids="$(app_legacy_pids "$ROOT" | tr '\n' ' ')"
if [ -n "${old_pids// /}" ]; then
  bail "a build from before the rename is running (pid ${old_pids% }); only one $APP_DISPLAY runs at a time." \
       "Close that window first, then start $APP_DISPLAY (dev)."
fi

# Adopt the tree's newest snapshot, if there is one.
#
# `npm run package:dev` builds the binary and installs it here, and since
# 2026-09-03 the post-commit hook does that on every commit. But that hook
# almost always fires inside an agent tab, and `services::agent_fence` gives an
# agent a tmpfs $HOME with only the project (and two state paths) bound in: the
# BUILD is real -- target/ lives inside the bound project -- while the INSTALL
# writes 75 MB into a directory that dies with the tab, having printed
# "Installed frozen binary". That is how this launcher kept opening a two-day-old
# window through a dozen commits that each reported success (2026-09-04).
#
# So do the install here instead, where no fence can reach: this script runs
# from the desktop entry, in the user's own session. Launch is also the only
# safe moment for it -- a running instance holds the old inode until then, which
# is exactly why the checks above come first.
#
# Conservative by construction: the artifact must be newer than what is
# installed and must be a verified prod binary, and any failure keeps the
# installed binary. The window opens either way.
#
# "Verified" means package-dev.sh checked it against the dist/ it was built
# from and left `<binary>.frozen` (sha256 + version + commit) beside it. That
# record is what is trusted here — NOT a fresh run of the check against dist/:
# dist/ keeps moving after a build (every `npm run build` an agent runs as a
# gate rewrites it with new hashes, uncommitted edits included), and checking a
# finished binary against whatever dist/ holds at launch time refused four days
# of correct builds as "stale" while the icon kept opening the old one
# (2026-09-14). The check itself stays as the fallback for an artifact that
# predates the record. Whatever happens is said out loud: a notification names
# the snapshot adopted, or why the older one is still running.
BUILT="$ROOT/target/release/$APP_BIN_NAME"
FROZEN="$BUILT.frozen"
if [ -f "$BUILT" ] && [ "$BUILT" -nt "$BINARY" ]; then
  printf 'newer snapshot in the tree: %s\n' "$BUILT"
  verdict=""
  label="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo '?') @ $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
  if [ -f "$FROZEN" ] &&
     [ "$(sed -n 's/^sha256=//p' "$FROZEN")" = "$(sha256sum "$BUILT" | cut -d' ' -f1)" ]; then
    label="$(sed -n 's/^version=//p' "$FROZEN") @ $(sed -n 's/^commit=//p' "$FROZEN")"
    verdict="verified when it was built ($(sed -n 's/^built=//p' "$FROZEN"))"
  elif "$ROOT/scripts/assert-embedded-frontend.sh" "$BUILT"; then
    verdict="carries the current dist/ frontend"
  fi
  if [ -z "$verdict" ]; then
    printf 'not adopting it: no build-time record and it does not carry the current dist/ frontend\n'
    notify-send -u normal -a "$APP_DISPLAY" "$APP_DISPLAY (dev) is running an older snapshot" \
      "target/release/$APP_BIN_NAME is newer but unverified; run npm run package:dev and relaunch." 2>/dev/null || true
  # `-p` keeps the build's mtime, and apport needs it: this shell exec()s the
  # binary under its own pid, whose /proc/<pid>/cmdline the pgrep above has
  # already stamped with the launch time. A binary installed after that stamp
  # reads to apport as "executable was modified after program start", and the
  # core is thrown away — 2026-09-29's heap-corruption crash left none that way.
  elif install -p -Dm755 "$BUILT" "$BINARY"; then
    printf 'adopted it as %s (%s; %s)\n' "$BINARY" "$label" "$verdict"
    # Keep the build-time record beside what was installed, so the next launch
    # can say which commit it is opening without hashing anything.
    if [ -f "$FROZEN" ]; then install -m644 "$FROZEN" "$BINARY.frozen" 2>/dev/null || true; else rm -f "$BINARY.frozen"; fi
    # Keep the adopted build under dev-builds/tabtivity-<commit> for
    # scripts/crash-symbolize.sh; the next adopt replaces the path.
    if [ -f "$FROZEN" ]; then
      "$ROOT/scripts/retain-dev-build.sh" "$BINARY" "$(sed -n 's/^commit=//p' "$FROZEN")" 2>/dev/null || true
    fi
    # The desktop entry's Comment names the frozen snapshot; keep it honest.
    desktop="$HOME/.local/share/applications/${APP_DISPLAY}Dev.desktop"
    if [ -f "$desktop" ]; then
      sed -i "s|^Comment=.*|Comment=Frozen build $label ($(date +%Y-%m-%d)) — no hot reload|" "$desktop" 2>/dev/null || true
    fi
    notify-send -u low -a "$APP_DISPLAY" "$APP_DISPLAY (dev) moved forward" "Now running $label." 2>/dev/null || true
  else
    printf 'could not install it; launching the binary that is already there\n'
    notify-send -u normal -a "$APP_DISPLAY" "$APP_DISPLAY (dev) is running an older snapshot" \
      "Could not install the newer build into $BINARY; see $APP_DEV_BIN_NAME.log." 2>/dev/null || true
  fi
fi

if [ ! -x "$BINARY" ]; then
  bail "no frozen build installed at $BINARY." "Build one: cd $ROOT && npm run package:dev"
fi

# Say when the snapshot about to open is behind the repository, and why. The
# commit hook's own failure notice never arrives from an agent tab (no session
# bus), so a commit that broke the auto-freeze — or one the loop never reached
# — left the icon opening yesterday's build with every commit reporting green
# (2026-09-15). The launcher runs in the user's session: this notice does.
APP_DIR="$(dirname "$BINARY")"
FROZEN_INSTALLED="$BINARY.frozen"
# No record beside the installed binary (adopted before records were kept
# there): the tree's record speaks for it only if it IS that build.
if [ ! -f "$FROZEN_INSTALLED" ] && [ -f "$FROZEN" ] &&
   [ "$(sed -n 's/^sha256=//p' "$FROZEN")" = "$(sha256sum "$BINARY" 2>/dev/null | cut -d' ' -f1)" ]; then
  FROZEN_INSTALLED="$FROZEN"
fi
frozen_commit="$(sed -n 's/^commit=//p' "$FROZEN_INSTALLED" 2>/dev/null)"
if [ -n "$frozen_commit" ] && git -C "$ROOT" rev-parse --verify --quiet "$frozen_commit^{commit}" >/dev/null 2>&1; then
  behind="$(git -C "$ROOT" rev-list --count "$frozen_commit..HEAD" 2>/dev/null || echo 0)"
  if [ "$behind" -gt 0 ] 2>/dev/null; then
    why="the post-commit freeze has not caught up yet."
    failed="$APP_DIR/package-dev-auto.failed"
    if [ -f "$failed" ]; then
      read -r fcommit fstatus _ <"$failed"
      why="the post-commit freeze FAILED at $fcommit (status $fstatus) — see $APP_DIR/package-dev-auto.log."
    fi
    printf 'snapshot %s is %s commit(s) behind HEAD: %s\n' "$frozen_commit" "$behind" "$why"
    notify-send -u normal -a "$APP_DISPLAY" "$APP_DISPLAY (dev) is $behind commit(s) behind" \
      "Opening $frozen_commit; $why" 2>/dev/null || true
  fi
fi

# Same reason as start-tabtivity-tauri-hotreload.sh: keep the CSS-themed scrollbar.
export GTK_OVERLAY_SCROLLING=0

# Let a crash leave a core. The desktop session starts us with a soft core
# limit of 0, so apport (the kernel's core_pattern here) wrote nothing for any
# of the main-process heap-corruption aborts of 2026-09-17..23; a backtrace of
# those names only the victim, while the core holds the overwritten chunk.
# Apport ignores unpackaged binaries but still writes the core, to
# /var/lib/apport/coredump/ (newest 5 per user), as long as this path is not
# replaced under the window — package-dev.sh holds its install back for that.
ulimit -S -c unlimited 2>/dev/null || true

cd "$HOME"
exec "$BINARY"
