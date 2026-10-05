#!/usr/bin/env bash
# Resolve the newest native-crash entry in crash.log to file:line.
#
# The signal handler in src-tauri/src/lib.rs writes a glibc backtrace as
# `module(+offset) [abs]` lines — no symbols, because resolving them is not
# async-signal-safe. This turns each Tabtivity frame into `function at file:line`
# with addr2line against the executable named on the crash's `exe=` line (the
# offsets are only valid for that exact binary — a re-frozen dev build shifts
# them), and each system-library frame into `function` via its exported symbols.
#
#   scripts/crash-symbolize.sh                      # newest crash in the state dir's crash.log
#   scripts/crash-symbolize.sh path/to/crash.log    # a copied log
#   scripts/crash-symbolize.sh -n 2                 # the second-newest crash
#   scripts/crash-symbolize.sh --force              # resolve anyway (see below)
#
# The binary must be the SAME BUILD the crash came from, and usually it is not:
# every commit re-freezes the dev build, so a window that has been open a while
# outlives its own binary. Two tells, both checked here, because names resolved
# against a shifted layout are not "roughly right" — they are unrelated
# functions, and they read as plausible (calamine, idna, `set_project_openvpn`
# for a crash in none of them; 2026-09-17). The kernel appends `(deleted)` to
# `/proc/self/exe` once the file has been replaced under the running process,
# and a binary whose mtime is newer than the crash was installed after it. On
# either, Tabtivity frames are left unresolved unless `--force`; system-library
# frames resolve regardless, since those come from packages, not this build.
# So each installed dev build is also kept under
# `<state dir>/dev-builds/tabtivity-<commit>` (scripts/retain-dev-build.sh, from
# package-dev.sh and the launcher), and the crash header records
# `commit=<short sha>`: when the recorded path is stale, the retained copy for
# that commit is used instead. Rebuilding the commit is NOT a substitute — a
# rebuild of the very same commit with the same toolchain came out with a
# different code layout (2026-09-23), so its names are the plausible-but-wrong
# kind described above. Crashes from before the header carried a commit can
# only be mapped by launch time via package-dev-auto.log, and stay unresolved.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_DISPLAY, $APP_SLUG, $APP_BIN_NAME, …
. "$ROOT/scripts/lib/brand.sh"

nth=1
force=0
log="$(app_env STATE_DIR "$APP_SHARE_DIR")/crash.log"
while [ $# -gt 0 ]; do
  case "$1" in
    -n) nth="$2"; shift 2 ;;
    -f|--force) force=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) log="$1"; shift ;;
  esac
done
[ -r "$log" ] || { echo "no readable crash.log at $log" >&2; exit 1; }
command -v addr2line >/dev/null || { echo "addr2line (binutils) is not installed" >&2; exit 1; }

# The nth-newest block from a `=== CRASH: <SIG> code=` header to `=== CRASH END ===`.
block=$(awk -v want="$nth" '
  /^=== CRASH: [A-Z]+ code=/ { blk = $0 "\n"; inblk = 1; next }
  inblk { blk = blk $0 "\n" }
  /^=== CRASH END ===/ { if (inblk) { blocks[++n] = blk }; inblk = 0 }
  END { if (n >= want) printf "%s", blocks[n - want + 1] }
' "$log")
[ -n "$block" ] || { echo "no complete crash entry #$nth in $log (an older, one-line entry has no trace)" >&2; exit 1; }

exe=$(printf '%s' "$block" | sed -n 's/.* exe=\([^ ]*\) .*/\1/p' | head -1)
exe_recorded="$exe"   # the path as recorded; `exe` below doubles as "usable"
ctx=$(printf '%s' "$block" | sed -n '2p')
printf '%s\n' "$block" | sed -n '1,2p'
echo

# Is the file at `exe` still the build that crashed? Two independent tells.
stale=""
case "$ctx" in
  *"(deleted)"*) stale="the running binary had already been replaced on disk (the record says \"(deleted)\")" ;;
esac
crash_at=$(printf '%s' "$ctx" | sed -n 's/^  at \([0-9T:-]*Z\) .*/\1/p')
if [ -z "$stale" ] && [ -n "$crash_at" ] && [ -r "$exe" ]; then
  crash_epoch=$(date -u -d "$crash_at" +%s 2>/dev/null || echo "")
  exe_epoch=$(date -u -r "$exe" +%s 2>/dev/null || echo "")
  if [ -n "$crash_epoch" ] && [ -n "$exe_epoch" ] && [ "$exe_epoch" -gt "$crash_epoch" ]; then
    stale="$exe was installed $(( (exe_epoch - crash_epoch) / 60 )) min AFTER the crash"
  fi
fi

# The retained copy of the build that crashed, if the header names its commit
# and scripts/retain-dev-build.sh kept it. A `+local` copy is a dirty-tree
# freeze of that commit — the same bytes only if the crash ran that freeze.
commit=$(printf '%s' "$ctx" | sed -n 's/.* commit=\([^ ]*\).*/\1/p' | head -1)
retained=""
if [ -n "$commit" ] && [ "$commit" != unknown ] && [ -n "$exe_recorded" ]; then
  for cand in "$(dirname "$exe_recorded")/dev-builds/$APP_SLUG-$commit" \
              "$(dirname "$exe_recorded")/dev-builds/$APP_SLUG-$commit+local"; do
    if [ -r "$cand" ]; then retained="$cand"; break; fi
  done
fi
if [ -n "$retained" ] && { [ -n "$stale" ] || [ ! -r "$exe" ]; }; then
  echo "note: the recorded binary is stale; resolving $APP_DISPLAY frames against the retained" >&2
  echo "      build of commit $commit: $retained" >&2
  case "$retained" in
    *+local) echo "      (a dirty-tree freeze of that commit — only right if the crash ran that freeze)" >&2 ;;
  esac
  exe="$retained"
  stale=""
fi

if [ -n "$exe" ] && [ ! -r "$exe" ]; then
  echo "note: $exe is gone or unreadable; $APP_DISPLAY frames stay unresolved" >&2
  exe=""
elif [ -n "$stale" ]; then
  if [ "$force" = 1 ]; then
    echo "WARNING: $stale — every $APP_DISPLAY name below is resolved against a different" >&2
    echo "         layout and is almost certainly wrong (--force was passed)." >&2
  else
    echo "note: $stale, so its offsets no longer name anything in it." >&2
    echo "      $APP_DISPLAY frames stay unresolved; --force resolves them anyway." >&2
    exe=""
  fi
fi

printf '%s\n' "$block" | grep -E '^[^ ].*\(\+0x[0-9a-f]+\)' | while IFS= read -r line; do
  module=${line%%(*}
  offset=$(printf '%s' "$line" | sed -n 's/.*(+\(0x[0-9a-f]*\)).*/\1/p')
  [ -n "$offset" ] || { echo "  $line"; continue; }
  if [ -z "$exe" ] && [ "$module" = "$exe_recorded" ]; then
    resolved="?? (not resolved: the binary on disk is not this build)"
  elif [ "$module" = "$exe_recorded" ]; then
    # Tabtivity's own frames: against the recorded file, or the retained copy.
    resolved=$(addr2line -e "$exe" -f -C -i -p "$offset" 2>/dev/null | head -3 | paste -sd '|' -)
    [ -n "$resolved" ] || resolved="?? (no symbols in $exe)"
  elif [ -r "$module" ]; then
    resolved=$(addr2line -e "$module" -f -C -i -p "$offset" 2>/dev/null | head -3 | paste -sd '|' -)
    [ -n "$resolved" ] || resolved="?? (no symbols in $module)"
  else
    resolved="?? ($module not readable)"
  fi
  printf '  %-56s %s\n' "${module##*/}(+$offset)" "$resolved"
done
