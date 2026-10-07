#!/usr/bin/env bash
#
# Take the four numbers docs/performance_plan.md §1 asks for, from outside the
# running app, and append them to docs/performance_numbers.md so an agent can
# read them. Run from a host shell (not from an agent tab: the fence hides
# host processes) while the app is running with the usual tab set, idle.
#
#   scripts/perf-numbers.sh [label] [seconds]     default: label "before", 30 s
#   scripts/perf-numbers.sh --rss [label]         memory snapshot only (no wait)
#
# Nothing here launches, stops or touches the app; it only reads /proc.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/brand.sh
. "$ROOT/scripts/lib/brand.sh"
OUT="$ROOT/docs/performance_numbers.md"

mode=full
if [ "${1:-}" = "--rss" ]; then mode=rss; shift; fi
LABEL="${1:-before}"
WINDOW="${2:-30}"
CLK_TCK="$(getconf CLK_TCK 2>/dev/null || echo 100)"

# ---- find the processes ----------------------------------------------------
# PERF_APP_PID / PERF_RENDERER_PID override the detection when it picks wrong.
main_pid="${PERF_APP_PID:-}"
for name in "$APP_DEV_BIN_NAME" "$APP_BIN_NAME"; do
  [ -n "$main_pid" ] && break
  main_pid="$(pgrep -nx "$name" 2>/dev/null || true)"
done
if [ -z "$main_pid" ]; then
  echo "perf-numbers: no running $APP_DEV_BIN_NAME or $APP_BIN_NAME process found" >&2
  echo "perf-numbers: candidates:" >&2
  ps -eo pid,comm,args | grep -i "$APP_SLUG" | grep -v grep >&2 || true
  exit 1
fi

# Descendants of the main process (the renderer may sit under a sandbox helper).
descendants() {
  local root="$1" ps_table
  ps_table="$(ps -eo pid=,ppid= 2>/dev/null)"
  local queue=("$root") seen=()
  while [ "${#queue[@]}" -gt 0 ]; do
    local p="${queue[0]}"; queue=("${queue[@]:1}")
    while read -r pid ppid; do
      [ "$ppid" = "$p" ] || continue
      seen+=("$pid"); queue+=("$pid")
    done <<<"$ps_table"
  done
  printf '%s\n' "${seen[@]:-}"
}

renderer_pid="${PERF_RENDERER_PID:-}"; renderer_note=""
best=0
[ -n "$renderer_pid" ] && best=1
while read -r pid; do
  [ -n "$pid" ] || continue
  comm="$(cat "/proc/$pid/comm" 2>/dev/null || true)"
  case "$comm" in WebKitWebProc*) ;; *) continue ;; esac
  rss="$(awk '/^VmRSS/{print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)"
  if [ "${rss:-0}" -gt "$best" ]; then best="$rss"; renderer_pid="$pid"; fi
done < <(descendants "$main_pid")
if [ -z "$renderer_pid" ]; then
  # Fallback: the largest WebKit renderer on the machine (may belong to another app).
  while read -r pid rss; do
    if [ "${rss:-0}" -gt "$best" ]; then best="$rss"; renderer_pid="$pid"; fi
  done < <(ps -eo pid=,rss=,comm= | awk '$3 ~ /^WebKitWebProc/ {print $1, $2}')
  renderer_note=" (not a descendant of the app: largest WebKit renderer on the machine)"
fi
[ -z "$renderer_pid" ] && renderer_note=" (no WebKit renderer found; renderer numbers skipped)"
# A missing renderer must not make the helpers read the system-wide files.
rp() { [ -n "$renderer_pid" ] && echo "$renderer_pid" || echo "0"; }

# ---- helpers ----------------------------------------------------------------
# utime+stime ticks of a /proc/<pid>/stat or /proc/<pid>/task/<tid>/stat file.
cpu_ticks() { awk '{ s=$0; sub(/^.*\) /, "", s); n=split(s, f, " "); print f[12]+f[13] }' "$1" 2>/dev/null || echo 0; }
nice_of()   { awk '{ s=$0; sub(/^.*\) /, "", s); n=split(s, f, " "); print f[17] }' "$1" 2>/dev/null || echo "?"; }
mem_line()  { awk '/^VmRSS|^VmSwap/{printf "%s %s %s  ", $1, $2, $3}' "/proc/$1/status" 2>/dev/null; echo; }
ctxt()      { awk '/^voluntary_ctxt_switches/{print $2}' "/proc/$1/status" 2>/dev/null || echo 0; }
sched()     { [ "$1" != 0 ] && cat "/proc/$1/schedstat" 2>/dev/null || echo "0 0 0"; }
threads_snapshot() { # pid -> "tid ticks" lines
  local pid="$1" t
  for t in /proc/"$pid"/task/*; do
    [ -d "$t" ] || continue
    printf '%s %s\n' "${t##*/}" "$(cpu_ticks "$t/stat")"
  done
}

{
  echo
  echo "## $LABEL — $(date -u +%Y-%m-%dT%H:%M:%SZ) (window ${WINDOW}s)"
  echo
  echo "- app pid $main_pid ($(cat /proc/$main_pid/comm)), renderer pid ${renderer_pid:-none}$renderer_note"
  echo "- renderer memory: $(mem_line "$(rp)")"
  echo "- app memory: $(mem_line "$main_pid")"
  echo "- load: $(cut -d' ' -f1-3 /proc/loadavg) on $(nproc) cores"
  if [ "$mode" = rss ]; then
    echo "- memory snapshot only"
    echo
  fi
} | tee -a "$OUT"
[ "$mode" = rss ] && { echo "perf-numbers: appended to $OUT"; exit 0; }

# ---- sample ---------------------------------------------------------------
r_s0="$(sched "$(rp)")"; r_c0="$(cpu_ticks "/proc/$(rp)/stat")"
b_c0="$(cpu_ticks "/proc/$main_pid/stat")"; b_m0="$(cpu_ticks "/proc/$main_pid/task/$main_pid/stat")"
b_x0="$(ctxt "$main_pid")"
r_t0="$(threads_snapshot "$(rp)")"
# Descendants' CPU (sidecars, helpers) at start.
d0="$(for p in $(descendants "$main_pid"); do [ -r "/proc/$p/stat" ] && printf '%s %s\n' "$p" "$(cpu_ticks "/proc/$p/stat")"; done)"

echo "perf-numbers: sampling for ${WINDOW}s — leave the app idle (no typing, no tab switches)…"
sleep "$WINDOW"

r_s1="$(sched "$(rp)")"; r_c1="$(cpu_ticks "/proc/$(rp)/stat")"
b_c1="$(cpu_ticks "/proc/$main_pid/stat")"; b_m1="$(cpu_ticks "/proc/$main_pid/task/$main_pid/stat")"
b_x1="$(ctxt "$main_pid")"
r_t1="$(threads_snapshot "$(rp)")"
d1="$(for p in $(descendants "$main_pid"); do [ -r "/proc/$p/stat" ] && printf '%s %s\n' "$p" "$(cpu_ticks "/proc/$p/stat")"; done)"

pct() { # ticks delta -> % of one core over WINDOW
  awk -v d="$1" -v w="$WINDOW" -v t="$CLK_TCK" 'BEGIN { printf "%.1f", 100 * d / (w * t) }'
}

{
  set -- $r_s0; r_run0=${1:-0}; r_wait0=${2:-0}
  set -- $r_s1; r_run1=${1:-0}; r_wait1=${2:-0}
  run_ms=$(( (r_run1 - r_run0) / 1000000 )); wait_ms=$(( (r_wait1 - r_wait0) / 1000000 ))
  echo "### 1. Renderer (pid ${renderer_pid:-none})$renderer_note"
  echo
  echo "- whole process: $(pct $((r_c1 - r_c0))) % of one core; schedstat run ${run_ms} ms, runqueue wait ${wait_ms} ms over ${WINDOW} s"
  echo "- busiest threads (tid, nice, % of one core, name):"
  join <(echo "$r_t0" | sort) <(echo "$r_t1" | sort) 2>/dev/null \
    | awk -v w="$WINDOW" -v t="$CLK_TCK" '{ printf "%s %.1f\n", $1, 100 * ($3 - $2) / (w * t) }' \
    | sort -k2 -nr | head -5 \
    | while read -r tid p; do
        echo "  - $tid ni=$(nice_of "/proc/$renderer_pid/task/$tid/stat") ${p}% $(cat "/proc/$renderer_pid/task/$tid/comm" 2>/dev/null)"
      done
  echo "- rtkit: $(systemctl is-active rtkit-daemon 2>/dev/null || echo unknown)"
  echo
  echo "### 2. App process (pid $main_pid)"
  echo
  echo "- whole process: $(pct $((b_c1 - b_c0))) % of one core; main thread: $(pct $((b_m1 - b_m0))) %"
  echo "- voluntary context switches: $(( (b_x1 - b_x0) / WINDOW )) /s ($b_x0 → $b_x1)"
  echo "- threads: $(ls /proc/$main_pid/task | wc -l)"
  echo "- busiest descendants (pid, % of one core, name):"
  join <(echo "$d0" | sort) <(echo "$d1" | sort) 2>/dev/null \
    | awk -v w="$WINDOW" -v t="$CLK_TCK" '{ d = 100 * ($3 - $2) / (w * t); if (d > 0.5) printf "%s %.1f\n", $1, d }' \
    | sort -k2 -nr | head -8 \
    | while read -r pid p; do echo "  - $pid ${p}% $(cat "/proc/$pid/comm" 2>/dev/null)"; done
  echo
  echo "### 3. Memory"
  echo
  echo "- renderer: $(mem_line "$(rp)")"
  echo "- app: $(mem_line "$main_pid")"
  echo "- (run \`scripts/perf-numbers.sh --rss $LABEL-pdfs-closed\` 20 s after closing the PDF tabs for the second half)"
  echo
  echo "### 4. Stopwatch (fill in by hand)"
  echo
  echo "- switch to a streaming agent tab → first paint: ___ s"
  echo "- switch to a 100-page PDF tab → pages painted: ___ s"
  echo
} | tee -a "$OUT"

echo "perf-numbers: appended to $OUT"
