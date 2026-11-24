#!/usr/bin/env bash
# Detached gate run with a durable log/result, so agents need no per-gate polling.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
usage() { echo "usage: scripts/gates-job.sh start [gates.sh options] | status <job-directory> | wait <job-directory> [--timeout <s>]" >&2; exit 2; }
# Job folders of this user older than a day go at the next start (/tmp is a
# tmpfs that fills). One whose worker still runs is kept, however old.
prune_old_jobs() {
  local dir pid
  while IFS= read -r -d '' dir; do
    if [ -f "$dir/pid" ] && read -r pid <"$dir/pid" && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      continue
    fi
    rm -rf -- "$dir"
  done < <(find "${TMPDIR:-/tmp}" -mindepth 1 -maxdepth 1 -type d -name 'gates-job.*' -user "$(id -u)" -mmin +1440 -print0 2>/dev/null)
}
[ $# -gt 0 ] || usage
mode="$1"; shift
case "$mode" in
  start)
    prune_old_jobs
    job="$(mktemp -d "${TMPDIR:-/tmp}/gates-job.XXXXXX")"
    # All streams detached: the caller can exit or time out without losing the
    # run. gates.sh still owns serialization and unchanged-tree result reuse.
    command -v setsid >/dev/null 2>&1 || { echo "gates-job: setsid is required for detaching" >&2; exit 2; }
    nohup setsid bash -c '
      job="$1"; repo="$2"; shift 2
      echo "$$" >"$job/pid"
      touch "$job/started"
      rc=0
      bash "$repo/scripts/gates.sh" "$@" >"$job/output.log" 2>&1 || rc=$?
      printf "%s\n" "$rc" >"$job/exit-code.tmp"
      mv "$job/exit-code.tmp" "$job/exit-code"
    ' gates-job "$job" "$repo" "$@" </dev/null >"$job/launcher.log" 2>&1 &
    launcher=$!
    # Wait for the child to detach before the calling tool closes its session.
    for ((attempt = 0; attempt < 100; attempt++)); do
      [ -f "$job/started" ] && break
      if ! kill -0 "$launcher" 2>/dev/null; then
        cat "$job/launcher.log" >&2
        exit 2
      fi
      sleep 0.02
    done
    [ -f "$job/started" ] || { echo "gates-job: launcher did not start; see $job/launcher.log" >&2; exit 2; }
    printf 'Gate job: %s\nOnce other work is finished: scripts/gates-job.sh wait %q (exit 3 = still running: run it again)\n' "$job" "$job"
    ;;
  status|wait)
    [ $# -ge 1 ] || usage
    job="$1"; shift
    limit=50
    if [ "$mode" = wait ]; then
      case "${1:-}" in
        --timeout) [ $# -eq 2 ] || usage; limit="$2" ;;
        "") ;;
        *) usage ;;
      esac
      case "$limit" in ''|*[!0-9]*) usage ;; esac
    else
      [ $# -eq 0 ] || usage
    fi
    [ -d "$job" ] && [ -f "$job/pid" ] || { echo "gates-job: invalid job directory" >&2; exit 2; }
    # wait: block until the job has a result or its worker is gone, at most
    # <limit> seconds (default 50, under a 60 s tool call); then report as status does.
    if [ "$mode" = wait ]; then
      read -r pid <"$job/pid"
      for ((n = 0; n < limit * 5; n++)); do
        [ -f "$job/exit-code" ] && break
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
      done
    fi
    if [ -f "$job/exit-code" ]; then
      read -r rc <"$job/exit-code"
      if [ "$rc" = 0 ]; then
        # Print only the final summary, including when gates.sh reused a run.
        awk '/^== gates ==/ { summary = 1 } summary' "$job/output.log"
      elif grep -q '^--- .* failed; last lines of ' "$job/output.log"; then
        # Every failed gate's tail (two lanes can fail) and the summary.
        sed -n '/^--- .* failed; last lines of /,$p' "$job/output.log"
      else
        tail -80 "$job/output.log"
      fi
      printf 'Gate job finished (exit %s). Full log: %s/output.log\n' "$rc" "$job"
      exit "$rc"
    fi
    read -r pid <"$job/pid"
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Gate job stopped without a result; NOT verified. Log: $job/output.log" >&2
      exit 2
    fi
    # The last thing it said: queued behind another session's run, or a gate's progress.
    last_line="$(grep -v '^$' "$job/output.log" 2>/dev/null | tail -1 || true)"
    echo "Gate job running${last_line:+ ($last_line)}. Log: $job/output.log"
    if [ "$mode" = wait ]; then
      # 3, not 0: still running is no result (status exits 0 there; older callers rely on it).
      echo "Not finished yet: run 'scripts/gates-job.sh wait $(printf %q "$job")' again."
      exit 3
    fi
    ;;
  *) usage ;;
esac
