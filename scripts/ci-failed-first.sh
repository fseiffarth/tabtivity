#!/usr/bin/env bash
# Fail fast in CI: re-run first what failed in this branch's last run, then
# the full suites, each recording what failed for the next run. ci-cd.yml
# keeps the state directory between runs (actions/cache, per OS and branch).
#
#   ci-failed-first.sh previous   last run's failed vitest files and cargo
#                                 tests only; exits non-zero if any still fail
#   ci-failed-first.sh frontend   the full vitest suite, recording failed files
#   ci-failed-first.sh backend    the full cargo test suite, recording failures
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

frontend() {
  local rc=0
  rm -f "$state/vitest.json"
  npx vitest run --reporter=default --reporter=json --outputFile="$state/vitest.json" || rc=$?
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

case "${1:-}" in
  previous) previous ;;
  frontend) frontend ;;
  backend) backend ;;
  *) echo "usage: $0 previous|frontend|backend" >&2; exit 2 ;;
esac
