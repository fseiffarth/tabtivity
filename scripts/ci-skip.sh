#!/usr/bin/env bash
# Which OS test jobs of ci-cd.yml a push can skip. Run by its ci-plan job:
#
#   scripts/ci-skip.sh plan        # write ci-plan's outputs to $GITHUB_OUTPUT
#   scripts/ci-skip.sh key <rev>   # print a commit's content key (debugging)
#   scripts/ci-skip.sh carry <before> <head>
#                                  # print the OSes the trailers carry (debugging)
#
# Two ways an OS's tests are skipped, both on a push to a branch other than
# main only (main always runs every OS: release.yml releases from its run):
#
#   * Unchanged: a test job of that OS already passed on the same content.
#     The content key hashes the tracked tree minus NEUTRAL paths (docs, todo,
#     top-level Markdown, screenshots: nothing a build or test reads), with the
#     version the pre-push hook bumps on every push blanked out of the five
#     files it writes. A docs-only push, or a re-run of a green commit, skips.
#   * Carried by a `CI-Only:` trailer: every commit the push adds either
#     touches only neutral or version files, or carries a trailer such as
#     `CI-Only: macos` (or `windows`, `linux`, several separated by commas).
#     An OS no trailer names keeps the verdict it had on the push's `before`
#     commit — only when that verdict was green. This is the author's word,
#     not a proof: a cfg-gated fix in a shared file still compiles on every
#     OS. Main re-checks everything before a release.
#
# A verdict is an artifact named ci-passed-<runner.os>-<key>, uploaded by a
# green test job (and by ci-plan for a carried one, so a second fix on top of
# the first still carries). This looks them up across the repo's runs,
# counting only runs of this repository's own branches.
#
# Fails safe: anything this cannot work out leaves an OS to run its tests,
# and the caller turns an error here into "run everything".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OSES=(Linux Windows macOS)
# The files the pre-push version bump writes (.githooks/pre-push).
VERSION_FILES=(package.json package-lock.json src-tauri/Cargo.toml src-tauri/tauri.conf.json Cargo.lock)
# Most commits one push may add before the trailer check gives up.
MAX_RANGE=100

warn() { echo "::warning::ci-skip: $*" >&2; }

# Paths no build or test reads. docs/help is compiled into the app
# (src-tauri/build.rs), so it is not neutral.
neutral() {
  case "$1" in
    docs/help/*) return 1 ;;
    docs/*|todo/*|screenshots/*) return 0 ;;
    */*) return 1 ;;
    *.md) return 0 ;;
    *) return 1 ;;
  esac
}

is_version_file() {
  local f
  for f in "${VERSION_FILES[@]}"; do [ "$1" = "$f" ] && return 0; done
  return 1
}

# A version file's content at <rev> with the app's own version blanked, so a
# bump alone leaves the key unchanged. Only the app's own entries: a
# dependency's version is real content.
normalized_blob() {
  local rev="$1" path="$2" pkg
  case "$path" in
    package.json|src-tauri/tauri.conf.json)
      git show "$rev:$path" | jq -S 'del(.version)' ;;
    package-lock.json)
      git show "$rev:$path" | jq -S 'del(.version) | if .packages[""] then .packages[""] |= del(.version) else . end' ;;
    src-tauri/Cargo.toml)
      git show "$rev:$path" | awk '!done && /^version = /{print "version = \"\""; done=1; next} {print}' ;;
    Cargo.lock)
      pkg="$(git show "$rev:src-tauri/Cargo.toml" | awk -F'"' '/^name = /{print $2; exit}')"
      [ -n "$pkg" ] || return 1
      git show "$rev:$path" | awk -v want="name = \"$pkg\"" \
        'prev == want && /^version = /{print "version = \"\""; prev=""; next} {print; prev=$0}' ;;
  esac
}

content_key() {
  local rev="$1" mode type oid path
  git rev-parse -q --verify "$rev^{commit}" >/dev/null || return 1
  {
    while IFS=$' \t' read -r -d '' mode type oid path; do
      neutral "$path" && continue
      if is_version_file "$path"; then
        oid="$(normalized_blob "$rev" "$path" | git hash-object --stdin)" || return 1
      fi
      printf '%s %s %s\n' "$mode" "$oid" "$path"
    done < <(git ls-tree -r -z --full-tree "$rev")
  } | sha256sum | cut -c1-40
}

# 0 when <commit> changes only neutral or version files (a version bump, a
# docs commit). A merge never counts as one.
neutral_commit() {
  local c="$1" f
  [ "$(git rev-list --parents -n1 "$c" | wc -w)" -eq 2 ] || return 1
  while IFS= read -r -d '' f; do
    neutral "$f" || is_version_file "$f" || return 1
  done < <(git diff-tree --no-commit-id -r --name-only -z "$c")
}

# The OSes the push's trailers leave out (space-separated runner.os names),
# or nothing.
trailer_carry() {
  local before="$1" head="$2" c tok n
  local -A named=()
  [ -n "$before" ] && ! [[ "$before" =~ ^0+$ ]] || return 0
  git rev-parse -q --verify "$before^{commit}" >/dev/null || return 0
  git merge-base --is-ancestor "$before" "$head" || return 0
  n="$(git rev-list --count "$before..$head")"
  [ "$n" -ge 1 ] && [ "$n" -le "$MAX_RANGE" ] || return 0
  local any=0
  while IFS= read -r c; do
    local value
    value="$(git log -1 --format='%(trailers:key=CI-Only,valueonly,separator=%x2C)' "$c")"
    if [ -z "$value" ]; then
      neutral_commit "$c" && continue
      return 0
    fi
    any=1
    local toks=()
    read -ra toks <<<"$(printf '%s' "$value" | tr ',[:upper:]\n' ' [:lower:] ')"
    for tok in "${toks[@]}"; do
      case "$tok" in
        linux|ubuntu) named[Linux]=1 ;;
        windows) named[Windows]=1 ;;
        macos|mac) named[macOS]=1 ;;
        *) warn "commit ${c:0:9}: unknown CI-Only value '$tok'; every OS runs"; return 0 ;;
      esac
    done
  done < <(git rev-list "$before..$head")
  [ "$any" = 1 ] || return 0
  local os out=""
  for os in "${OSES[@]}"; do [ -n "${named[$os]:-}" ] || out+="$os "; done
  printf '%s' "${out% }"
}

# 0 when a green verdict for <os> on <key> exists in this repo.
passed() {
  local os="$1" key="$2" count
  [ -n "$key" ] || return 1
  count="$(gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=ci-passed-$os-$key&per_page=30" \
    --jq "[.artifacts[] | select(.expired | not)
           | select(.workflow_run.head_repository_id == $GITHUB_REPOSITORY_ID)] | length")" || return 1
  [ "${count:-0}" -gt 0 ]
}

plan() {
  : "${GITHUB_OUTPUT:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_REPOSITORY_ID:?}"
  local head="${HEAD_SHA:-$(git rev-parse HEAD)}" before="${PUSH_BEFORE:-}"
  local key before_key="" carry="" eligible=0 os out="" summary="" reason
  key="$(content_key "$head")" || { warn "no content key for $head"; key=""; }
  out+="key=$key"$'\n'
  if [ "${EVENT_NAME:-}" = push ] && [[ "${REF:-}" == refs/heads/* ]] && [ "${REF:-}" != refs/heads/main ]; then
    eligible=1
    carry="$(trailer_carry "$before" "$head")"
    if [ -n "$carry" ]; then
      before_key="$(content_key "$before")" || { warn "no content key for $before"; before_key=""; carry=""; }
    fi
  fi
  for os in "${OSES[@]}"; do
    local skip=false record=false
    reason="runs"
    if [ "$eligible" = 1 ] && [ -n "$key" ]; then
      if passed "$os" "$key"; then
        skip=true reason="skipped: this content already passed on $os"
      elif [[ " $carry " == *" $os "* ]] && [ "$before_key" != "$key" ] && passed "$os" "$before_key"; then
        skip=true record=true reason="skipped: carried from ${before:0:9} by the push's CI-Only trailers"
      fi
    fi
    [ "$skip" = true ] && echo "::notice title=test-$os $reason::Push to main or run the workflow by hand for a full run."
    out+="skip_$(tr '[:upper:]' '[:lower:]' <<<"$os")=$skip"$'\n'
    out+="record_$(tr '[:upper:]' '[:lower:]' <<<"$os")=$record"$'\n'
    summary+="| $os | $reason |"$'\n'
  done
  # All at once, at the end: a failure above leaves no partial plan.
  printf '%s' "$out" >>"$GITHUB_OUTPUT"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '### OS test plan\n\nContent key `%s`%s.\n\n| OS | tests |\n|---|---|\n%s' \
      "${key:-none}" "${carry:+, CI-Only carries: $carry}" "$summary" >>"$GITHUB_STEP_SUMMARY"
  fi
  printf '%s' "$out"
}

case "${1:-}" in
  plan) plan ;;
  key) content_key "${2:-HEAD}" ;;
  carry) trailer_carry "${2:?before}" "${3:-HEAD}"; echo ;;
  *) echo "usage: $0 plan | key [<rev>] | carry <before> [<head>]" >&2; exit 2 ;;
esac
