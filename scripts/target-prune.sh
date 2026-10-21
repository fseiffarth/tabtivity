#!/usr/bin/env bash
# Keep the cargo target dir under a size cap. Called after every auto dev build
# (scripts/package-dev-auto.sh); runnable by hand.
#
#   scripts/target-prune.sh             # prune if over the cap
#   scripts/target-prune.sh --dry-run   # say what it would delete
#
# target/ grew past 1 TB: every `cargo test`/`clippy` feature combination keeps
# its own incremental dir (~4 GB each for the app crate), dependency artifacts
# of old hashes are never collected, and the Windows/macOS cross-checks keep
# their own full trees. None of it is source of truth; all of it is rebuilt on
# demand. Under the cap this does nothing. Over it, cheapest-to-rebuild first,
# stopping as soon as the size is back under the cap:
#   1. incremental dirs, oldest first (any target triple)
#   2. debug/examples
#   3. dependency artifacts in */deps not read for DEPS_DAYS days
#   4. the cross-check trees (x86_64-pc-windows-msvc, aarch64-apple-darwin)
# Never touched: release/ (the frozen dev build's cargo cache) and freeze-tree/.
#
# It does nothing while any cargo/rustc runs (another session's test run would
# lose its incremental state mid-compile).
#
# Env: TARGET_PRUNE_CAP_GB (default 250), TARGET_PRUNE_DEPS_DAYS (default 7),
# CARGO_TARGET_DIR (default <repo>/target).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${CARGO_TARGET_DIR:-$ROOT/target}"
CAP_KB=$(( ${TARGET_PRUNE_CAP_GB:-250} * 1024 * 1024 ))
DEPS_DAYS="${TARGET_PRUNE_DEPS_DAYS:-7}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

note() { printf '%s target-prune: %s\n' "$(date -Is)" "$*"; }

[ -d "$TARGET" ] || exit 0

# Exact process names (no -f: a pattern match would find this very script).
if pgrep -x 'cargo|rustc|rustdoc|clippy-driver' >/dev/null 2>&1; then
  note "cargo/rustc is running — leaving $TARGET alone"
  exit 0
fi

size_kb() { du -sk --exclude=freeze-tree "$TARGET" 2>/dev/null | cut -f1; }

used=$(size_kb)
if [ "${used:-0}" -le "$CAP_KB" ]; then
  note "$((used / 1048576)) GB used, cap $((CAP_KB / 1048576)) GB — nothing to do"
  exit 0
fi
note "$((used / 1048576)) GB used, cap $((CAP_KB / 1048576)) GB — pruning"

over() { used=$(size_kb); [ "${used:-0}" -gt "$CAP_KB" ]; }

drop() { # path…
  local p
  for p in "$@"; do
    if [ "$DRY" = 1 ]; then echo "would remove $p"; else rm -rf -- "$p"; fi
  done
}

# 1. Incremental dirs, oldest first. Under DRY nothing shrinks, so the loop
#    lists them all.
while IFS= read -r dir; do
  [ "$DRY" = 1 ] || over || break
  drop "$dir"
done < <(find "$TARGET" -maxdepth 4 -type d -path '*/incremental/*' -prune -printf '%T@ %p\n' 2>/dev/null \
  | sort -n | cut -d' ' -f2-)

# 2. Examples.
if [ "$DRY" = 1 ] || over; then
  for d in "$TARGET"/debug/examples "$TARGET"/*/debug/examples; do
    [ -d "$d" ] && drop "$d"
  done
fi

# 3. Dependency artifacts nothing has read for a while. A missing artifact only
#    makes cargo rebuild that unit; relatime keeps atime fresh for what is used.
if [ "$DRY" = 1 ] || over; then
  for d in "$TARGET"/debug/deps "$TARGET"/*/debug/deps; do
    [ -d "$d" ] || continue
    if [ "$DRY" = 1 ]; then
      echo "would remove $(find "$d" -maxdepth 1 -type f -atime +"$DEPS_DAYS" | wc -l) stale files in $d"
    else
      find "$d" -maxdepth 1 -type f -atime +"$DEPS_DAYS" -delete 2>/dev/null
    fi
  done
fi

# 4. The cross-check trees.
for t in x86_64-pc-windows-msvc aarch64-apple-darwin; do
  [ -d "$TARGET/$t" ] || continue
  [ "$DRY" = 1 ] || over || break
  drop "$TARGET/$t"
done

[ "$DRY" = 1 ] || note "now $(( $(size_kb) / 1048576 )) GB"
exit 0
