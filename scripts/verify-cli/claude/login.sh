#!/usr/bin/env bash
# Claude's sign-in link as the TUI draws it: `claude auth login` in a scratch
# HOME (no login read, none written), one frame at 120x40, 80x24 and 42x24,
# then Ctrl+C before any code is pasted.
#
#   claude/login.sh <label> <claude-bin>
#   → tmp/verify-cli/claude/<label>/login/{big@120x40,mid@80x24,narrow@42x24}.esc
#
# parsers/frames.probe.ts replays the frames through the desktop's and the
# phone's sign-in readers (`signIn`): the link, its site and the flow (`code`
# for Claude's "Paste code here if prompted"). 2.1.330 shortened the link to
# `https://claude.ai/oauth/authorize?<opaque>`, which the readers missed.
set -uo pipefail
[ $# -eq 2 ] || { sed -n '2,11p' "$0"; exit 2; }
label=$1 bin=$2
case $bin in */*) bin="$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")" ;; esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
exec python3 "$ROOT/scripts/verify-cli/tui.py" claude "$label" login --size 120x40 \
  --step sleep:12 --step cap:big \
  --step size:80x24 --step sleep:2 --step cap:mid \
  --step size:42x24 --step sleep:2 --step cap:narrow \
  --step key:C-c -- "$bin" auth login
