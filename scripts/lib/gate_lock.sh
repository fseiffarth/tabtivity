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
# That alone still cost one full run per waiting session once several
# sessions edit at once (2026-11-24, five agents): every edit changes the
# fingerprint, so nothing was reused and the fifth waited four runs. gates.sh
# therefore also takes the result of a run that STARTED after it was asked
# for and ran every gate it selects: the shared tree held its edits then.
# Any number of queued sessions cost one more run.
#
# The lock is held by a helper process, never by the calling shell: a lock fd
# in the shell is inherited by every gate command and whatever they spawn, so
# one process a test left behind (a tmux server, a stray worker) held the lock
# after its run ended, and every later run waited forever (2026-11-24). The
# helper lets go within 2 s of the caller's exit, however it exits.
# (gates.run.lock, not the gates.lock older scripts held that way: a leftover
# from one of those cannot block this one.)
#
#   gate_lock "<what>"   take the lock, waiting (and saying so) if it is held
#   gate_tree_fp         a fingerprint of HEAD + uncommitted + untracked files
#
# GATES_NO_LOCK=1 skips the lock (a worktree with its own CARGO_TARGET_DIR).
# GATES_LOCK_HELD is exported once held, so a gate script run by another one
# does not wait on its own parent. GATES_MAX_WAIT (seconds, default 7200)
# bounds the wait: past it the run exits 2, NOT verified, naming the holder.

gate_lock() {
  [ -n "${GATES_NO_LOCK:-}" ] && return 0
  [ -n "${GATES_LOCK_HELD:-}" ] && return 0
  command -v flock >/dev/null 2>&1 || return 0
  local gitdir lock ready t0 waited=0 said=0 owner max="${GATES_MAX_WAIT:-7200}"
  gitdir="$(git rev-parse --absolute-git-dir)"
  lock="$gitdir/gates.run.lock"
  ready="$(mktemp -u "${TMPDIR:-/tmp}/gate-lock.XXXXXX")"
  t0=$SECONDS
  if ! flock -n "$lock" true; then
    owner="$(cat "$gitdir/gates.lock.owner" 2>/dev/null || true)"
    echo "gates: another session's run holds the gate lock${owner:+ ($owner)}; waiting for it" >&2
    # Where that run is (gates.sh writes it per gate; `cat` it to follow).
    if [ -f "$gitdir/gates.progress" ]; then
      echo "gates: it is at $(cat "$gitdir/gates.progress" 2>/dev/null || true)" >&2
    fi
    said=1
  fi
  flock "$lock" bash -c 'touch "$1"; while kill -0 "$2" 2>/dev/null; do sleep 2; done' \
    gate-lock "$ready" "$$" </dev/null >/dev/null 2>&1 &
  GATE_LOCK_PID=$!
  until [ -e "$ready" ]; do
    if ! kill -0 "$GATE_LOCK_PID" 2>/dev/null; then
      echo "gates: the lock helper ended without the lock; NOT verified" >&2; exit 2
    fi
    sleep 0.2
    waited=$((SECONDS - t0))
    if [ "$waited" -ge "$max" ]; then
      kill "$GATE_LOCK_PID" 2>/dev/null || true
      echo "gates: waited ${waited}s for the gate lock ($(cat "$gitdir/gates.lock.owner" 2>/dev/null || echo "holder unknown")); NOT verified. Tell the user: that run is stuck" >&2
      exit 2
    fi
    if [ $((waited % 300)) -eq 0 ] && [ "$waited" -gt 0 ] && [ "$said" != "$waited" ]; then
      said=$waited
      echo "gates: still waiting (${waited}s); it is at $(cat "$gitdir/gates.progress" 2>/dev/null | paste -sd';' || echo "?")" >&2
    fi
  done
  rm -f "$ready"
  [ "$said" = 0 ] || echo "gates: got the lock after $((SECONDS - t0))s" >&2
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
