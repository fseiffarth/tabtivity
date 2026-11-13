#!/usr/bin/env bash
# Walk the Copilot screens checklist §1.5 names and save their frames.
#
#   scripts/verify-cli/copilot/screens.sh <label> <bin> [port]
#   → tmp/verify-cli/copilot/<label>/tui/{trust,idle,approval,after}@<cols>x<rows>.esc
#
# Offline: BYOK against stub_openai.py (`COPILOT_PROVIDER_*`, model `stub`),
# auto-update off, a fresh home per label. The folder trust question, idle,
# the `create` approval the stub forces at 110 and 60 columns, then Esc on it.
# Run it for the old and the new label, then replay both with
# parsers/frames.probe.ts (VERIFY_CLI=copilot).
set -euo pipefail
[ $# -ge 2 ] || { sed -n '2,11p' "$0"; exit 2; }
label=$1 bin=$2 port=${3:-47410}
case $bin in */*) bin="$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")" ;; esac
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
home="${VERIFY_OUT:-$root/tmp/verify-cli}/copilot/$label/h-tui-$(date +%s)"
mkdir -p "$home/work"
exec python3 "$here/../tui.py" copilot "$label" tui --size 110x40 --home "$home" \
  --stub openai --port "$port" \
  --env "COPILOT_HOME=$home/.copilot" --env COPILOT_AUTO_UPDATE=false \
  --env "COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:$port/v1" \
  --env COPILOT_PROVIDER_API_KEY=test --env COPILOT_MODEL=stub \
  --step sleep:6 --step cap:trust --step key:Enter --step sleep:4 --step cap:idle \
  --step 'enter:STUB:CALL create {"path": "a.txt", "file_text": "hi\n"}' \
  --step "wait:Do you want:30" --step sleep:1 --step cap:approval \
  --step size:60x30 --step sleep:2 --step cap:approval \
  --step key:Escape --step sleep:3 --step cap:after \
  -- "$bin" --disable-client-telemetry
