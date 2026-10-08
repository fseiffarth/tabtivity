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
# JSON is read with python3 where there is one (stock on macOS), else jq;
# neither is a hard requirement on its own. python3 is probed by running it:
# macOS's /usr/bin/python3 is a stub that fails until the Command Line Tools
# are installed, and jq should get its turn then.
if python3 -I -c 'import json' >/dev/null 2>&1; then
  # mobile_setting KEY DEFAULT — `.tabtivity_mobile_host.KEY`, or DEFAULT.
  mobile_setting() {
    python3 -I -c '
import json, sys
with open(sys.argv[1]) as f:
    settings = json.load(f)
value = (settings.get("tabtivity_mobile_host") or {}).get(sys.argv[2])
print(sys.argv[3] if value is None or value is False else value)
' "$settings" "$1" "$2"
  }
  # serve_mapped AUTHORITY NEEDLE PUBLIC_PORT < serve-status-json — exit 0
  # when the verified private root maps onto the loopback port, no Funnel.
  serve_mapped() {
    python3 -I -c '
import json, sys
serve = json.load(sys.stdin)
authority, needle, public_port = sys.argv[1:4]
tcp = (serve.get("TCP") or {}).get(public_port) or {}
web = (serve.get("Web") or {}).get(authority) or {}
proxy = ((web.get("Handlers") or {}).get("/") or {}).get("Proxy")
funnel = (serve.get("AllowFunnel") or {}).get(authority) or False
sys.exit(0 if tcp.get("HTTPS") is True and proxy == needle and not funnel else 1)
' "$1" "$2" "$3"
  }
elif command -v jq >/dev/null; then
  mobile_setting() { jq -r --arg key "$1" --arg default "$2" '.tabtivity_mobile_host[$key] // $default' "$settings"; }
  serve_mapped() {
    jq -e --arg authority "$1" --arg needle "$2" --arg public_port "$3" '
      .TCP[$public_port].HTTPS == true
      and .Web[$authority].Handlers["/"].Proxy == $needle
      and ((.AllowFunnel[$authority] // false) | not)
    ' >/dev/null
  }
else
  echo "python3 or jq is required to read JSON (brew install jq)" >&2
  exit 1
fi
command -v tailscale >/dev/null || { echo "Tailscale is not installed" >&2; exit 1; }
[[ -r "$settings" ]] || { echo "Tabtivity settings are unavailable" >&2; exit 1; }

port="$(mobile_setting port 8742)"
origin="$(mobile_setting serve_origin "")"
[[ "$origin" =~ ^https://([^/:]+)(:([0-9]+))?$ ]] || {
  echo "No verified exact HTTPS Serve origin is configured" >&2
  exit 1
}
serve_host="${BASH_REMATCH[1]}"
public_port="${BASH_REMATCH[3]:-443}"
authority="$serve_host:$public_port"

serve_json="$(tailscale serve status --json)"
needle="http://127.0.0.1:$port"
serve_mapped "$authority" "$needle" "$public_port" <<<"$serve_json" || {
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
