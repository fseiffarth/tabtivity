#!/usr/bin/env bash
# AGENTS.md's gates, only the ones a change touches; fail-fast, one summary
# line per gate.
#
#   scripts/gates.sh               the change: the diff against HEAD plus
#                                  untracked files
#   scripts/gates.sh --base <rev>  the diff against <rev> instead (e.g.
#                                  origin/develop: the whole branch)
#   scripts/gates.sh --all         every gate, exactly as AGENTS.md lists them
#   scripts/gates.sh --list        the gates and what selects each
#   scripts/gates.sh -n            print the selection, run nothing
#
# Selection (scripts/lib/changed.sh, shared with ci-local.sh --fast):
#   always     brand-check, `git diff --check`
#   frontend   npm run lint, npm run build, vitest on the tests related to the
#              changed files (`vitest run --changed`)
#   Rust       cargo clippy/test for the crates the change reaches: src-core
#              reaches every crate, src-gateway itself and src-tauri, src-tauri
#              itself, the daemon's build of it (--no-default-features) and
#              src-serverd; Cargo.toml/Cargo.lock/rust-toolchain.toml all
# Docs, todo/ and scripts/ alone select only the always-run checks.
#
# Before a push: --all, then scripts/ci-local.sh (CI's own steps and the
# Windows/macOS cross-checks, which this does not run).
#
# Each gate's output goes to a log, printed (its tail) only when it fails.
# A cargo gate that waited for another build's lock says how long, apart
# from its own time.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
. "$repo/scripts/lib/changed.sh"
# SCHED_IDLE + nice 19, so a gate run never makes the window lag (the file says why).
. "$repo/scripts/lib/low_priority.sh"
low_priority_reexec "$repo/scripts/gates.sh" "$@"
command -v cargo >/dev/null 2>&1 || PATH="$HOME/.cargo/bin:$PATH"
export LC_NUMERIC=C  # $EPOCHREALTIME with a "." for the timings

die() { echo "gates: $*" >&2; exit 2; }

# The `[package] name` of a crate directory (no crate name is spelled here).
pkg() {
  awk '/^\[package\]/ { p = 1; next } /^\[/ { p = 0 }
       p && /^name[[:space:]]*=/ { sub(/^[^"]*"/, ""); sub(/".*$/, ""); print; exit }' "$1/Cargo.toml"
}

mode=changed base=HEAD dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --all) mode=all ;;
    --base) [ $# -ge 2 ] || die "--base needs a revision"; base="$2"; shift ;;
    --base=*) base="${1#--base=}" ;;
    --list) mode=list ;;
    -n|--dry-run) dry=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option '$1' (see --help)" ;;
  esac
  shift
done

P_CORE="$(pkg src-core)" P_GATEWAY="$(pkg src-gateway)" P_TAURI="$(pkg src-tauri)" P_SERVERD="$(pkg src-serverd)"
[ -n "$P_CORE" ] && [ -n "$P_GATEWAY" ] && [ -n "$P_TAURI" ] && [ -n "$P_SERVERD" ] \
  || die "could not read a crate's [package] name"

if [ "$mode" = list ]; then
  cat <<EOF
brand       always       scripts/brand-check.sh
whitespace  always       git diff --check <base>
lint-fe     frontend     npm run lint
clippy      Rust         cargo clippy -p <reached crates> --all-targets -- -D warnings   (--all: --workspace)
clippy-dlib src-tauri+   cargo clippy -p $P_TAURI --no-default-features --lib -- -D warnings
clippy-dmn  src-serverd+ cargo clippy -p $P_SERVERD --all-targets -- -D warnings
build       frontend     npm run build
vitest      frontend     npx vitest run --changed [<base>]   (--all: npm test)
test        Rust         cargo test -p <reached crates>   (--all: --workspace)
test-dlib   src-tauri+   cargo test -p $P_TAURI --no-default-features --lib --test server_secrets
("+": or a crate it links: src-core/src-gateway reach src-tauri, which reaches src-serverd)
EOF
  exit 0
fi

git rev-parse -q --verify "$base^{commit}" >/dev/null || die "no such revision: $base"
if [ "$mode" = all ]; then
  A_FE=1 A_CORE=1 A_GATEWAY=1 A_TAURI=1 A_SERVERD=1 A_ALL=1 CHANGED=""
  echo "gates --all: every AGENTS.md gate"
else
  changed_areas "$base"
  areas="$(changed_area_names)"
  echo "gates: $(grep -c . <<<"$CHANGED" || true) files changed against $(git rev-parse --short "$base"):${areas:- nothing that builds or tests (docs/scripts only): cheap checks only}"
fi
changed_reach

crates=()
[ "$R_CORE" = 1 ] && crates+=(-p "$P_CORE")
[ "$R_GATEWAY" = 1 ] && crates+=(-p "$P_GATEWAY")
[ "$R_TAURI" = 1 ] && crates+=(-p "$P_TAURI")
[ "$R_SERVERD" = 1 ] && crates+=(-p "$P_SERVERD")
if [ "$mode" = all ]; then
  crates=(--workspace)
  vitest=(npm test)
else
  vitest=(npx vitest run --passWithNoTests --changed)
  [ "$base" = HEAD ] || vitest+=("$base")
fi
diffcheck=(git diff --check)
[ "$base" = HEAD ] || diffcheck+=("$base")

# id | 1 to run, else the reason it is skipped | command
G_ID=() G_WHY=() G_CMD=()
gate() {
  local c
  G_ID+=("$1"); G_WHY+=("$2"); shift 2
  c="$(printf '%q ' "$@")"; G_CMD+=("${c% }")
}
why() { if [ "$1" = 1 ]; then echo 1; else echo "$2"; fi; }
nors="no Rust change"
gate brand 1 scripts/brand-check.sh
gate whitespace 1 "${diffcheck[@]}"
gate lint-fe "$(why "$A_FE" "no frontend change")" npm run lint
gate clippy "$(why $((${#crates[@]} > 0)) "$nors")" cargo clippy "${crates[@]}" --all-targets -- -D warnings
gate clippy-dlib "$(why "$R_TAURI" "src-tauri not reached")" cargo clippy -p "$P_TAURI" --no-default-features --lib -- -D warnings
gate clippy-dmn "$(why "$R_SERVERD" "src-serverd not reached")" cargo clippy -p "$P_SERVERD" --all-targets -- -D warnings
gate build "$(why "$A_FE" "no frontend change")" npm run build
gate vitest "$(why "$A_FE" "no frontend change")" "${vitest[@]}"
gate test "$(why $((${#crates[@]} > 0)) "$nors")" cargo test "${crates[@]}"
gate test-dlib "$(why "$R_TAURI" "src-tauri not reached")" cargo test -p "$P_TAURI" --no-default-features --lib --test server_secrets

if [ "$dry" = 1 ]; then
  for i in "${!G_ID[@]}"; do
    if [ "${G_WHY[$i]}" = 1 ]; then printf '  run   %-11s %s\n' "${G_ID[$i]}" "${G_CMD[$i]}"
    else printf '  skip  %-11s %s\n' "${G_ID[$i]}" "${G_WHY[$i]}"; fi
  done
  exit 0
fi

logs="$(mktemp -d "${TMPDIR:-/tmp}/gates.XXXXXX")"
# Copies the command's output into the log; for cargo, notes how long it sat
# on "Blocking waiting for file lock" (until its next line) in $logs/<id>.lock.
run_logged() {
  local id="$1" log="$logs/$1.log" t_block="" line
  shift
  {
    "$@" 2>&1 || echo "__gates_rc=$?"
  } | while IFS= read -r line; do
    if [ -n "$t_block" ]; then
      echo "${t_block} ${EPOCHREALTIME}" >>"$logs/$id.lock"; t_block=""
    fi
    case "$line" in *"Blocking waiting for file lock"*) t_block="$EPOCHREALTIME" ;; esac
    printf '%s\n' "$line"
  done >"$log"
  ! grep -q '^__gates_rc=' "$log"
}

lock_secs() {
  [ -f "$logs/$1.lock" ] || { echo 0; return; }
  awk '{ s += $2 - $1 } END { printf "%d", s }' "$logs/$1.lock"
}

failed="" rc=0 summary=()
for i in "${!G_ID[@]}"; do
  id="${G_ID[$i]}" cmd="${G_CMD[$i]}"
  if [ "${G_WHY[$i]}" != 1 ]; then
    summary+=("$(printf '  skip  %-11s %6s  %s' "$id" "" "${G_WHY[$i]}")"); continue
  fi
  if [ -n "$failed" ]; then
    summary+=("$(printf '  -     %-11s %6s  not run: %s failed' "$id" "" "$failed")"); continue
  fi
  read -r tool _ <<<"$cmd"
  if ! command -v "$tool" >/dev/null 2>&1 && [ ! -x "$tool" ]; then
    summary+=("$(printf '  MISS  %-11s %6s  %s not found: NOT verified' "$id" "" "$tool")")
    rc=1; continue
  fi
  printf '%s %s\n' "-> $id:" "$cmd"
  t0=$EPOCHREALTIME
  status=PASS
  eval "run_logged $id $cmd" || status=FAIL
  secs=$(awk -v a="$t0" -v b="$EPOCHREALTIME" 'BEGIN { printf "%d", b - a }')
  wait_s=$(lock_secs "$id")
  note="$cmd"
  [ "$wait_s" -gt 0 ] && note="(lock wait ${wait_s}s, own $((secs - wait_s))s) $cmd"
  summary+=("$(printf '  %-4s  %-11s %5ss  %s' "$status" "$id" "$secs" "$note")")
  if [ "$status" = FAIL ]; then
    failed="$id" rc=1
    echo "--- $id failed; last lines of $logs/$id.log:"
    grep -v '^__gates_rc=' "$logs/$id.log" | tail -40
  fi
done

echo "== gates =="
printf '%s\n' "${summary[@]}"
if [ -n "$failed" ]; then
  echo "FAILED: $failed (full log: $logs/$failed.log)"
else
  rm -rf "$logs"
  [ "$rc" = 0 ] && echo "All selected gates passed." || echo "A gate's tool is missing (MISS above): not verified."
fi
exit "$rc"
