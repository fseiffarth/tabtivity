#!/usr/bin/env bash
#
# Bump the app's version across the four files that must stay in lockstep:
#   - package.json
#   - src-tauri/Cargo.toml   (the [package] version)
#   - src-tauri/tauri.conf.json
#   - Cargo.lock             (the workspace's own [[package]] entry)
#
# The lockfile is in the list because cargo rewrites that entry from Cargo.toml
# the next time it runs. Left out, every auto-bumped push committed a lockfile
# one version behind and handed the tree straight back dirty.
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
