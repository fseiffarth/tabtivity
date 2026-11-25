#!/usr/bin/env bash
# One OpenCode round's probes for one binary, in order, into one log.
#
#   round.sh <label> <bin> <port>
#   → tmp/verify-cli/opencode/probe-<label>.log
#
# Runs turns.py (full, mini, full ask), tabby.py, resume.py, hooks.py
# events and turn, and remote_store.py, each on its own port from <port> up
# (eight ports). Run the old and the new binary at once on ports 100 apart,
# then compare the two logs with ids, pids, ports and times masked:
#
#   sed -E 's/<old>|<new>/V/g; s/(ses|sh|msg)_[A-Za-z0-9]+/ID/g' …
#
# A label's turns.py homes are reused across runs, so a rerun's `write` says
# "Wrote" (the file exists) where a fresh home says "Created".
set -u
[ $# -eq 3 ] || { sed -n '2,15p' "$0"; exit 2; }
label=$1 bin=$2 port=$3
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
S="$ROOT/scripts/verify-cli/opencode"
out="${VERIFY_OUT:-$ROOT/tmp/verify-cli}/opencode"
mkdir -p "$out"
log="$out/probe-$label.log"
cd "$ROOT" || exit 1
: > "$log"
n=0
step() { # <script> [mode] -- [extra]: the label, binary and next port go between
  local script=$1 pre=() post=()
  shift
  while [ $# -gt 0 ] && [ "$1" != -- ]; do pre+=("$1"); shift; done
  [ $# -gt 0 ] && shift
  post=("$@")
  local p=$((port + n))
  n=$((n + 1))
  echo "######## $script ${pre[*]} $label $bin $p ${post[*]}" >> "$log"
  timeout 900 python3 "$S/$script" "${pre[@]}" "$label" "$bin" "$p" "${post[@]}" >> "$log" 2>&1
  echo "######## exit $?" >> "$log"
}
step turns.py -- full
step turns.py -- mini
step turns.py -- full ask
step tabby.py
step resume.py
step hooks.py events
step hooks.py turn
step remote_store.py
echo "$log"
