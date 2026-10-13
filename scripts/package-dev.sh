#!/usr/bin/env bash
# Build a frozen release binary for the "Tabtivity (dev)" desktop entry.
#
# A snapshot that edits cannot touch — no vite HMR, no `tauri dev` relaunch —
# for working (and spotting bugs) undisturbed; the hot-reload window is where a
# fix is then checked. The two share the real state and run one at a time
# (AGENTS.md "Running"). Re-run this script to freeze a newer snapshot; the
# entry's Comment says which commit it is.
#
# Two sources, chosen by flag:
#
#   --head   Freeze the LAST COMMIT, exactly. HEAD is checked out into a fixed
#            detached worktree (target/freeze-tree) and built there, so the
#            binary is a statement about a commit — never "the commit plus
#            whatever happened to be dirty", and never broken by an edit that
#            lands mid-build. This is what the post-commit hook uses
#            (scripts/package-dev-auto.sh). The worktree shares node_modules
#            (symlinked) and the cargo target dir with the checkout, so it costs
#            what any freeze costs: the app crate recompiles, the dependencies
#            do not.
#   --tree   Freeze the WORKING TREE as it is, uncommitted edits included. The
#            default when run by hand (`npm run package:dev`): the explicit way
#            to try an uncommitted change in the frozen window.
#
# Both share the cargo target dir, so the build lands at target/release/tabtivity
# either way, and the launcher adopts it if this script recorded its hash on
# the host (scripts/lib/dev-launcher.sh).
#
# Compared with package-local.sh (the stable AppImage under the plain "Tabtivity"
# entry) this skips bundling: the release binary is linked with the frontend
# embedded and needs no FUSE/linuxdeploy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_DISPLAY, $APP_SLUG, $APP_BIN_NAME, …
. "$ROOT/scripts/lib/brand.sh"
# What the launcher trusts: the verified-build list and its own installed copy.
. "$ROOT/scripts/lib/dev-launcher.sh"
APP_DIR="$APP_SHARE_DIR"
DESKTOP_DIR="$HOME/.local/share/applications"
BINARY_DEST="$APP_DIR/$APP_DEV_BIN_NAME"
DESKTOP_DEST="$DESKTOP_DIR/${APP_DISPLAY}Dev.desktop"
# The desktop entry runs the launcher's installed copy, never the checkout's:
# an agent can edit the checkout, and the next click would run that edit
# unfenced (threat recheck 2026-10-08, gap 20). Installed below, on the host.
LAUNCHER_DIR="$(dev_launcher_dir "$APP_DIR")"
LAUNCHER="$LAUNCHER_DIR/start-$APP_SLUG-dev-build.sh"
FREEZE_TREE="$ROOT/target/freeze-tree"
# The checkout the header's dev-build chip compares the installed snapshot with
# (services::dev_build) — the main one even in --head mode, whose freeze tree
# is a detached copy that never moves. Unset in CI and every release: no chip.
app_export DEV_SOURCE_ROOT "$ROOT"

MODE=tree
for arg in "$@"; do
  case "$arg" in
    --head) MODE=head ;;
    --tree) MODE=tree ;;
    -h|--help)
      sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p}' "$0"
      exit 0 ;;
    *) echo "package-dev: unknown argument '$arg' (use --head or --tree)" >&2; exit 2 ;;
  esac
done

mkdir -p "$APP_DIR" "$DESKTOP_DIR"

export PATH="$HOME/.cargo/bin:$PATH"
# One target dir for both sources. A worktree is its own cargo workspace and
# would otherwise build into target/freeze-tree/target — a second copy of every
# dependency, and a binary the launcher never looks at.
export CARGO_TARGET_DIR="$ROOT/target"

if [ "$MODE" = head ]; then
  SRC="$FREEZE_TREE"
  HEAD_SHA="$(dev_git -C "$ROOT" rev-parse --verify "HEAD^{commit}")"

  # The worktree lives under target/, which `cargo clean` (or a hand) can wipe
  # while git still lists it, or leave a directory that git no longer knows.
  # Reconcile both ways before touching it; the rm is on one fixed path only.
  # `dev_git`: the repo's hooks and fsmonitor are fence-writable and this runs
  # on the host (a checkout would fire `post-checkout`).
  dev_git -C "$ROOT" worktree prune
  if [ -e "$SRC" ] && ! dev_git -C "$ROOT" worktree list --porcelain | grep -qxF "worktree $SRC"; then
    echo "package-dev: $SRC is not a registered worktree; recreating it" >&2
    rm -rf "$FREEZE_TREE"
  fi
  if [ ! -e "$SRC" ]; then
    dev_git -C "$ROOT" worktree add --detach "$SRC" "$HEAD_SHA"
  else
    dev_git -C "$SRC" checkout --quiet --detach --force "$HEAD_SHA"
    # Files a newer commit deleted are gone with the checkout; this clears
    # anything untracked and unignored that an older one left behind. dist/
    # and mobile-dist/ are ignored and stay; the node_modules symlink is not
    # (`node_modules/` in .gitignore matches a directory, not a link), so it is
    # excluded by name rather than deleted and re-linked on every freeze.
    dev_git -C "$SRC" clean -fdq -e node_modules
  fi
  ln -sfn "$ROOT/node_modules" "$SRC/node_modules"

  # `tauri build --no-bundle` is `npm run build` + `cargo build --release
  # --features custom-protocol`; run those two directly. tauri-cli sets up an
  # inotify watcher even for `build` and aborts when the desktop session has
  # exhausted them (see the --tree branch), and a detached background build is
  # the last place to want that.
  ( cd "$SRC" && npm run build )
  cargo build --release --features custom-protocol --manifest-path "$SRC/src-tauri/Cargo.toml"
else
  SRC="$ROOT"
  cd "$ROOT"

  # beforeBuildCommand runs `npm run build` (tsc + vite + mobile bundle), so a
  # type error anywhere fails here, same as CI.
  #
  # The fallback is for one specific failure: tauri-cli builds a file watcher
  # before it does anything, even for `build`, and the watcher needs an inotify
  # INSTANCE — a per-user resource capped at 128 (`fs.inotify.max_user_instances`)
  # that a desktop session with a running Tabtivity, a vite dev server and a browser
  # routinely sits just under. tauri-cli unwraps that error and aborts (SIGABRT,
  # "Too many open files"), which is precisely the moment this script exists for:
  # freezing the tree WHILE working. `tauri build --no-bundle` is
  # `npm run build` + `cargo build --release` with the bundling step skipped, so
  # run those two directly rather than asking the user to close things.
  #
  # `--features custom-protocol` is the part the CLI would otherwise supply, and
  # it is not optional: without it tauri compiles the app in *dev* mode, which
  # embeds no frontend and points the window at devUrl — a frozen build that
  # opens "Could not connect to localhost" and nothing else (2026-09-02).
  build_log="$(mktemp)"
  trap 'rm -f "$build_log"' EXIT
  if ! npm run tauri -- build --no-bundle 2>&1 | tee "$build_log"; then
    # Two ways inotify runs dry: no instance left ("Too many open files") and no
    # *watch* left ("OS file watch limit reached", fs.inotify.max_user_watches —
    # hit 2026-09-13 with the default 65536 and a dev server + Tabtivity watching).
    if grep -qE "Too many open files|file watch limit reached" "$build_log"; then
      echo "package-dev: tauri-cli could not set up its file watcher; building without it." >&2
      npm run build
      cargo build --release --features custom-protocol \
        --manifest-path "$ROOT/src-tauri/Cargo.toml"
    else
      exit 1
    fi
  fi
fi

# The compile is done; what follows writes the stamp and installs, and is
# seconds long. package-dev-auto.sh cancels a build for a newer commit only
# before this point — killing an `install` halfway leaves a truncated binary
# behind the desktop icon.
[ -n "${PACKAGE_DEV_INSTALLING_MARK:-}" ] && : >"$PACKAGE_DEV_INSTALLING_MARK"

RAW_BIN="$ROOT/target/release/$APP_BIN_NAME"
if [[ ! -f "$RAW_BIN" ]]; then
  echo "package-dev: release binary not found at $RAW_BIN after build" >&2
  exit 1
fi

# Whichever path built it, it has to be a prod binary: a dev one would install
# and launch fine and then show only WebKit's connection-refused page. Checked
# against the dist/ of the tree it was built FROM — the worktree's, in --head
# mode — which is the only dist/ that is guaranteed to hold still: the
# checkout's is rewritten by every `npm run build` anyone runs, and one landing
# mid-compile made a correct --tree freeze fail this very check (2026-09-14).
"$SRC/scripts/assert-embedded-frontend.sh" "$RAW_BIN"

VERSION="$(node -p "require('$SRC/package.json').version")"
COMMIT="$(dev_git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY=""
if [ "$MODE" = tree ] && ! dev_git -C "$ROOT" diff --quiet HEAD -- 2>/dev/null; then DIRTY="+local"; fi

# Record that THIS artifact passed that check, rather than re-running it at
# launch time against a dist/ that has moved on since (four days of correct
# builds were refused that way, 2026-09-14). The sha pins the record to the
# exact bytes, so a later build that fails the check cannot inherit it. The
# record beside the artifact is for the dev-build chip and for people; the
# launcher adopts only on the verified list written below.
FROZEN_STAMP="$RAW_BIN.frozen"
RAW_SHA="$(sha256sum "$RAW_BIN" | cut -d' ' -f1)"
BUILT_AT="$(date -Is)"
{
  printf 'sha256=%s\n' "$RAW_SHA"
  printf 'version=%s\n' "$VERSION"
  printf 'commit=%s%s\n' "$COMMIT" "$DIRTY"
  printf 'source=%s\n' "$MODE"
  printf 'built=%s\n' "$BUILT_AT"
} >"$FROZEN_STAMP"

# That record sits in target/, which every agent fence binding this project can
# write, so the launcher no longer trusts it. What it trusts is written here,
# on the host only: the hash goes into the per-user verified list, and the
# launcher (with every helper it sources) is copied into
# <app_dir>/dev-launcher/ — in --head mode read out of the commit itself
# (`dev_git cat-file`), never from target/freeze-tree, which a fence binding
# the project can edit while the build runs; in --tree mode from the working
# tree, uncommitted edits included, as that mode freezes them anyway.
# Inside a fence $HOME is the agent's own, so neither write could reach the
# real ones anyway; skipping them there just says so. The desktop entry is
# pointed at that copy at once, even when the install below is held back.
if dev_on_host "$APP_DIR"; then
  dev_verified_add "$(dev_verified_list "$APP_DIR")" "$RAW_SHA" "$COMMIT$DIRTY" "$VERSION" "$BUILT_AT"
  if [ "$MODE" = head ]; then
    LAUNCHER_FROM=("$ROOT" "$LAUNCHER_DIR" "$ROOT" "$HEAD_SHA")
  else
    LAUNCHER_FROM=("$ROOT" "$LAUNCHER_DIR" "$ROOT")
  fi
  if dev_launcher_install "${LAUNCHER_FROM[@]}"; then
    dev_desktop_exec "$DESKTOP_DEST" "$LAUNCHER"
  else
    echo "package-dev: could not install the launcher copy into $LAUNCHER_DIR" >&2
    exit 1
  fi
fi

# Installing into a tmpfs is not installing.
#
# Run from inside an agent tab, `services::agent_fence` has replaced $HOME with
# a tmpfs holding only the project and a couple of bound state paths. The BUILD
# above is real -- target/ is inside the bound project -- but the install below
# would write 75 MB into a directory that dies with the tab, and then print
# "Installed frozen binary". Since the post-commit hook started freezing on
# every commit, and commits are made from agent tabs, that is every freeze: the
# desktop icon opened a two-day-old window while a dozen commits each reported
# success (2026-09-04).
#
# So stop at the artifact and say so. Since 2026-10-13 the launcher no longer
# adopts it either: a build made inside a fence is not in the verified list
# (gap 20 — target/ is exactly where an agent would plant a binary). The window
# queues a build of every commit on the host (services::dev_build), and that
# one is recorded.
if ! dev_on_host "$APP_DIR"; then
  cat <<MSG
package-dev: built $RAW_BIN ($VERSION @ $COMMIT$DIRTY, from $MODE), and stopped there.
  This is running inside an agent fence ($APP_DIR is a tmpfs or the fence
  variable is set): anything installed there evaporates with the tab, and a
  build made here is not one the "$APP_DISPLAY (dev)" launcher will adopt.
  The window builds each commit outside the fence by itself; to freeze
  uncommitted edits, run npm run package:dev outside the fence.
MSG
  exit 0
fi

# Nor under a running window. The window keeps its old inode either way, but
# once the path names another file apport discards the window's core dump
# ("executable was modified after program start") — which is how all six
# main-process heap-corruption crashes of 2026-09-17..23 left nothing to read.
# A post-commit freeze almost always lands under a running window, so leave the
# snapshot where it is: the launcher adopts it on the next launch (its hash is in
# the verified list now), and the dev-build chip already offers that relaunch.
if pgrep -f "^$BINARY_DEST" >/dev/null 2>&1; then
  cat <<MSG
package-dev: built $RAW_BIN ($VERSION @ $COMMIT$DIRTY, from $MODE), and left it
  there: $APP_DISPLAY (dev) is running from $BINARY_DEST, and replacing that path
  under it costs the window its core dump if it crashes. Relaunching $APP_DISPLAY
  (dev) adopts this snapshot.
MSG
  exit 0
fi

# The running frozen instance keeps its old inode; the rename below replaces
# the path atomically, so a relaunch picks the new snapshot up. Staged and
# re-hashed first: target/ is writable from a fence, so what gets installed
# must be the bytes that were hashed above, not whatever sits there now.
STAGED="$BINARY_DEST.install.$$"
install -Dm755 "$RAW_BIN" "$STAGED"
if [ "$(sha256sum "$STAGED" | cut -d' ' -f1)" != "$RAW_SHA" ]; then
  rm -f "$STAGED"
  echo "package-dev: $RAW_BIN changed after it was built and hashed; not installing it" >&2
  exit 1
fi
mv -f "$STAGED" "$BINARY_DEST"
# The record travels with the binary: the launcher reads `<installed>.frozen`
# to say which commit it is opening and whether that is behind HEAD. Written
# from this run's own values, not copied out of target/.
{
  printf 'sha256=%s\n' "$RAW_SHA"
  printf 'version=%s\n' "$VERSION"
  printf 'commit=%s%s\n' "$COMMIT" "$DIRTY"
  printf 'source=%s\n' "$MODE"
  printf 'built=%s\n' "$BUILT_AT"
} >"$BINARY_DEST.frozen" 2>/dev/null || true
# And keep this build under dev-builds/tabtivity-<commit>: the next install
# replaces the path, and a crash in this snapshot is only symbolizable
# against these exact bytes (scripts/crash-symbolize.sh).
"$ROOT/scripts/retain-dev-build.sh" "$BINARY_DEST" "$COMMIT$DIRTY" || true

STAMP="$(date +%Y-%m-%d)"

cat >"$DESKTOP_DEST" <<DESKTOP
[Desktop Entry]
Type=Application
Name=$APP_DISPLAY (dev)
Comment=Frozen build $VERSION @ $COMMIT$DIRTY ($STAMP) — no hot reload
Exec=$(dev_desktop_quote "$LAUNCHER")
Icon=$ROOT/src-tauri/icons/128x128.png
Terminal=false
Categories=Utility;TerminalEmulator;Development;
StartupWMClass=$(basename "$BINARY_DEST")
DESKTOP
chmod 755 "$DESKTOP_DEST"
# The entry a freeze made under the app's old name pointed at the same
# launcher: remove it, so the menu shows one entry and not two.
if [ "$APP_LEGACY_DISPLAY" != "$APP_DISPLAY" ]; then
  rm -f "$DESKTOP_DIR/${APP_LEGACY_DISPLAY}Dev.desktop"
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

echo "Installed frozen binary: $BINARY_DEST ($VERSION @ $COMMIT$DIRTY, from $MODE)"
echo "Desktop entry: $DESKTOP_DEST"
