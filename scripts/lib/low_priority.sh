# shellcheck shell=bash
# Re-run the calling script at the lowest priority the machine offers:
# SCHED_IDLE (chrt), idle I/O class (ionice), nice 19. SOURCED, never run, by
# scripts/gates.sh and scripts/ci-local.sh, right after `set -euo pipefail`:
#
#   . "$repo/scripts/lib/low_priority.sh"
#   low_priority_reexec "$repo/scripts/<this script>" "$@"
#
# Why: the gates are mostly run from agent tabs inside the window they build,
# and cargo/rustc/vitest at nice 0 on every core put the window's one renderer
# thread in a runqueue — typing lags by seconds while compositor-driven work
# (scrolling a PDF) stays smooth (2026-10-14; the same diagnosis as SCHED_IDLE
# on batch simulations, 2026-08-07). On SCHED_IDLE the gates still take every
# idle core; they only stop winning against the UI. package-dev-auto.sh puts
# the frozen dev build in the same posture.
#
# GATES_FULL_PRIORITY=1 skips it (a quiet machine and a hurry). The marker
# variable keeps a re-exec from recursing and is inherited, so a gate script
# calling another one does not re-exec again.

low_priority_reexec() {
  local script="$1"; shift
  [ -n "${GATES_FULL_PRIORITY:-}" ] && return 0
  [ -n "${GATES_LOW_PRIORITY_APPLIED:-}" ] && return 0
  local -a low=()
  command -v chrt >/dev/null 2>&1 && chrt --idle 0 true 2>/dev/null && low+=(chrt --idle 0)
  command -v ionice >/dev/null 2>&1 && ionice -c 3 true 2>/dev/null && low+=(ionice -c 3)
  command -v nice >/dev/null 2>&1 && low+=(nice -n 19)
  [ ${#low[@]} -gt 0 ] || return 0
  export GATES_LOW_PRIORITY_APPLIED=1
  exec "${low[@]}" bash "$script" "$@"
}
