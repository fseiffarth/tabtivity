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
#   ci-failed-first.sh backend    the full cargo test suite, recording failures
#   ci-failed-first.sh hung       after a backend run its step's timeout cut
#                                 off: names the tests that were still running
#                                 and records them as failed
#
# A suite that does not run (an earlier step failed) keeps its old list, so
# its failures are still tried first next time. A listed test that has since
# been renamed or deleted matches nothing and passes.
set -euo pipefail

state="${CI_FAILED_DIR:-.ci-failed}"
manifest="src-tauri/Cargo.toml"
mkdir -p "$state"

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
  local rc=0 log="$state/cargo-test.log"
  cargo test --manifest-path "$manifest" 2>&1 | tee "$log" || rc=$?
  # `test path::to::name ... FAILED`; doctest names carry spaces and are
  # left to the full run. A build failure lists nothing, which is right:
  # the next run's full suite finds it again.
  tr -d '\r' < "$log" | sed -nE 's/^test ([^ ]+) \.\.\. FAILED$/\1/p' | sort -u > "$state/backend.txt" || true
  rm -f "$log"
  return "$rc"
}

# A backend run that ends on its own removes its log, so a log still here is
# a run the step's timeout killed. libtest prints `test <name> has been
# running for over 60 seconds` for a slow test and `test <name> ... <result>`
# when it ends: a name with the first line and no second was still running.
hung() {
  local log="$state/cargo-test.log" names t
  [ -s "$log" ] || return 0
  names="$(tr -d '\r' < "$log" | awk '
    /^test .* has been running for over [0-9]+ seconds$/ {
      sub(/^test /, ""); sub(/ has been running for over [0-9]+ seconds$/, ""); slow[$0] = 1; next
    }
    /^test .* \.\.\. / { sub(/^test /, ""); sub(/ \.\.\. .*$/, ""); ended[$0] = 1 }
    END { for (t in slow) if (!(t in ended)) print t }' | sort -u)"
  if [ -n "$names" ]; then
    while IFS= read -r t; do
      echo "::error title=Backend test still running when the step was cut off::$t"
    done <<<"$names"
  else
    echo "::error::The backend tests were cut off with no test reported as still running. The log's last lines:"
    tail -n 25 "$log"
  fi
  { tr -d '\r' < "$log" | sed -nE 's/^test ([^ ]+) \.\.\. FAILED$/\1/p'; printf '%s\n' "$names"; } \
    | sed '/^$/d' | sort -u > "$state/backend.txt" || true
  rm -f "$log"
}

case "${1:-}" in
  previous) previous ;;
  frontend) frontend ;;
  backend) backend ;;
  hung) hung ;;
  *) echo "usage: $0 previous|frontend|backend|hung" >&2; exit 2 ;;
esac
