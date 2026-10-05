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
# either way and the launcher adopts whichever was verified last.
#
# Compared with package-local.sh (the stable AppImage under the plain "Tabtivity"
# entry) this skips bundling: the release binary is linked with the frontend
# embedded and needs no FUSE/linuxdeploy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_DISPLAY, $APP_SLUG, $APP_BIN_NAME, …
. "$ROOT/scripts/lib/brand.sh"
APP_DIR="$APP_SHARE_DIR"
DESKTOP_DIR="$HOME/.local/share/applications"
BINARY_DEST="$APP_DIR/$APP_DEV_BIN_NAME"
DESKTOP_DEST="$DESKTOP_DIR/${APP_DISPLAY}Dev.desktop"
LAUNCHER="$ROOT/start-$APP_SLUG-dev-build.sh"
FREEZE_TREE="$ROOT/target/freeze-tree"
LIVE_PWA_DIR="$ROOT/target/mobile-pwa"

# The phone's bundle, published where a RUNNING sidecar can find it.
#
# The PWA is compiled into the binary, and the running window keeps its old
# inode across an install, so freezing a commit never reached the phone until
# the user relaunched — that is how a bundle days behind kept being served with
# nothing saying so. A published copy costs the sidecar one stat per request and
# closes the gap without a relaunch: the phone reloads over HTTP, so a
# pull-to-refresh is the whole update path (src-tauri/.../live_pwa.rs).
#
# Published from the tree that was just BUILT, before cargo starts: the bundle
# takes two seconds and the compile takes two minutes, and the phone has no
# reason to wait for the second.
#
# Written to target/ rather than under $HOME on purpose — commits come from
# agent tabs, where `services::agent_fence` has replaced $HOME with a tmpfs that
# dies with the tab (see the install guard below), while target/ is inside the
# bound project and is real.
publish_live_pwa() {
  local src="$1/mobile-dist" commit="$2"
  [ -d "$src" ] || { echo "package-dev: no $src to publish for the phone" >&2; return 0; }

  local tmp="$LIVE_PWA_DIR.tmp.$$"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  cp -a "$src/." "$tmp/"

  # The stamp is the whole contract: `built` is what stops an overlay from
  # shadowing a NEWER binary, and `entry` is what lets the loader refuse half a
  # bundle rather than serve a shell pointing at a script it does not have.
  local entry
  entry="$(cd "$tmp" && ls -1 assets/index-*.js 2>/dev/null | head -n1 || true)"
  if [ -z "$entry" ] || [ ! -f "$tmp/index.html" ]; then
    echo "package-dev: $src is not a whole bundle; the phone keeps the embedded one" >&2
    rm -rf "$tmp"
    return 0
  fi
  {
    printf 'built=%s\n' "$(date +%s)"
    printf 'commit=%s\n' "$commit"
    printf 'entry=/%s\n' "$entry"
  } >"$tmp/.stamp"

  # Swap rather than overwrite: the sidecar reads these files while this runs,
  # and a half-copied directory is a white screen. The gap between the two
  # renames is a few milliseconds during which the loader finds no stamp and the
  # binary answers from its embedded bundle, which is the safe direction.
  rm -rf "$LIVE_PWA_DIR.old"
  [ -d "$LIVE_PWA_DIR" ] && mv "$LIVE_PWA_DIR" "$LIVE_PWA_DIR.old"
  mv "$tmp" "$LIVE_PWA_DIR"
  rm -rf "$LIVE_PWA_DIR.old"
  echo "package-dev: published the phone bundle ($commit) to $LIVE_PWA_DIR"
}

# Compiled into the binary as the one directory it may serve a newer bundle
# from. Unset in CI and in every release build, where the overlay does not exist
# at all.
app_export MOBILE_LIVE_DIR "$LIVE_PWA_DIR"
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
  HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD)"

  # The worktree lives under target/, which `cargo clean` (or a hand) can wipe
  # while git still lists it, or leave a directory that git no longer knows.
  # Reconcile both ways before touching it; the rm is on one fixed path only.
  git -C "$ROOT" worktree prune
  if [ -e "$SRC" ] && ! git -C "$ROOT" worktree list --porcelain | grep -qxF "worktree $SRC"; then
    echo "package-dev: $SRC is not a registered worktree; recreating it" >&2
    rm -rf "$FREEZE_TREE"
  fi
  if [ ! -e "$SRC" ]; then
    git -C "$ROOT" worktree add --detach "$SRC" "$HEAD_SHA"
  else
    git -C "$SRC" checkout --quiet --detach --force "$HEAD_SHA"
    # Files a newer commit deleted are gone with the checkout; this clears
    # anything untracked and unignored that an older one left behind. dist/
    # and mobile-dist/ are ignored and stay; the node_modules symlink is not
    # (`node_modules/` in .gitignore matches a directory, not a link), so it is
    # excluded by name rather than deleted and re-linked on every freeze.
    git -C "$SRC" clean -fdq -e node_modules
  fi
  ln -sfn "$ROOT/node_modules" "$SRC/node_modules"

  # `tauri build --no-bundle` is `npm run build` + `cargo build --release
  # --features custom-protocol`; run those two directly. tauri-cli sets up an
  # inotify watcher even for `build` and aborts when the desktop session has
  # exhausted them (see the --tree branch), and a detached background build is
  # the last place to want that.
  ( cd "$SRC" && npm run build )
  publish_live_pwa "$SRC" "$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
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
COMMIT="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY=""
if [ "$MODE" = tree ] && ! git -C "$ROOT" diff --quiet HEAD -- 2>/dev/null; then DIRTY="+local"; fi

# --head published the phone bundle before cargo started, so a commit reaches the
# phone in seconds rather than after the compile. --tree has no such hurry and
# publishes here, once the build it is freezing has actually succeeded.
if [ "$MODE" = tree ]; then
  publish_live_pwa "$SRC" "$COMMIT$DIRTY"
fi

# Record that THIS artifact passed that check. The launcher adopts on this
# record rather than re-running the check at launch time against a dist/ that
# has moved on since (four days of correct builds were refused that way,
# 2026-09-14). The sha pins the record to the exact bytes, so a later build
# that fails the check cannot inherit it.
FROZEN_STAMP="$RAW_BIN.frozen"
{
  printf 'sha256=%s\n' "$(sha256sum "$RAW_BIN" | cut -d' ' -f1)"
  printf 'version=%s\n' "$VERSION"
  printf 'commit=%s%s\n' "$COMMIT" "$DIRTY"
  printf 'source=%s\n' "$MODE"
  printf 'built=%s\n' "$(date -Is)"
} >"$FROZEN_STAMP"

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
# So stop at the artifact and say so. start-tabtivity-dev-build.sh adopts it at
# launch, in the user's own session, where no fence can swallow it.
if [ "$(stat -f -c %T "$APP_DIR" 2>/dev/null || echo unknown)" = "tmpfs" ] ||
   [ "$(app_env AGENT_FENCE)" = "1" ]; then
  cat <<MSG
package-dev: built $RAW_BIN ($VERSION @ $COMMIT$DIRTY, from $MODE), and stopped there.
  $APP_DIR is a tmpfs, so this is running inside an agent fence and anything
  installed there evaporates with the tab. The build is real; the install
  would not be.
  The "$APP_DISPLAY (dev)" launcher adopts that binary on its next start, so
  relaunching $APP_DISPLAY (dev) picks this snapshot up. Nothing else to do.
MSG
  exit 0
fi

# Nor under a running window. The window keeps its old inode either way, but
# once the path names another file apport discards the window's core dump
# ("executable was modified after program start") — which is how all six
# main-process heap-corruption crashes of 2026-09-17..23 left nothing to read.
# A post-commit freeze almost always lands under a running window, so leave the
# snapshot where it is: start-tabtivity-dev-build.sh adopts it on the next launch,
# and the dev-build chip already offers that relaunch.
if pgrep -f "^$BINARY_DEST" >/dev/null 2>&1; then
  cat <<MSG
package-dev: built $RAW_BIN ($VERSION @ $COMMIT$DIRTY, from $MODE), and left it
  there: $APP_DISPLAY (dev) is running from $BINARY_DEST, and replacing that path
  under it costs the window its core dump if it crashes. Relaunching $APP_DISPLAY
  (dev) adopts this snapshot.
MSG
  exit 0
fi

# The running frozen instance keeps its old inode; `install` replaces the path
# atomically enough that a relaunch picks the new snapshot up.
install -Dm755 "$RAW_BIN" "$BINARY_DEST"
# The record travels with the binary: the launcher reads `<installed>.frozen`
# to say which commit it is opening and whether that is behind HEAD.
install -m644 "$FROZEN_STAMP" "$BINARY_DEST.frozen" 2>/dev/null || true
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
Exec=$LAUNCHER
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
