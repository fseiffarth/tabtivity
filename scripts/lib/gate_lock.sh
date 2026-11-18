# shellcheck shell=bash
# One gate run at a time per checkout. SOURCED by scripts/gates.sh and
# scripts/ci-local.sh.
#
# Why: agent tabs share this working tree and its target/, so two sessions'
# gates used to start together and block each other on cargo's target lock
# while their vitest/tsc fought for the same cores. Each run then took the sum
# of all of them, and none finished sooner. Since the tree is shared, they
# were also checking the same thing. A run now waits for the one in flight
# (flock on <git dir>/gates.lock, released when its holder exits, however it
# exits). gates.sh then reuses that run's result when the tree has not
# changed since it started (gate_tree_fp).
#
#   gate_lock "<what>"   take the lock, waiting (and saying so) if it is held
#   gate_tree_fp         a fingerprint of HEAD + uncommitted + untracked files
#
# GATES_NO_LOCK=1 skips the lock (a worktree with its own CARGO_TARGET_DIR).
# GATES_LOCK_HELD is exported once held, so a gate script run by another one
# does not wait on its own parent.

gate_lock() {
  [ -n "${GATES_NO_LOCK:-}" ] && return 0
  [ -n "${GATES_LOCK_HELD:-}" ] && return 0
  command -v flock >/dev/null 2>&1 || return 0
  local gitdir t0 owner
  gitdir="$(git rev-parse --absolute-git-dir)"
  exec 8>>"$gitdir/gates.lock"
  if ! flock -n 8; then
    owner="$(cat "$gitdir/gates.lock.owner" 2>/dev/null || true)"
    echo "gates: another session's run holds the gate lock${owner:+ ($owner)}; waiting for it" >&2
    # Where that run is (gates.sh writes it per gate; `cat` it to follow).
    if [ -f "$gitdir/gates.progress" ]; then
      echo "gates: it is at $(cat "$gitdir/gates.progress" 2>/dev/null || true)" >&2
    fi
    t0=$EPOCHREALTIME
    flock 8
    echo "gates: got the lock after $(awk -v a="$t0" -v b="$EPOCHREALTIME" 'BEGIN { printf "%d", b - a }')s" >&2
  fi
  printf 'pid %s, %s, since %s\n' "$$" "$1" "$(date +%H:%M:%S)" >"$gitdir/gates.lock.owner"
  export GATES_LOCK_HELD=1
}

# HEAD, the diff against it, and every untracked (not ignored) file's name and
# blob id. Equal fingerprints = the gates would check the same tree.
gate_tree_fp() {
  {
    git rev-parse HEAD
    git diff HEAD --binary --no-ext-diff --no-textconv
    git ls-files -o --exclude-standard -z \
      | xargs -0 -r sh -c 'for f; do printf "%s " "$f"; git hash-object --no-filters -- "$f" 2>/dev/null || echo gone; done' sh
  } | git hash-object --stdin
}
