#!/usr/bin/env bash
# Two-user isolation test for the hosted server (docs/tabtivity_hosted_plan.md
# §10 P3 exit, §11 "Isolation tests"). Run it ON THE SERVER, as root, from a
# checkout of the release the server runs, once two server users exist:
#
#   sudo scripts/server-isolation-test.sh ALICE BOB
#
# For each direction (ALICE against BOB, then BOB against ALICE) it attempts,
# as the first user, to read, list, connect to or signal the second user's
# files, daemon socket, tmux server, processes, private /tmp, calendar, mail
# and state — and asserts on the ERROR, never on the absence of output (a
# no-op that reports success is the failure this guards against). It also
# checks that root (not the gateway's account) is refused by a daemon socket,
# lists every loopback listener each user owns (each must need a token or be
# a CLI's own sign-in listener: see docs/context/server_gateway.md), and runs
# the admin helper's prerequisite check.
#
# It changes nothing: no account, file, unit or process is created, modified
# or stopped. Exit status: 0 when every assertion held, 1 otherwise.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The app's names (scripts/lib/brand.sh): $APP_SLUG, $APP_DISPLAY, …
. "$ROOT/scripts/lib/brand.sh"

if [ "$(id -u)" != 0 ]; then
  echo "run as root: sudo $0 ALICE BOB" >&2
  exit 2
fi
if [ $# -ne 2 ]; then
  echo "usage: sudo $0 ALICE BOB  (two accounts added with ${APP_SLUG}-admin-helper user-add)" >&2
  exit 2
fi

SOCKETS="/run/$APP_SLUG/users"
TMUXROOT="/run/$APP_SLUG/tmux"
failures=0
passes=0

pass() { passes=$((passes + 1)); printf 'ok    %s\n' "$1"; }
fail() { failures=$((failures + 1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

# expect_denied LABEL USER CMD… — CMD run as USER must fail AND say why
# (permission denied, no such file, connection refused/reset, operation not
# permitted). Success, or a failure without one of those reasons, is a FAIL.
expect_denied() {
  local label="$1" user="$2"
  shift 2
  local out rc
  out="$(runuser -u "$user" -- "$@" 2>&1)"
  rc=$?
  if [ $rc -eq 0 ]; then
    fail "$label" "succeeded as $user: $(printf '%s' "$out" | head -c 200)"
  elif printf '%s' "$out" | grep -qiE "permission denied|no such file|no such process|not permitted|connection refused|connection reset|couldn't connect|cannot access|cannot open|empty reply|no server running|error connecting"; then
    pass "$label"
  else
    fail "$label" "failed as $user but without a denial (rc $rc): $(printf '%s' "$out" | head -c 200)"
  fi
}

home_of() { getent passwd "$1" | cut -d: -f6; }
uid_of() { id -u "$1"; }

state_of() {
  # The daemon's state dir: XDG_DATA_HOME is not set by the unit.
  printf '%s/.local/share/%s' "$(home_of "$1")" "$APP_SLUG"
}

against() {
  local a="$1" b="$2"
  local bhome bstate buid
  bhome="$(home_of "$b")"
  bstate="$(state_of "$b")"
  buid="$(uid_of "$b")"
  echo "── $a against $b ──"
  expect_denied "$a cannot list $b's home"                     "$a" ls "$bhome"
  expect_denied "$a cannot read $b's settings"                 "$a" cat "$bstate/settings.json"
  expect_denied "$a cannot read $b's calendar and tasks"       "$a" cat "$bstate/calendar.json"
  expect_denied "$a cannot list $b's mail store"               "$a" ls "$bstate/mail"
  expect_denied "$a cannot read $b's agent logins"             "$a" ls "$bstate/agent-auth"
  expect_denied "$a cannot read $b's secrets wraps"            "$a" cat "$bstate/secrets/wraps.json"
  expect_denied "$a cannot reach $b's daemon socket"           "$a" curl -sS --max-time 5 --unix-socket "$SOCKETS/$b.sock" http://x/healthz
  expect_denied "$a cannot attach to $b's tmux server"         "$a" env TMUX_TMPDIR="$TMUXROOT/$b" tmux -L "$APP_SLUG" ls
  expect_denied "$a cannot list $b's tmux runtime dir"         "$a" ls "$TMUXROOT/$b"
  local pid
  pid="$(systemctl show -p MainPID --value "${APP_SLUG}-serverd@$b.service" 2>/dev/null)"
  if [ -n "$pid" ] && [ "$pid" != 0 ]; then
    expect_denied "$a cannot see $b's daemon in /proc"         "$a" cat "/proc/$pid/cmdline"
    expect_denied "$a cannot signal $b's daemon"               "$a" kill -0 "$pid"
  else
    fail "$b's daemon is running (needed for the /proc checks)" "start it: open the app as $b once, or: systemctl start ${APP_SLUG}-serverd@$b.socket and connect"
  fi
  local tpid
  tpid="$(systemctl show -p MainPID --value "${APP_SLUG}-tmux@$b.service" 2>/dev/null)"
  if [ -n "$tpid" ] && [ "$tpid" != 0 ]; then
    expect_denied "$a cannot see $b's tmux server in /proc"    "$a" cat "/proc/$tpid/environ"
  fi
  local d
  for d in /tmp/systemd-private-*"${APP_SLUG}-serverd@$b.service"*; do
    [ -e "$d" ] || continue
    expect_denied "$a cannot enter $b's private /tmp"          "$a" ls "$d/tmp"
  done
  if runuser -u "$a" -- ps -u "$buid" -o pid= 2>/dev/null | grep -q .; then
    fail "$a sees none of $b's processes" "ps lists processes of $b: /proc is not hidepid=invisible"
  else
    pass "$a sees none of $b's processes"
  fi
  # Loopback listeners $b owns: listed for review (§4.4: each needs a token).
  local listeners
  listeners="$(
    { tail -n +2 /proc/net/tcp; tail -n +2 /proc/net/tcp6; } 2>/dev/null |
      while read -r _ local _ st _ _ _ uid _; do
        [ "$st" = 0A ] && [ "$uid" = "$buid" ] && printf '%d ' "0x${local##*:}"
      done
  )"
  if [ -n "$listeners" ]; then
    echo "note  $b owns loopback listeners on ports: $listeners— check each against the inventory"
  fi
}

echo "── prerequisites ──"
if command -v "/usr/lib/$APP_SLUG/${APP_SLUG}-admin-helper" >/dev/null; then
  if "/usr/lib/$APP_SLUG/${APP_SLUG}-admin-helper" check; then pass "deployment prerequisites"; else fail "deployment prerequisites" "see the FAIL lines above"; fi
else
  fail "the admin helper is installed" "/usr/lib/$APP_SLUG/${APP_SLUG}-admin-helper is missing"
fi

against "$1" "$2"
against "$2" "$1"

echo "── the daemon socket answers the gateway only ──"
out="$(curl -sS --max-time 5 --unix-socket "$SOCKETS/$1.sock" http://x/healthz 2>&1)"
if printf '%s' "$out" | grep -q '"ok"'; then
  fail "root is refused by $1's daemon (peer check)" "root got an answer: $out"
else
  pass "root is refused by $1's daemon (peer check)"
fi

echo
echo "$passes passed, $failures failed"
[ "$failures" -eq 0 ]
