#!/usr/bin/env bash
# Keep the frozen dev binary that was just installed, keyed by the commit it
# was built from, so a crash can still be symbolized after the path has moved
# on.
#
#   scripts/retain-dev-build.sh <installed-binary> <commit>
#
# Every freeze replaces ~/.local/share/tabtivity/tabtivity-dev (`install` unlinks and
# recreates it, which is why a running window's /proc/self/exe reads
# "(deleted)"), so by the time a crash is looked at the build it happened in is
# gone and its `module+offset` frames name nothing — every heap-corruption
# crash of 2026-09-17..23 was lost that way, and a rebuild of the same commit
# does not reproduce the layout closely enough to trust (2026-09-23). This
# hardlinks the installed file under <app_dir>/dev-builds/tabtivity-<commit>: free
# until the next install replaces the path, then the one copy that survives.
# The crash header records `commit=<short sha>` (TABTIVITY_BUILD_COMMIT, set by
# src-tauri/build.rs), and scripts/crash-symbolize.sh looks the binary up here.
#
# The newest TABTIVITY_DEV_BUILDS_KEEP (default 6, ~90 MB each) are kept; older
# ones are pruned by build time. A `--tree` freeze of a dirty checkout is keyed
# `<sha>+local`, so it never shadows the clean build of that commit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_DISPLAY, $APP_SLUG, $APP_BIN_NAME, …
. "$ROOT/scripts/lib/brand.sh"

bin="${1:-}"
commit="${2:-}"
if [ -z "$bin" ] || [ -z "$commit" ] || [ ! -f "$bin" ]; then
  echo "usage: retain-dev-build.sh <installed-binary> <commit>" >&2
  exit 2
fi
case "$commit" in
  unknown|*/*|*' '*) exit 0 ;;
esac
keep="$(app_env DEV_BUILDS_KEEP 6)"
case "$keep" in ''|*[!0-9]*) keep=6 ;; esac

dir="$(dirname "$bin")/dev-builds"
mkdir -p "$dir"
dest="$dir/$APP_SLUG-$commit"
# Same inode as the installed file where the filesystem allows it; a copy
# where it does not. Either way the file outlives the next install.
if ! ln -f "$bin" "$dest" 2>/dev/null; then
  cp -f "$bin" "$dest.tmp" && mv -f "$dest.tmp" "$dest"
fi

# Prune: newest $keep by modification time (a hardlink carries the build's
# mtime, so this is build order, not retention order).
if [ "$keep" -gt 0 ]; then
  ls -1t "$dir/$APP_SLUG"-* 2>/dev/null | tail -n +$((keep + 1)) | while IFS= read -r old; do
    rm -f -- "$old"
  done
fi
