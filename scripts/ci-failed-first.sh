#!/usr/bin/env bash
# Fail fast in CI: re-run first what failed in this branch's last run, then
# the full suites, each recording what failed for the next run. ci-cd.yml
# keeps the state directory between runs (actions/cache, per OS and branch).
#
#   ci-failed-first.sh previous   last run's failed vitest files and cargo
#                                 tests only; exits non-zero if any still fail
#   ci-failed-first.sh frontend   the vitest suite, recording failed files.
#                                 On a CI push to a branch other than main,
#                                 only the tests the change since this OS's
#                                 last green suite can reach
#                                 (scripts/ci-vitest-select.mjs says which, and
#                                 when only the whole suite will do); main, a
#                                 PR, a run started by hand and a local run
#                                 take the whole suite. CI_VITEST_CHANGED=1 or
#                                 =0 forces either.
#   ci-failed-first.sh build      compiles every backend test binary and runs
#                                 none, so the test steps after it only test
#                                 (test-macos: a cache miss there cannot eat
#                                 the test step's time)
#   ci-failed-first.sh backend    the full cargo test suite, recording failures
#   ci-failed-first.sh hung       after a backend run its step's timeout cut
#                                 off: says whether it ran out of time or
#                                 stalled, names the tests that were still
#                                 running and records them as failed
#
# CI_CARGO_SPLIT_BUILD=1 (ci-cd.yml sets it on test-macos) compiles the
# library's test harness on its own before each cargo test: see split_build.
# CI_TEST_STALL_SECONDS (default 300): how long a running test binary may
# print nothing before the backend run's watchdog dumps its threads.
#
# A suite that does not run (an earlier step failed) keeps its old list, so
# its failures are still tried first next time. A listed test that has since
# been renamed or deleted matches nothing and passes.
set -euo pipefail

state="${CI_FAILED_DIR:-.ci-failed}"
manifest="src-tauri/Cargo.toml"
mkdir -p "$state"

# The crate compiles twice for `cargo test`, as the library and as its test
# harness, and cargo runs the two side by side: about 7 GB and 10 GB of
# compiler memory at once (2026-11-16), on a macOS runner that has 7 GB. Built
# first and alone, the harness is fresh when the full build compiles the rest.
# Dependencies still build in parallel. A failure here is left to the cargo
# test that follows, which fails the same way and is the one recorded.
split_build() {
  [ "${CI_CARGO_SPLIT_BUILD:-}" = 1 ] || return 0
  cargo test --manifest-path "$manifest" --lib --no-run || true
}

# The same build `cargo test` does, binaries included, without running them.
build() {
  split_build
  cargo test --manifest-path "$manifest" --no-run
}

previous() {
  local rc=0 files=() tests=() line
  if [ -s "$state/frontend.txt" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && [ -f "$line" ] && files+=("$line")
    done < "$state/frontend.txt"
  fi
  if [ -s "$state/backend.txt" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && tests+=("$line")
    done < "$state/backend.txt"
  fi
  if [ "${#files[@]}" -eq 0 ] && [ "${#tests[@]}" -eq 0 ]; then
    echo "Nothing failed in this branch's last run."
    return 0
  fi
  if [ "${#files[@]}" -gt 0 ]; then
    echo "::group::Frontend files that failed last run (${#files[@]})"
    printf '  %s\n' "${files[@]}"
    echo "::endgroup::"
    npx vitest run --passWithNoTests "${files[@]}" || rc=1
  fi
  if [ "${#tests[@]}" -gt 0 ]; then
    echo "::group::Backend tests that failed last run (${#tests[@]})"
    printf '  %s\n' "${tests[@]}"
    echo "::endgroup::"
    split_build
    cargo test --manifest-path "$manifest" -- --exact "${tests[@]}" || rc=1
  fi
  [ "$rc" -eq 0 ] || echo "::error::Tests that failed in the last run still fail; the full suites were not run."
  return "$rc"
}

# The commit the frontend suite last passed at on this OS, when this run may
# test only what changed since: prints it, or nothing for a whole-suite run.
# The base is that commit, never the push's `before`: a run a newer push
# cancelled tested nothing, and its commits must not go untested.
frontend_base() {
  local base changed="${CI_VITEST_CHANGED:-}"
  if [ -z "$changed" ] && [ "${GITHUB_EVENT_NAME:-}" = push ] \
    && [[ "${GITHUB_REF:-}" == refs/heads/* ]] && [ "$GITHUB_REF" != refs/heads/main ]; then
    changed=1
  fi
  [ "$changed" = 1 ] && [ -s "$state/frontend-passed.txt" ] || return 0
  base="$(tr -d '[:space:]' < "$state/frontend-passed.txt")" || return 0
  [[ "$base" =~ ^[0-9a-f]{40}$ ]] || return 0
  # A CI checkout holds the tip alone; one more commit is enough for the diff.
  git cat-file -e "$base^{commit}" 2>/dev/null \
    || git fetch --quiet --no-tags --depth=1 origin "$base" 2>/dev/null \
    || return 0
  git cat-file -e "$base^{commit}" 2>/dev/null && printf '%s' "$base"
}

frontend() {
  local rc=0 base selection="" files=() line
  rm -f "$state/vitest.json"
  base="$(frontend_base)" || base=""
  if [ -n "$base" ]; then
    selection="$(node scripts/ci-vitest-select.mjs "$base" | tr -d '\r')" || selection=""
  fi
  # A while-read, not mapfile: the macOS runner's bash is 3.2.
  if [[ "$selection" == RELATED* ]]; then
    while IFS= read -r line; do
      [ -n "$line" ] && files+=("$line")
    done < <(sed 1d <<<"$selection")
  fi
  if [ "${#files[@]}" -gt 0 ]; then
    echo "::group::Tests related to the ${#files[@]} files below (the suite passed at ${base:0:9})"
    printf '  %s\n' "${files[@]}"
    echo "::endgroup::"
    npx vitest related --run --passWithNoTests --reporter=default --reporter=json \
      --outputFile="$state/vitest.json" "${files[@]}" || rc=$?
  else
    [ -z "$base" ] || echo "The whole suite: ${selection#FULL }"
    npx vitest run --reporter=default --reporter=json --outputFile="$state/vitest.json" || rc=$?
  fi
  [ "$rc" -ne 0 ] || git rev-parse HEAD > "$state/frontend-passed.txt"
  # Paths relative to the checkout, forward slashes on every OS. No report
  # (vitest died before writing it) keeps the old list.
  if [ -s "$state/vitest.json" ]; then
    node -e '
      const fs = require("fs"), path = require("path");
      const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const failed = (report.testResults || [])
        .filter((r) => r.status === "failed")
        .map((r) => path.relative(process.cwd(), r.name).split(path.sep).join("/"));
      fs.writeFileSync(process.argv[2], failed.length ? failed.join("\n") + "\n" : "");
    ' "$state/vitest.json" "$state/frontend.txt" || true
    rm -f "$state/vitest.json"
  fi
  return "$rc"
}

backend() {
  local rc=0 log="$state/cargo-test.log" wd
  split_build
  : > "$log"
  watchdog "$log" &
  wd=$!
  cargo test --manifest-path "$manifest" 2>&1 | tee "$log" || rc=$?
  kill "$wd" 2>/dev/null || true
  wait "$wd" 2>/dev/null || true
  # `test path::to::name ... FAILED`; doctest names carry spaces and are
  # left to the full run. A build failure lists nothing, which is right:
  # the next run's full suite finds it again.
  tr -d '\r' < "$log" | sed -nE 's/^test ([^ ]+) \.\.\. FAILED$/\1/p' | sort -u > "$state/backend.txt" || true
  rm -f "$log" "$state/cargo-test.grew"
  return "$rc"
}

# The log without carriage returns or the colour codes cargo adds under
# CARGO_TERM_COLOR=always (libtest adds none to a pipe).
plain_log() {
  tr -d '\r' < "$1" | sed "s/$(printf '\033')\\[[0-9;]*m//g"
}

# Where the log's last test binary got to, as "<path>|<count>|<reported>|
# <finished 0 or 1>" (`|`, not a tab: `read` keeps an empty path a field):
# the path from cargo's `Running … (<path>)` line (empty for doctests), the
# count from libtest's `running N tests`.
# Prints nothing while no binary has started.
binary_state() {
  plain_log "$1" | awk '
    /^ *Running .*\(.*\)$/ { bin = $0; sub(/^.*\(/, "", bin); sub(/\)$/, "", bin); total = ""; n = 0; done = 0; next }
    /^ *Doc-tests / { bin = ""; total = ""; n = 0; done = 0; next }
    /^running [0-9]+ tests?$/ { total = $2; next }
    /^test [^ ]+ \.\.\. / { n++ }
    /^test result: / { done = 1 }
    END { if (total != "") printf "%s|%s|%d|%d\n", bin, total, n, done }'
}

test_threads() {
  local n="${RUST_TEST_THREADS:-}"
  [ -n "$n" ] || n="$(getconf _NPROCESSORS_ONLN 2>/dev/null)" || n=""
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || n=4
  printf '%s' "$n"
}

# The first tests of binary $1's list that log $2 has not reported, as many
# as libtest runs at once. libtest starts tests in name order and keeps at
# most that many going, so the ones still running are among these.
unreported() {
  local bin="${1//\\//}" log="$2"
  [ -n "$bin" ] && [ -x "$bin" ] || return 0
  {
    plain_log "$log" | sed -nE 's/^test ([^ ]+) \.\.\. .*$/D \1/p'
    "$bin" --list 2>/dev/null | tr -d '\r' | sed -n 's/: test$//p' | LC_ALL=C sort | sed 's/^/L /'
  } | awk -v k="$(test_threads)" '
    $1 == "D" { done[$2] = 1; next }
    $1 == "L" && !($2 in done) { print $2; if (++n >= k) exit }' || true
}

# Once a running test binary has been silent for CI_TEST_STALL_SECONDS: the
# tests it has not reported, the processes, and its threads (macOS `sample`
# names each test's thread; Linux shows thread states).
dump_stall() {
  local log="$1" quiet="$2" st bin total n done pid
  st="$(binary_state "$log")"
  [ -n "$st" ] || return 0 # still compiling, which prints nothing for long
  IFS="|" read -r bin total n done <<<"$st"
  [ "$done" = 0 ] || return 0
  bin="${bin//\\//}"
  echo "::warning::The backend tests have printed nothing for ${quiet}s ($n of $total reported by ${bin:-the doctests}). libtest warns about a test running over 60s itself, so a silence this long is the whole test process stuck."
  echo "::group::Tests started and not reported (the stuck ones are among these)"
  unreported "$bin" "$log"
  echo "::endgroup::"
  case "$(uname -s)" in Darwin | Linux) ;; *) return 0 ;; esac
  echo "::group::Processes"
  ps -U "$(id -u)" -o pid,ppid,pgid,stat,etime,time,rss,args 2>&1 || true
  echo "::endgroup::"
  [ -n "$bin" ] || return 0
  pid="$(ps -U "$(id -u)" -o pid=,args= 2>/dev/null \
    | awk -v b="${bin##*/}" '{ k = split($2, p, "/"); if (p[k] == b) { print $1; exit } }')" || pid=""
  [ -n "$pid" ] || return 0
  echo "::group::Threads of ${bin##*/} (pid $pid)"
  if [ "$(uname -s)" = Darwin ]; then
    rm -f "$state/sample.txt"
    sample "$pid" 3 -mayDie -file "$state/sample.txt" >/dev/null 2>&1 \
      || sudo -n sample "$pid" 3 -mayDie -file "$state/sample.txt" >/dev/null 2>&1 || true
    if [ -s "$state/sample.txt" ]; then cat "$state/sample.txt"; else echo "sample could not read the process"; fi
    rm -f "$state/sample.txt"
  else
    ps -L -o tid,stat,wchan:32,comm -p "$pid" 2>&1 || true
  fi
  echo "::endgroup::"
}

# Beside a backend run: stamps the time the log last grew, which `hung`
# reads to tell a run that ran out of time from one that stalled, and dumps
# the stall once per silence.
watchdog() {
  local log="$1" stall="${CI_TEST_STALL_SECONDS:-300}" size=-1 new now last dumped=0
  last="$(date +%s)"
  while :; do
    new="$(wc -c < "$log" 2>/dev/null | tr -d ' ')" || new=0
    now="$(date +%s)"
    if [ "$new" != "$size" ]; then
      size="$new" last="$now" dumped=0
      echo "$now" > "$state/cargo-test.grew"
    elif [ "$dumped" = 0 ] && [ $((now - last)) -ge "$stall" ]; then
      dumped=1
      dump_stall "$log" $((now - last)) || true
    fi
    # Off the step's output: a sleep the kill orphans must not hold it open.
    sleep 10 </dev/null >/dev/null 2>&1
  done
}

# A backend run that ends on its own removes its log, so a log still here is
# a run the step's timeout killed. libtest prints `test <name> has been
# running for over 60 seconds` for a slow test and `test <name> ... <result>`
# when it ends: a name with the first line and no second was still running.
# The watchdog's stamp says whether output was still coming at the cut (out
# of time) or had stopped (stalled: then the tests libtest had started and
# not reported are named and recorded too).
hung() {
  local log="$state/cargo-test.log" names t st bin="" total="" n="" done="" quiet="" grew="" where running=""
  [ -s "$log" ] || return 0
  names="$(plain_log "$log" | awk '
    /^test .* has been running for over [0-9]+ seconds$/ {
      sub(/^test /, ""); sub(/ has been running for over [0-9]+ seconds$/, ""); slow[$0] = 1; next
    }
    /^test .* \.\.\. / { sub(/^test /, ""); sub(/ \.\.\. .*$/, ""); ended[$0] = 1 }
    END { for (t in slow) if (!(t in ended)) print t }' | sort -u)"
  st="$(binary_state "$log")"
  [ -z "$st" ] || IFS="|" read -r bin total n done <<<"$st"
  [ -s "$state/cargo-test.grew" ] && grew="$(tr -dc '0-9' < "$state/cargo-test.grew")"
  [ -z "$grew" ] || quiet=$(($(date +%s) - grew))
  if [ "$done" = 1 ]; then
    where="after ${bin:-the doctests} finished, before the next binary began"
  else
    where="$n of $total reported by ${bin:-the doctests}"
  fi
  if [ -z "$st" ]; then
    echo "::error::The backend tests ran out of time while compiling: no test binary had started."
  elif [ -n "$quiet" ] && [ "$quiet" -lt 120 ]; then
    echo "::error::The backend tests ran out of time: they were still reporting ${quiet}s before the cut ($where). Nothing stalled; the step needs more time."
  elif [ -n "$quiet" ]; then
    echo "::error::The backend tests stalled: nothing printed for $((quiet / 60)) min before the cut ($where). Past ${CI_TEST_STALL_SECONDS:-300}s of silence the backend step's log holds the watchdog's dump of the test process."
    [ "$done" = 1 ] || running="$(unreported "$bin" "$log")"
  else
    echo "::error::The backend tests were cut off ($where); when they last printed is unknown."
    [ "$done" = 1 ] || running="$(unreported "$bin" "$log")"
  fi
  if [ -n "$names" ]; then
    while IFS= read -r t; do
      echo "::error title=Backend test still running when the step was cut off::$t"
    done <<<"$names"
  elif [ -n "$running" ]; then
    while IFS= read -r t; do
      echo "::error title=Backend test started and not reported when the step stalled::$t"
    done <<<"$running"
  else
    echo "No test reported as still running. The log's last lines:"
    tail -n 25 "$log"
  fi
  { plain_log "$log" | sed -nE 's/^test ([^ ]+) \.\.\. FAILED$/\1/p'; printf '%s\n%s\n' "$names" "$running"; } \
    | sed '/^$/d' | sort -u > "$state/backend.txt" || true
  rm -f "$log" "$state/cargo-test.grew"
}

case "${1:-}" in
  previous) previous ;;
  frontend) frontend ;;
  build) build ;;
  backend) backend ;;
  hung) hung ;;
  *) echo "usage: $0 previous|frontend|build|backend|hung" >&2; exit 2 ;;
esac
