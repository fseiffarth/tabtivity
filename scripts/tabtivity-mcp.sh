#!/bin/sh
# Tabtivity-owned MCP client for the agent CLIs that cannot be told about
# Tabtivity's MCP servers at launch (`root_mcp::wire_named_cli`): it lists the
# servers this tab was handed and calls their tools over the loopback HTTP
# endpoint each one's env pair names (`TABTIVITY_<LANE>_MCP_URL` / `_TOKEN`).
# Needs curl. The token goes to curl on a file descriptor, never in argv, and
# only to a loopback URL.
set -eu
export LC_ALL=C
me=tabtivity-mcp
fail() { printf '%s: %s\n' "$me" "$2" >&2; exit "$1"; }
usage() {
    printf '%s\n' \
        "$me                          list the servers this tab can use" \
        "$me tools SERVER             list a server's tools and their arguments (JSON)" \
        "$me call SERVER TOOL [JSON]  call a tool; JSON is its arguments object (default {}, - reads stdin)" \
        "$me --help" \
        '' \
        "SERVER is a name from the list (print, git, markup, help, cockpit, tabs, schedule, root)."
}
LANES='print git markup help cockpit tabs schedule root'

# The env pair of a lane: its URL and token, or empty when this tab has none.
lane_env() {
    upper=$(printf '%s' "$1" | tr 'a-z' 'A-Z')
    eval "url=\${TABTIVITY_${upper}_MCP_URL:-}"
    eval "token=\${TABTIVITY_${upper}_MCP_TOKEN:-}"
}

# One JSON-RPC request (stdin) to a lane; prints the response body.
post() {
    case "$url" in
        http://127.0.0.1:[0-9]*/mcp*) ;;
        *) fail 3 "The $1 server's address is not a local one; refusing to send its token." ;;
    esac
    command -v curl >/dev/null 2>&1 || fail 3 'curl is not installed in this tab.'
    curl -sS -m 120 -X POST "$url" \
        -H 'Content-Type: application/json' -H 'Accept: application/json' \
        -H @/dev/fd/3 --data-binary @- 3<<EOF
Authorization: Bearer $token
EOF
}

[ "$#" -gt 0 ] || set -- list
case "$1" in
    --help|-h|help) usage; exit 0 ;;
    list)
        [ "$#" -eq 1 ] || fail 2 'Use list alone.'
        found=
        for lane in $LANES; do
            lane_env "$lane"
            if [ -n "$url" ] && [ -n "$token" ]; then
                [ -n "$found" ] || printf '%s\n' 'Servers this tab can use (tabtivity-mcp tools SERVER for their tools):'
                found=1
                printf '  %s\n' "$lane"
            fi
        done
        [ -n "$found" ] || fail 3 'This tab holds no Tabtivity MCP server (only local project agent tabs do).'
        exit 0 ;;
    tools|call) ;;
    *) fail 2 "Unknown command $1; use --help." ;;
esac

cmd=$1; shift
[ "$#" -ge 1 ] || fail 2 'Name a server; run tabtivity-mcp to list them.'
lane=${1#tabtivity-}; shift
[ "$lane" = tabtivity ] && lane=root
case " $LANES " in *" $lane "*) ;; *) fail 2 "Unknown server $lane; run tabtivity-mcp to list them." ;; esac
lane_env "$lane"
[ -n "$url" ] && [ -n "$token" ] || fail 3 "This tab has no $lane server; run tabtivity-mcp to list them."

if [ "$cmd" = tools ]; then
    [ "$#" -eq 0 ] || fail 2 'Use tools SERVER alone.'
    printf '%s' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | post "$lane"
    printf '\n'
    exit 0
fi

[ "$#" -ge 1 ] || fail 2 'Name a tool; run tabtivity-mcp tools SERVER for the list.'
tool=$1; shift
case "$tool" in ''|*[!A-Za-z0-9_-]*) fail 2 "Not a tool name: $tool" ;; esac
[ "$#" -le 1 ] || fail 2 "Pass the arguments as one JSON object, quoted: '{\"key\": \"value\"}'."
args=${1:-'{}'}
[ "$args" != - ] || args=$(cat)
case "$args" in *'{'*) ;; *) fail 2 'The arguments must be a JSON object, like {"path": "out.pdf"}.' ;; esac
out=$(printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"%s","arguments":%s}}' "$tool" "$args" | post "$lane")
printf '%s\n' "$out"
# A refused or failed call exits 1, so a script can tell.
case "$out" in
    *'"isError":true'*|*'"error":{'*|*'"status":"refused"'*) exit 1 ;;
esac
