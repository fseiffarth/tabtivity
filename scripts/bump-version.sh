#!/usr/bin/env bash
#
# Bump the app's version across the five files that must stay in lockstep:
#   - package.json
#   - package-lock.json      (its root "version" and packages[""].version)
#   - src-tauri/Cargo.toml   (the [package] version)
#   - src-tauri/tauri.conf.json
#   - Cargo.lock             (the workspace's own [[package]] entry)
#
# The lockfiles are in the list because their tools rewrite those entries from
# the manifest the next time they run (cargo always, npm on its next install).
# Left out, every auto-bumped push committed a lockfile one version behind and
# handed the tree straight back dirty.
#
# Usage:
#   scripts/bump-version.sh [patch|minor|major]   # bump a semver component (default: patch)
#   scripts/bump-version.sh <x.y.z>               # set an explicit version
#
# Prints the new version to stdout. Does not commit or tag.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pkg="$repo_root/package.json"
cargo="$repo_root/src-tauri/Cargo.toml"
tauri="$repo_root/src-tauri/tauri.conf.json"
lock="$repo_root/Cargo.lock"
npm_lock="$repo_root/package-lock.json"

for f in "$pkg" "$cargo" "$tauri"; do
  [ -f "$f" ] || { echo "bump-version: missing $f" >&2; exit 1; }
done

current="$(jq -r '.version' "$pkg")"
[[ "$current" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "bump-version: current version '$current' is not x.y.z" >&2; exit 1; }

arg="${1:-patch}"
if [[ "$arg" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  new="$arg"
else
  IFS=. read -r major minor patch <<<"$current"
  case "$arg" in
    major) new="$((major + 1)).0.0" ;;
    minor) new="${major}.$((minor + 1)).0" ;;
    patch) new="${major}.${minor}.$((patch + 1))" ;;
    *) echo "bump-version: unknown bump '$arg' (want patch|minor|major|x.y.z)" >&2; exit 1 ;;
  esac
fi

# package.json + tauri.conf.json — top-level "version" via jq (preserves formatting/order).
tmp="$(mktemp)"
jq --arg v "$new" '.version = $v' "$pkg" >"$tmp" && mv "$tmp" "$pkg"
tmp="$(mktemp)"
jq --arg v "$new" '.version = $v' "$tauri" >"$tmp" && mv "$tmp" "$tauri"

# package-lock.json — the root's two copies of the version: the top-level one
# and packages[""] (the root package). Edited in place rather than through jq,
# which would re-serialise the whole lockfile; the jq check after it proves both
# landed. Matched by indentation, as brand-flip.sh matches the lockfile's names:
# the top-level key is the only one at two spaces, and packages[""]'s version is
# the first six-space "version" after its `"": {`, before any dependency's.
# Absent lockfile is not an error, as for Cargo.lock below.
if [ -f "$npm_lock" ]; then
  tmp="$(mktemp)"
  awk -v v="$new" '
    !top && /^  "version":/ { sub(/"version": "[^"]*"/, "\"version\": \"" v "\""); top = 1 }
    /^    "": \{/ { root = 1 }
    root && !rooted && /^      "version":/ { sub(/"version": "[^"]*"/, "\"version\": \"" v "\""); rooted = 1 }
    root && /^    \}/ { root = 0 }
    { print }
  ' "$npm_lock" >"$tmp" && mv "$tmp" "$npm_lock"
  jq -e --arg v "$new" '.version == $v and .packages[""].version == $v' "$npm_lock" >/dev/null || {
    echo "bump-version: could not set the root version in $npm_lock" >&2; exit 1; }
fi

# Cargo.toml — only the version line inside [package], nothing else.
tmp="$(mktemp)"
awk -v v="$new" '
  /^\[/ { section = $0 }
  section == "[package]" && /^version[[:space:]]*=/ && !done {
    sub(/"[^"]*"/, "\"" v "\""); done = 1
  }
  { print }
' "$cargo" >"$tmp" && mv "$tmp" "$cargo"

# Cargo.lock — only the app's own [[package]] block's version line (the block
# named like Cargo.toml's [package]). Matched on the
# block's own `name`, never on the version string: a dependency that happens to
# sit at the same version must not be rewritten along with us. Absent lockfile is
# not an error (it is generated), so a fresh clone can still bump.
if [ -f "$lock" ]; then
  crate="$(awk '
    /^\[/ { section = $0 }
    section == "[package]" && /^name[[:space:]]*=/ { gsub(/^[^"]*"|".*$/, ""); print; exit }
  ' "$cargo")"
  [ -n "$crate" ] || { echo "bump-version: no [package] name in $cargo" >&2; exit 1; }
  tmp="$(mktemp)"
  awk -v v="$new" -v ours_line="name = \"$crate\"" '
    /^\[\[package\]\]/ { ours = 0 }
    $0 == ours_line { ours = 1 }
    ours && /^version[[:space:]]*=/ && !done {
      sub(/"[^"]*"/, "\"" v "\""); done = 1
    }
    { print }
  ' "$lock" >"$tmp" && mv "$tmp" "$lock"
fi

echo "$new"
