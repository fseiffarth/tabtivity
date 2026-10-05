#!/usr/bin/env bash
set -euo pipefail

machine=false
if [[ "${1:-}" == "--url" ]]; then
  machine=true
elif [[ $# -ne 0 ]]; then
  echo "usage: $0 [--url]" >&2
  exit 2
fi

# The app writes this script into <state dir>/mobile-control/ and runs it from
# there, so the state dir is the folder above — whatever it is called and
# wherever an override put it. Run from a checkout instead, fall back to
# storage::state_dir's default: XDG on Linux, Application Support on macOS.
state_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -r "$state_dir/settings.json" ]]; then
  state_dir="${XDG_DATA_HOME:-$HOME/.local/share}/tabtivity"
  if [[ ! -r "$state_dir/settings.json" && -r "$HOME/Library/Application Support/tabtivity/settings.json" ]]; then
    state_dir="$HOME/Library/Application Support/tabtivity"
  fi
fi
settings="$state_dir/settings.json"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v tailscale >/dev/null || { echo "Tailscale is not installed" >&2; exit 1; }
[[ -r "$settings" ]] || { echo "Tabtivity settings are unavailable" >&2; exit 1; }

port="$(jq -r '.tabtivity_mobile_host.port // 8742' "$settings")"
origin="$(jq -r '.tabtivity_mobile_host.serve_origin // empty' "$settings")"
[[ "$origin" =~ ^https://([^/:]+)(:([0-9]+))?$ ]] || {
  echo "No verified exact HTTPS Serve origin is configured" >&2
  exit 1
}
serve_host="${BASH_REMATCH[1]}"
public_port="${BASH_REMATCH[3]:-443}"
authority="$serve_host:$public_port"

serve_json="$(tailscale serve status --json)"
needle="http://127.0.0.1:$port"
jq -e --arg authority "$authority" --arg needle "$needle" --arg public_port "$public_port" '
  .TCP[$public_port].HTTPS == true
  and .Web[$authority].Handlers["/"].Proxy == $needle
  and ((.AllowFunnel[$authority] // false) | not)
' <<<"$serve_json" >/dev/null || {
  echo "Tailscale Serve does not have the verified private root mapping to the configured loopback port" >&2
  exit 1
}

if $machine; then
  printf '%s\n' "$origin"
  exit 0
fi

echo "Open this private URL on your phone:"
echo "$origin"
if command -v qrencode >/dev/null; then
  # Do not request ANSI black/white: Tabtivity maps those palette slots to the
  # active theme (lavender in particular), which can make a camera QR scan
  # unreliable. Plain UTF-8 uses the terminal's normal foreground/background
  # pair instead, whose contrast is selected with the rest of the theme.
  qrencode -t UTF8 "$origin"
else
  echo "Install qrencode to print a terminal QR code."
fi
echo "Then use Install app / Add to Home Screen and pair it from Tabtivity Settings."
