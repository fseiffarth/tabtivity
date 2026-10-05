#!/usr/bin/env bash
#
# Capture a screenshot of the running Tabtivity instance for the README.
#
# This does NOT launch Tabtivity (launching a second instance can corrupt
# workspace state). It captures the existing Tabtivity window, so put it into
# the state you want first:
#
#   1. Focus Tabtivity.
#   2. Press F11 to enter fullscreen.
#   3. Press Super to open the bars / panels.
#
# Then run this script (or run it first and switch to Tabtivity during the
# countdown). It targets the Tabtivity window directly, so it works on a
# multi-monitor setup and crops out everything else.
#
# Usage:
#   scripts/take-screenshot.sh [output_path] [delay_seconds]
#
# Defaults: screenshots/eldrun-current.png, 5s delay.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$REPO_ROOT/screenshots/eldrun-current.png}"
DELAY="${2:-5}"

mkdir -p "$(dirname "$OUT")"

for bin in import xwininfo; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "error: required tool '$bin' not found." >&2
    exit 1
  fi
done

# Find the Tabtivity window id. Multiple windows share the tabtivity class
# (a tiny 10x10 helper window exists too), so pick the largest by area.
find_window() {
  xwininfo -root -tree 2>/dev/null \
    | grep -E '\("tabtivity" "Tabtivity"\)' \
    | awk '{
        id = $1
        for (i = 1; i <= NF; i++) {
          if ($i ~ /^[0-9]+x[0-9]+\+/) {
            split($i, d, /[x+]/)
            area = d[1] * d[2]
            if (area > best) { best = area; bestid = id }
          }
        }
      }
      END { if (bestid != "") print bestid }'
}

WID="$(find_window)"
if [[ -z "$WID" ]]; then
  echo "error: no running Tabtivity window found. Start Tabtivity first." >&2
  exit 1
fi

echo "Tabtivity window: $WID"
echo "Switch to Tabtivity (F11 fullscreen, Super to open bars)."
for ((i = DELAY; i > 0; i--)); do
  printf '\rCapturing in %2ds... ' "$i"
  sleep 1
done
printf '\rCapturing now.        \n'

# -frame would include the WM titlebar; omit it for a clean client-area shot.
import -window "$WID" "$OUT"

echo "Saved: $OUT"
import -ping "$OUT" >/dev/null 2>&1 || true
identify "$OUT" 2>/dev/null || true
