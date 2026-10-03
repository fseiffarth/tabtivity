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
# a CLI's own sign-in listener: see docs/context/server_gateway.md), checks
# that the key keeper answers by uid (P3b), and runs the admin helper's
# prerequisite check.
#
# It changes nothing: no account, file or unit is created, modified or
# stopped (root's connect to the first user's socket starts that user's
# daemon by socket activation, as any gateway request would). Exit status:
# 0 when every assertion held, 1 otherwise.
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
# Account names as the server accepts them (wire::valid_account_name): no
# option-looking or path-looking argument ever reaches runuser or a path.
for name in "$1" "$2"; do
  if ! [[ "$name" =~ ^[a-z][a-z0-9_]{0,31}$ ]] || ! id -u "$name" >/dev/null 2>&1; then
    echo "not a server account name: $name" >&2
    exit 2
  fi
done
if [ "$1" = "$2" ]; then
  echo "two different accounts, please" >&2
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
# For a path that may simply not exist use expect_eacces: "no such file" is
# silence, not a denial.
DENIALS="permission denied|no such file|no such process|not permitted|connection refused|connection reset|couldn't connect|cannot access|cannot open|empty reply|no server running|error connecting"
expect_denied() {
  local label="$1" user="$2"
  shift 2
  expect_reason "$label" "$user" "$DENIALS" "$@"
}

# expect_eacces LABEL USER CMD… — as expect_denied, but only "permission
# denied" counts: B's home is 0700, so every path under it must be refused at
# the directory whether or not the file exists.
expect_eacces() {
  local label="$1" user="$2"
  shift 2
  expect_reason "$label" "$user" "permission denied" "$@"
}

expect_reason() {
  local label="$1" user="$2" reasons="$3"
  shift 3
  local out rc
  out="$(runuser -u "$user" -- "$@" 2>&1)"
  rc=$?
  if [ $rc -eq 0 ]; then
    fail "$label" "succeeded as $user: $(printf '%s' "$out" | head -c 200)"
  elif printf '%s' "$out" | grep -qiE "$reasons"; then
    pass "$label"
  else
    fail "$label" "failed as $user but without a denial (rc $rc): $(printf '%s' "$out" | head -c 200)"
  fi
}

home_of() { getent passwd "$1" | cut -d: -f6; }
uid_of() { id -u "$1"; }

state_of() {
  # The daemon's state dir (serverd keeps it apart from the desktop app's,
  # `daemon::server_dirs`): XDG_DATA_HOME is not set by the unit.
  printf '%s/.local/share/%s-server' "$(home_of "$1")" "$APP_SLUG"
}

against() {
  local a="$1" b="$2"
  local bhome bstate buid
  bhome="$(home_of "$b")"
  bstate="$(state_of "$b")"
  buid="$(uid_of "$b")"
  echo "── $a against $b ──"
  expect_eacces "$a cannot list $b's home"                     "$a" ls "$bhome"
  expect_eacces "$a cannot read $b's settings"                 "$a" cat "$bstate/settings.json"
  expect_eacces "$a cannot read $b's calendar and tasks"       "$a" cat "$bstate/calendar.json"
  expect_eacces "$a cannot list $b's mail store"               "$a" ls "$bstate/mail"
  expect_eacces "$a cannot read $b's agent logins"             "$a" ls "$bstate/agent-auth"
  expect_eacces "$a cannot read $b's secrets wraps"            "$a" cat "$bstate/secrets/wraps.json"
  # A missing socket would make the next check pass for the wrong reason.
  if [ -S "$SOCKETS/$b.sock" ]; then
    expect_denied "$a cannot reach $b's daemon socket"         "$a" curl -sS --max-time 5 --unix-socket "$SOCKETS/$b.sock" http://x/healthz
  else
    fail "$b's daemon socket exists" "$SOCKETS/$b.sock is missing: systemctl enable --now ${APP_SLUG}-serverd@$b.socket"
  fi
  # tmux names its socket after the CLIENT's uid; aim at $b's own one.
  expect_eacces "$a cannot attach to $b's tmux server"         "$a" tmux -S "$TMUXROOT/$b/tmux-$buid/$APP_SLUG" ls
  expect_eacces "$a cannot list $b's tmux runtime dir"         "$a" ls "$TMUXROOT/$b"
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
  # The two units share one private /tmp, named after whichever started first.
  for d in /tmp/systemd-private-*"${APP_SLUG}-serverd@$b.service"* /tmp/systemd-private-*"${APP_SLUG}-tmux@$b.service"*; do
    [ -e "$d" ] || continue
    expect_eacces "$a cannot enter $b's private /tmp"          "$a" ls "$d/tmp"
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
# The daemon drops a connection from any uid but the gateway's unanswered:
# curl must see the connection made and then closed — not refused (nothing
# listening) and not any HTTP answer at all.
if [ -S "$SOCKETS/$1.sock" ]; then
  out="$(curl -sS --max-time 10 --unix-socket "$SOCKETS/$1.sock" http://x/healthz 2>&1)"
  if printf '%s' "$out" | grep -qiE "empty reply|connection reset|recv failure"; then
    pass "root is refused by $1's daemon (peer check)"
  else
    fail "root is refused by $1's daemon (peer check)" "expected the connection dropped unanswered, got: $(printf '%s' "$out" | head -c 200)"
  fi
else
  fail "$1's daemon socket exists" "$SOCKETS/$1.sock is missing"
fi

echo "── the key keeper answers by uid ──"
# Hosted plan §5.4 (P3b): the administrator's agent API keys sit in a 0700
# directory of <slug>-auth; its socket offers and lists keys only to the
# gateway's account, hands a key only to a server user, refuses everyone
# else. Probed with requests that change nothing (a refused set writes
# nothing; the fake key never reaches a file).
KEEPER="/run/$APP_SLUG/auth.sock"
keeper_says() { printf '%s\n' "$2" | runuser -u "$1" -- nc -U -N "$KEEPER" 2>&1; }
if [ ! -S "$KEEPER" ]; then
  fail "the key keeper's socket exists" "$KEEPER is missing: systemctl enable --now ${APP_SLUG}-auth-keeper.socket"
elif ! command -v nc >/dev/null; then
  fail "nc is installed (for the keeper checks)" "apt install netcat-openbsd"
else
  for u in "$1" "$2"; do
    expect_eacces "$u cannot list the keeper's key directory"  "$u" ls "/var/lib/${APP_SLUG}-auth"
    for request in '{"op":"status"}' "{\"op\":\"remove\",\"cli\":\"claude\",\"by\":\"$u\"}"; do
      out="$(keeper_says "$u" "$request")"
      if printf '%s' "$out" | grep -q '"error":"refused"'; then
        pass "the keeper refuses $u an administrator's request (${request%%,*})"
      else
        fail "the keeper refuses $u an administrator's request (${request%%,*})" "got: $(printf '%s' "$out" | head -c 200)"
      fi
    done
    out="$(keeper_says "$u" '{"op":"offered"}')"
    if printf '%s' "$out" | grep -q '"ok":true'; then pass "the keeper lists the offer to $u"; else fail "the keeper lists the offer to $u" "got: $(printf '%s' "$out" | head -c 200)"; fi
  done
  out="$(keeper_says nobody '{"op":"offered"}')"
  if printf '%s' "$out" | grep -q '"error":"refused"'; then pass "the keeper refuses a non-server account"; else fail "the keeper refuses a non-server account" "got: $(printf '%s' "$out" | head -c 200)"; fi
fi

echo
echo "$passes passed, $failures failed"
[ "$failures" -eq 0 ]
