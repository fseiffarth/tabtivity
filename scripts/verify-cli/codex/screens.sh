#!/usr/bin/env bash
# Walk the Codex screens checklist §1.2 names and save their frames.
#
#   scripts/verify-cli/codex/screens.sh <label> <bin> [model]
#   → tmp/verify-cli/codex/<label>/screens/{trust,idle,model,effort,back,plan}@<cols>x<rows>.esc
#
# Folder trust question, idle, `/model` and its reasoning step, Esc back to
# idle, Shift+Tab's `Plan mode` at 100 and 60 columns. Offline: local Ollama
# provider (default model `nemotron-3.5-bolt:e4b`), `--no-daemon`, a fresh
# home per run whose work folder is its own git root. Run it for the old and
# the new label, then replay both with parsers/frames.probe.ts. An older build
# draws an "Update available" box on top: it shifts the picker rows and hides
# the welcome logo, which is not a change in the new build.
set -euo pipefail
[ $# -ge 2 ] || { sed -n '2,13p' "$0"; exit 2; }
label=$1 bin=$2 model=${3:-nemotron-3.5-bolt:e4b}
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
home="${VERIFY_OUT:-$root/tmp/verify-cli}/codex/$label/h-screens-$(date +%s)"
mkdir -p "$home/work"
git init -q "$home/work"
exec python3 "$here/../tui.py" codex "$label" screens --size 100x40 --home "$home" \
  --step sleep:6 --step cap:trust --step key:Enter --step "wait:Ask Codex:20" \
  --step sleep:2 --step cap:idle \
  --step enter:/model --step sleep:2 --step cap:model \
  --step key:Enter --step sleep:2 --step cap:effort \
  --step key:Escape --step sleep:1 --step key:Escape --step sleep:1 --step cap:back \
  --step key:BTab --step sleep:1 --step cap:plan \
  --step size:60x30 --step sleep:1 --step cap:plan \
  -- "$bin" --no-daemon -c 'model_provider="ollama"' -m "$model"
