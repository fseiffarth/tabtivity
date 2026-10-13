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
#
# The desktop entry runs the COPY of this script that package-dev.sh installs
# into <app_dir>/dev-launcher/ (with every helper it sources or runs, and
# `source-root` naming the checkout), not the checkout's own: every agent
# fence that binds the project can edit the checkout, and this runs unfenced
# (threat recheck 2026-10-08, gap 20). From the copy, the checkout is only
# data: the binary it built, and HEAD for the "behind" notice.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_DISPLAY, $APP_SLUG, $APP_BIN_NAME, …
. "$HERE/scripts/lib/brand.sh" && . "$HERE/scripts/lib/dev-launcher.sh" || {
  # Nothing is logged yet (the log's path needs the name), and a desktop entry
  # has no terminal: say it where it is seen.
  notify-send -u critical 'The frozen dev build was not started' "scripts/lib/brand.sh could not read the app's name in $HERE." 2>/dev/null || true
  exit 1
}
ROOT="$HERE"
if [ -f "$HERE/source-root" ]; then
  ROOT="$(head -n 1 "$HERE/source-root")"
fi
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
# 2026-09-03 the post-commit hook does that on every commit. A freeze that
# lands under a running window leaves the binary in target/release/ instead
# (replacing the path under the window costs its core dump), and launch is the
# only safe moment to install it -- a running instance holds the old inode
# until then, which is exactly why the checks above come first.
#
# target/ is inside the project, which every agent fence binds read-write, so
# neither the binary nor the `.frozen` record beside it is evidence of
# anything (threat recheck 2026-10-08, gap 20). The binary is adopted only when
# its sha256 is in <app_dir>/dev-builds/verified, which only a package-dev.sh
# running on the host writes (scripts/lib/dev-launcher.sh), and its label comes
# from that list too. It is copied next to the installed binary first and the
# COPY is hashed, so the file cannot be swapped between check and install.
# There is no fallback (the old "carries the current dist/ frontend" re-check
# would adopt any binary an agent built). Any failure keeps the installed
# binary; the window opens either way, and a notification says which.
BUILT="$ROOT/target/release/$APP_BIN_NAME"
VERIFIED="$(dev_verified_list "$APP_SHARE_DIR")"
if [ -f "$BUILT" ] && [ "$BUILT" -nt "$BINARY" ]; then
  printf 'newer snapshot in the tree: %s\n' "$BUILT"
  staged="$BINARY.adopt.$$"
  record=""
  sha=""
  # `-p` keeps the build's mtime, and apport needs it: this shell exec()s the
  # binary under its own pid, whose /proc/<pid>/cmdline the pgrep above has
  # already stamped with the launch time. A binary installed after that stamp
  # reads to apport as "executable was modified after program start", and the
  # core is thrown away — 2026-09-29's heap-corruption crash left none that way.
  if install -p -Dm755 "$BUILT" "$staged" 2>/dev/null; then
    sha="$(sha256sum "$staged" | cut -d' ' -f1)"
    record="$(dev_verified_lookup "$VERIFIED" "$sha")" || record=""
  fi
  if [ -z "$sha" ]; then
    rm -f "$staged"
    printf 'could not copy it; launching the binary that is already there\n'
    notify-send -u normal -a "$APP_DISPLAY" "$APP_DISPLAY (dev) is running an older snapshot" \
      "Could not install the newer build into $BINARY; see $APP_DEV_BIN_NAME.log." 2>/dev/null || true
  elif [ -z "$record" ]; then
    rm -f "$staged"
    printf 'not adopting it: its sha256 %s is not in %s, so no build outside an agent fence made it\n' "$sha" "$VERIFIED"
    notify-send -u normal -a "$APP_DISPLAY" "$APP_DISPLAY (dev) is running an older snapshot" \
      "target/release/$APP_BIN_NAME is newer, but no build outside an agent fence made it (an agent's build, or a planted file). Run npm run package:dev outside the fence and relaunch." 2>/dev/null || true
  elif mv -f "$staged" "$BINARY"; then
    read -r rec_commit rec_version rec_built <<<"$record"
    label="$rec_version @ $rec_commit"
    printf 'adopted it as %s (%s; built outside a fence %s)\n' "$BINARY" "$label" "$rec_built"
    # The record beside the installed binary says which commit the next
    # launch opens. Written from the verified list, never copied out of
    # target/.
    {
      printf 'sha256=%s\n' "$sha"
      printf 'version=%s\n' "$rec_version"
      printf 'commit=%s\n' "$rec_commit"
      printf 'source=adopted\n'
      printf 'built=%s\n' "$rec_built"
    } >"$BINARY.frozen" 2>/dev/null || true
    # Keep the adopted build under dev-builds/tabtivity-<commit> for
    # scripts/crash-symbolize.sh; the next adopt replaces the path.
    "$HERE/scripts/retain-dev-build.sh" "$BINARY" "$rec_commit" 2>/dev/null || true
    # The desktop entry's Comment names the frozen snapshot; keep it honest.
    # (The label's characters are limited to [A-Za-z0-9.+:_-?] by the list.)
    desktop="$HOME/.local/share/applications/${APP_DISPLAY}Dev.desktop"
    if [ -f "$desktop" ]; then
      sed -i "s|^Comment=.*|Comment=Frozen build $label ($(date +%Y-%m-%d)) — no hot reload|" "$desktop" 2>/dev/null || true
    fi
    notify-send -u low -a "$APP_DISPLAY" "$APP_DISPLAY (dev) moved forward" "Now running $label." 2>/dev/null || true
  else
    rm -f "$staged"
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
# (`|| true`: with no record at all, a failing sed under `set -e` and
# `pipefail` used to end the launcher here, before the window opened.)
frozen_commit="$(sed -n 's/^commit=//p' "$BINARY.frozen" 2>/dev/null | head -n 1 || true)"
# No record beside the installed binary (adopted before records were kept
# there): the verified list speaks for it if it holds that build's hash. The
# tree's own record no longer does — anything can be written there.
if [ -z "$frozen_commit" ] && [ -f "$BINARY" ]; then
  installed_record="$(dev_verified_lookup "$VERIFIED" "$(sha256sum "$BINARY" 2>/dev/null | cut -d' ' -f1)")" || installed_record=""
  frozen_commit="${installed_record%% *}"
fi
# A short sha, maybe "+local": nothing else reaches git's command line.
case "$frozen_commit" in
  ''|*[!0-9a-f+local]*|-*) frozen_commit="" ;;
esac
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
