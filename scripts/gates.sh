#!/usr/bin/env bash
# AGENTS.md's gates, only the ones a change touches; one summary line per
# gate.
#
#   scripts/gates.sh               the change: the diff against HEAD plus
#                                  untracked files
#   scripts/gates.sh --base <rev>  the diff against <rev> instead (e.g.
#                                  origin/develop: the whole branch)
#   scripts/gates.sh --all         every gate, exactly as AGENTS.md lists them
#   scripts/gates.sh --list        the gates and what selects each
#   scripts/gates.sh -n            print the selection, run nothing
#   scripts/gates.sh --fresh       run even if a recorded run covers this one
#                                  (GATES_FRESH=1 too)
#
# Runs are one at a time per checkout (scripts/lib/gate_lock.sh). A run that
# had to wait does not run again when the recorded run covers it:
#   - the tree is unchanged since that run (same mode and base, or a passing
#     --all), or
#   - that run STARTED AFTER this one was asked for and ran every gate this
#     one selects. Every session's edits live in the one shared tree, so that
#     run already checked this session's edits. Five sessions queued behind
#     one run cost one more run, not five.
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
# Lanes: brand + whitespace first; then the frontend lane (lint, build,
# vitest) and the Rust lane (clippy…, test…) run side by side, each stopping
# at its own first failure (GATES_SERIAL=1 runs them one after the other).
# Both are on SCHED_IDLE, so they take idle cores only.
#
# Before a push: --all, then scripts/ci-local.sh (CI's own steps and the
# Windows/macOS cross-checks, which this does not run).
#
# Progress: each gate's start and end line carry `[k/n lane]`, its result and
# the run's time so far; <git dir>/gates.progress holds the gates running now.
#
# Each gate's output goes to a log, printed (its tail) only when it fails,
# with the changed files the failure names: the tree holds every session's
# uncommitted edits, so a failure in a file you did not touch is another
# session's work in progress. A cargo gate that waited for another build's
# lock says how long, apart from its own time.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
. "$repo/scripts/lib/changed.sh"
# SCHED_IDLE + nice 19, so a gate run never makes the window lag (the file says why).
. "$repo/scripts/lib/low_priority.sh"
low_priority_reexec "$repo/scripts/gates.sh" "$@"
# One run at a time per checkout, and reuse of a covering run's result.
. "$repo/scripts/lib/gate_lock.sh"
command -v cargo >/dev/null 2>&1 || PATH="$HOME/.cargo/bin:$PATH"
export LC_NUMERIC=C  # $EPOCHREALTIME with a "." for the timings
# When this run was asked for: a recorded run that started later covers it.
t_req=$EPOCHREALTIME

die() { echo "gates: $*" >&2; exit 2; }

# The `[package] name` of a crate directory (no crate name is spelled here).
pkg() {
  awk '/^\[package\]/ { p = 1; next } /^\[/ { p = 0 }
       p && /^name[[:space:]]*=/ { sub(/^[^"]*"/, ""); sub(/".*$/, ""); print; exit }' "$1/Cargo.toml"
}

argv="$*" mode=changed base=HEAD dry=0 fresh="${GATES_FRESH:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --all) mode=all ;;
    --fresh) fresh=1 ;;
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
base_sha="$(git rev-parse "$base")"
# Coverage tokens name what a gate checked, so a recorded run can be matched
# against this one's selection; a base other than HEAD is part of the token.
btok=""
[ "$base" = HEAD ] || btok=":$base_sha"

# id | lane | coverage tokens | 1 to run, else the reason it is skipped | command
G_ID=() G_LANE=() G_TOK=() G_WHY=() G_CMD=()
gate() {
  local c
  G_ID+=("$1"); G_LANE+=("$2"); G_TOK+=("$3"); G_WHY+=("$4"); shift 4
  c="$(printf '%q ' "$@")"; G_CMD+=("${c% }")
}
why() { if [ "$1" = 1 ]; then echo 1; else echo "$2"; fi; }

# The gate table for the tree as it is now; SEL_LINE says what was found and
# TOKENS lists the selected gates' coverage tokens.
select_gates() {
  local nors="no Rust change" areas c
  local -a crates=() ctok=() vitest diffcheck
  if [ "$mode" = all ]; then
    A_FE=1 A_CORE=1 A_GATEWAY=1 A_TAURI=1 A_SERVERD=1 A_ALL=1 CHANGED=""
    SEL_LINE="gates --all: every AGENTS.md gate"
  else
    changed_areas "$base"
    areas="$(changed_area_names)"
    SEL_LINE="gates: $(grep -c . <<<"$CHANGED" || true) files changed against $(git rev-parse --short "$base"):${areas:- nothing that builds or tests (docs/scripts only): cheap checks only}"
  fi
  changed_reach
  [ "$R_CORE" = 1 ] && crates+=(-p "$P_CORE") && ctok+=("$P_CORE")
  [ "$R_GATEWAY" = 1 ] && crates+=(-p "$P_GATEWAY") && ctok+=("$P_GATEWAY")
  [ "$R_TAURI" = 1 ] && crates+=(-p "$P_TAURI") && ctok+=("$P_TAURI")
  [ "$R_SERVERD" = 1 ] && crates+=(-p "$P_SERVERD") && ctok+=("$P_SERVERD")
  local vtok
  if [ "$mode" = all ]; then
    crates=(--workspace)
    vitest=(npm test) vtok=vitest:all
  else
    vitest=(npx vitest run --passWithNoTests --changed) vtok="vitest:changed$btok"
    [ "$base" = HEAD ] || vitest+=("$base")
  fi
  diffcheck=(git diff --check)
  [ "$base" = HEAD ] || diffcheck+=("$base")
  local rust=$((${#ctok[@]} > 0))
  G_ID=() G_LANE=() G_TOK=() G_WHY=() G_CMD=()
  gate brand pre brand 1 scripts/brand-check.sh
  gate whitespace pre "whitespace$btok" 1 "${diffcheck[@]}"
  gate lint-fe fe lint-fe "$(why "$A_FE" "no frontend change")" npm run lint
  gate clippy rust "${ctok[*]/#/clippy:}" "$(why "$rust" "$nors")" cargo clippy "${crates[@]}" --all-targets -- -D warnings
  gate clippy-dlib rust clippy-dlib "$(why "$R_TAURI" "src-tauri not reached")" cargo clippy -p "$P_TAURI" --no-default-features --lib -- -D warnings
  gate clippy-dmn rust clippy-dmn "$(why "$R_SERVERD" "src-serverd not reached")" cargo clippy -p "$P_SERVERD" --all-targets -- -D warnings
  gate build fe build "$(why "$A_FE" "no frontend change")" npm run build
  gate vitest fe "$vtok" "$(why "$A_FE" "no frontend change")" "${vitest[@]}"
  gate test rust "${ctok[*]/#/test:}" "$(why "$rust" "$nors")" cargo test "${crates[@]}"
  gate test-dlib rust test-dlib "$(why "$R_TAURI" "src-tauri not reached")" cargo test -p "$P_TAURI" --no-default-features --lib --test server_secrets
  TOKENS=""
  for c in "${!G_ID[@]}"; do [ "${G_WHY[$c]}" = 1 ] && TOKENS+=" ${G_TOK[$c]}"; done
  TOKENS="${TOKENS# }"
}

# covers "<tokens a run passed>" "<tokens needed>": the run checked every one
# (the full vitest suite covers a --changed one).
covers() {
  local t
  for t in $2; do
    case " $1 " in *" $t "*) continue ;; esac
    case "$t" in vitest:changed*) case " $1 " in *" vitest:all "*) continue ;; esac ;; esac
    return 1
  done
}
# any_of "<tokens>" "<tokens>": they share one.
any_of() {
  local t
  for t in $2; do case " $1 " in *" $t "*) return 0 ;; esac; done
  return 1
}

# The last recorded run (<git dir>/gates.last): fp, key, rc, at first (an older
# gates.sh reads those four by position), then start, pass, fail, `--`, and
# its summary. L_OK=1 once the `--` line is read.
last="$(git rev-parse --absolute-git-dir)/gates.last"
read_last() {
  L_FP="" L_MODE="" L_BASE="" L_RC="" L_AT="" L_START="" L_PASS="" L_FAIL="" L_OK=0
  [ -f "$last" ] || return 0
  local k v
  while IFS= read -r k; do
    [ "$k" = -- ] && { L_OK=1; return 0; }
    v="${k#* }" k="${k%% *}"
    case "$k" in
      fp) L_FP="$v" ;;
      key) L_MODE="${v%% *}" L_BASE="${v#* }" ;;
      rc) L_RC="$v" ;;
      at) L_AT="$v" ;;
      start) L_START="$v" ;;
      pass) L_PASS="$v" ;;
      fail) L_FAIL="$v" ;;
    esac
  done <"$last"
}
last_summary() { sed '1,/^--$/d' "$last"; }
secs_between() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%d", b - a }'; }

select_gates

if [ "$dry" = 1 ]; then
  echo "$SEL_LINE"
  for i in "${!G_ID[@]}"; do
    if [ "${G_WHY[$i]}" = 1 ]; then printf '  run   %-11s %-4s %s\n' "${G_ID[$i]}" "${G_LANE[$i]}" "${G_CMD[$i]}"
    else printf '  skip  %-11s %-4s %s\n' "${G_ID[$i]}" "${G_LANE[$i]}" "${G_WHY[$i]}"; fi
  done
  exit 0
fi

# One run at a time across sessions (scripts/lib/gate_lock.sh says why).
key="$mode $base_sha"
req_tokens="$TOKENS"
gate_lock "gates.sh${argv:+ $argv}"
t_start=$EPOCHREALTIME
fp0="$(gate_tree_fp)"
if [ -z "$fresh" ]; then
  read_last
  if [ "$L_OK" = 1 ]; then
    # Nobody changed the tree since that run.
    if [ "$L_FP" = "$fp0" ] && { [ "$L_MODE $L_BASE" = "$key" ] || { [ "$L_MODE" = all ] && [ "$L_RC" = 0 ]; }; }; then
      echo "gates: the tree is unchanged since a run (${L_MODE}) that finished $(( $(date +%s) - ${L_AT:-0} ))s ago; its result stands (--fresh runs again):"
      last_summary
      exit "$L_RC"
    fi
    # That run started after this one was asked for, so it checked this
    # session's edits (and every other session's).
    if [ -n "$L_START" ] && awk -v a="$t_req" -v b="$L_START" 'BEGIN { exit !(b > a) }'; then
      after="$(secs_between "$t_req" "$L_START")"
      if covers "$L_PASS" "$req_tokens"; then
        echo "gates: a run that started ${after}s after you asked passed every gate your change selects; its result stands (--fresh runs again):"
        last_summary
        [ "$L_RC" = 0 ] || echo "gates: its failure is in a gate your change does not select, so it is not yours."
        exit 0
      fi
      # A failure stands only while nobody has edited since: the session it
      # belongs to may already have fixed it.
      if [ "$L_FP" = "$fp0" ] && any_of "$L_FAIL" "$req_tokens"; then
        echo "gates: a run that started ${after}s after you asked failed a gate your change selects, and the tree is unchanged since; its result stands (--fresh runs again):"
        last_summary
        exit 1
      fi
    fi
  fi
fi
# The tree may have changed while this run waited: select for it as it is now.
select_gates
echo "$SEL_LINE"

logs="$(mktemp -d "${TMPDIR:-/tmp}/gates.XXXXXX")"
# Every changed path, to name the ones a failure mentions.
{ git diff --name-only HEAD --; git ls-files -o --exclude-standard; } | grep '[./]' | sort -u >"$logs/changed.txt" || true

# Copies output into the log; for cargo, notes how long it sat on "Blocking
# waiting for file lock" (until its next line) in $logs/<id>.lock.
lock_filter() {
  local id="$1" t_block="" line
  while IFS= read -r line; do
    if [ -n "$t_block" ]; then
      echo "${t_block} ${EPOCHREALTIME}" >>"$logs/$id.lock"; t_block=""
    fi
    case "$line" in *"Blocking waiting for file lock"*) t_block="$EPOCHREALTIME" ;; esac
    printf '%s\n' "$line"
  done
}

# A gate never hangs the run: stdin is /dev/null (a test that reads it would
# wait on the caller's terminal), the command is killed after GATES_TIMEOUT
# seconds (default 1800), and the gate ends when its command does: output
# goes through a process substitution this does not wait on, because a
# process the command leaves behind keeps that pipe open (2 s to drain).
gate_timeout="${GATES_TIMEOUT:-1800}"
run_logged() {
  local id="$1" log="$logs/$1.log" rc=0 filter n
  shift
  local -a guard=()
  command -v timeout >/dev/null 2>&1 && guard=(timeout -k 30 "$gate_timeout")
  # (The filter writes its own pid: `$!` does not name a process substitution here.)
  "${guard[@]}" "$@" </dev/null > >(echo "$BASHPID" >"$logs/$id.filter"; lock_filter "$id" >"$log") 2>&1 || rc=$?
  for ((n = 0; n < 20; n++)); do
    filter="$(cat "$logs/$id.filter" 2>/dev/null || true)"
    [ -n "$filter" ] && ! kill -0 "$filter" 2>/dev/null && break
    sleep 0.1
  done
  [ -n "$filter" ] && kill "$filter" 2>/dev/null || true
  if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
    [ ${#guard[@]} -gt 0 ] && echo "gates: $id timed out after ${gate_timeout}s (GATES_TIMEOUT); killed" >>"$log"
  fi
  [ "$rc" = 0 ] || echo "__gates_rc=$rc" >>"$log"
  return "$rc"
}

lock_secs() {
  [ -f "$logs/$1.lock" ] || { echo 0; return; }
  awk '{ s += $2 - $1 } END { printf "%d", s }' "$logs/$1.lock"
}

# Progress: `[k/n lane]` on each gate's start and end line, the run's elapsed
# time on the end line, and the gates running now in <git dir>/gates.progress
# (one line per lane; gone when the run ends) for a session waiting on the
# lock, or anyone whose copy of this output is buffered: `cat .git/gates.progress`.
progress="$(git rev-parse --absolute-git-dir)/gates.progress"
trap 'rm -f "$progress"' EXIT
elapsed() { awk -v a="$1" -v b="$EPOCHREALTIME" 'BEGIN { s = int(b - a); printf "%dm%02ds", s / 60, s % 60 }'; }
progress_now() {  # lane, line ("" when the lane is done)
  if [ -n "$2" ]; then printf '%s\n' "$2" >"$logs/now.$1"; else rm -f "$logs/now.$1"; fi
  cat "$logs"/now.* >"$progress.$1.tmp" 2>/dev/null || true
  mv -f "$progress.$1.tmp" "$progress"
}

# One lane's selected gates in order, stopping at its first failure. Each
# gate's result goes to $logs/<id>.res: status|seconds|note.
run_lane() {
  local lane="$1" i id cmd tool status t0 secs wait_s note failed="" step=0 total=0
  for i in "${!G_ID[@]}"; do
    [ "${G_LANE[$i]}" = "$lane" ] && [ "${G_WHY[$i]}" = 1 ] && total=$((total + 1))
  done
  for i in "${!G_ID[@]}"; do
    [ "${G_LANE[$i]}" = "$lane" ] && [ "${G_WHY[$i]}" = 1 ] || continue
    id="${G_ID[$i]}" cmd="${G_CMD[$i]}"
    step=$((step + 1))
    if [ -n "$failed" ]; then
      printf 'NOTRUN||%s failed\n' "$failed" >"$logs/$id.res"; continue
    fi
    read -r tool _ <<<"$cmd"
    if ! command -v "$tool" >/dev/null 2>&1 && [ ! -x "$tool" ]; then
      printf 'MISS||%s not found: NOT verified\n' "$tool" >"$logs/$id.res"; continue
    fi
    printf '%s %s\n' "-> [$step/$total $lane] $id:" "$cmd"
    progress_now "$lane" "$(printf '[%s/%s %s] %s since %s (run started %s ago, pid %s)' "$step" "$total" "$lane" "$id" "$(date +%H:%M:%S)" "$(elapsed "$t_start")" "$$")"
    t0=$EPOCHREALTIME
    status=PASS
    eval "run_logged $id $cmd" || status=FAIL
    secs=$(secs_between "$t0" "$EPOCHREALTIME")
    wait_s=$(lock_secs "$id")
    note="$cmd"
    [ "$wait_s" -gt 0 ] && note="(lock wait ${wait_s}s, own $((secs - wait_s))s) $cmd"
    printf '   [%s/%s %s] %s %s in %ss · %s so far\n' "$step" "$total" "$lane" "$id" "$status" "$secs" "$(elapsed "$t_start")"
    printf '%s|%s|%s\n' "$status" "$secs" "$note" >"$logs/$id.res"
    [ "$status" = FAIL ] && failed="$id"
  done
  progress_now "$lane" ""
  return 0
}

run_lane pre
pre_failed=""
for i in "${!G_ID[@]}"; do
  [ "${G_LANE[$i]}" = pre ] && grep -q '^FAIL' "$logs/${G_ID[$i]}.res" 2>/dev/null && pre_failed="${G_ID[$i]}" && break
done
if [ -n "$pre_failed" ]; then
  for i in "${!G_ID[@]}"; do
    [ "${G_LANE[$i]}" = pre ] || [ "${G_WHY[$i]}" != 1 ] || printf 'NOTRUN||%s failed\n' "$pre_failed" >"$logs/${G_ID[$i]}.res"
  done
elif [ -n "${GATES_SERIAL:-}" ]; then
  run_lane fe
  run_lane rust
else
  run_lane fe & fe_pid=$!
  run_lane rust & rust_pid=$!
  wait "$fe_pid" || true
  wait "$rust_pid" || true
fi

# The summary, in the table's order.
failed=() rc=0 summary=() pass_toks="" fail_toks=""
for i in "${!G_ID[@]}"; do
  id="${G_ID[$i]}"
  if [ "${G_WHY[$i]}" != 1 ]; then
    summary+=("$(printf '  skip  %-11s %6s  %s' "$id" "" "${G_WHY[$i]}")"); continue
  fi
  st=NOTRUN secs="" note="its lane stopped without a result"
  [ -f "$logs/$id.res" ] && IFS='|' read -r st secs note <"$logs/$id.res"
  case "$st" in
    PASS) pass_toks+=" ${G_TOK[$i]}"
          summary+=("$(printf '  PASS  %-11s %5ss  %s' "$id" "$secs" "$note")") ;;
    FAIL) fail_toks+=" ${G_TOK[$i]}" rc=1; failed+=("$id")
          summary+=("$(printf '  FAIL  %-11s %5ss  %s' "$id" "$secs" "$note")") ;;
    MISS) rc=1; summary+=("$(printf '  MISS  %-11s %6s  %s' "$id" "" "$note")") ;;
    *)    rc=1; summary+=("$(printf '  -     %-11s %6s  not run: %s' "$id" "" "$note")") ;;
  esac
done

result=("== gates ==" "${summary[@]}")
if [ ${#failed[@]} -gt 0 ]; then
  for id in "${failed[@]}"; do
    echo "--- $id failed; last lines of $logs/$id.log:"
    grep -v '^__gates_rc=' "$logs/$id.log" | tail -40
  done
  for id in "${failed[@]}"; do
    result+=("FAILED: $id (full log: $logs/$id.log)")
    named="$(grep -v '^__gates_rc=' "$logs/$id.log" | grep -oF -f "$logs/changed.txt" 2>/dev/null | sort -u | head -8 | paste -sd' ' || true)"
    [ -n "$named" ] && result+=("  it names changed files: $named")
  done
  result+=("The tree holds every session's uncommitted edits: a failure in a file you did not touch is another session's work in progress.")
else
  rm -rf "$logs"
  [ "$rc" = 0 ] && result+=("All selected gates passed.") || result+=("A gate's tool is missing (MISS above): not verified.")
fi
printf '%s\n' "${result[@]}"
# Recorded for every session that asked before this run started; for reuse on
# an unchanged tree only if no session changed it while the gates ran.
fp_rec="$fp0"
if [ "$(gate_tree_fp)" != "$fp0" ]; then
  fp_rec=-
  echo "gates: the tree changed while they ran (another session's edits?): the result stands only for sessions that asked before it started"
fi
{ printf 'fp %s\nkey %s\nrc %s\nat %s\nstart %s\npass %s\nfail %s\n--\n' \
    "$fp_rec" "$key" "$rc" "$(date +%s)" "$t_start" "${pass_toks# }" "${fail_toks# }"
  printf '%s\n' "${result[@]}"; } >"$last.tmp" && mv -f "$last.tmp" "$last"
exit "$rc"
