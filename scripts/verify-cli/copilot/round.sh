#!/usr/bin/env bash
# Run every Copilot probe for one binary, in the order a round needs them:
# copilot-events-probe.py, screens.sh, chat_send.py, hooks.py events and turn,
# remote_store.py. Output goes to tmp/verify-cli/copilot/probe-<label>.log,
# each probe framed by `######## <command>` and `######## exit <code>`.
#
#   round.sh <label> <bin> <port>
#   round.sh 1.0.116 tmp/verify-cli/copilot/bin-1.0.116/package/copilot 47800
#   round.sh 1.0.117 tmp/verify-cli/copilot/bin-1.0.117/package/copilot 47900
#
# Uses five ports from <port>. Run the old and the new binary one after the
# other, not at once: remote_store.py pins a fixed tab id and lists the
# processes carrying it, so two runs at once see each other's Copilots.
# Then diff the two logs with ids, times and ports masked.
set -uo pipefail
[ $# -ge 3 ] || { sed -n '2,14p' "$0"; exit 2; }
label=$1 bin=$2 port=$3
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT" || exit 1
. "$ROOT/scripts/lib/brand.sh"
unset "${APP_ENV_PREFIX}TAB_UID" "${APP_LEGACY_ENV_PREFIX}TAB_UID"
out="${VERIFY_OUT:-$ROOT/tmp/verify-cli}/copilot"
mkdir -p "$out"
log="$out/probe-$label.log"
run() { echo "######## $*"; "$@" 2>&1; echo "######## exit $?"; }
here=scripts/verify-cli/copilot
{
  echo "######## events-probe"
  COPILOT_BIN=$bin python3 scripts/copilot-events-probe.py 2>&1
  echo "######## exit $?"
  run bash "$here/screens.sh" "$label" "$bin" "$port"
  run python3 "$here/chat_send.py" "$label" "$bin" $((port + 1))
  run python3 "$here/hooks.py" events "$label" "$bin" $((port + 2))
  run python3 "$here/hooks.py" turn "$label" "$bin" $((port + 3))
  run python3 "$here/remote_store.py" "$label" "$bin" $((port + 4))
} > "$log" 2>&1
grep -c '^######## exit 0' "$log" | sed "s|^|$log: |; s|\$| of 6 probes exited 0|"
