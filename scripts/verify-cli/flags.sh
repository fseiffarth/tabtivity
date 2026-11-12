#!/usr/bin/env bash
# Snapshot a CLI binary's surface: --version, --help and each named
# subcommand's --help, for `diff -ru` against the previous version's snapshot.
#
#   flags.sh <cli> <label> <bin> [subcommand ...]
#   flags.sh codex 0.167.0 ~/dl/codex exec resume mcp
#   diff -ru tmp/verify-cli/codex/0.166.0/flags tmp/verify-cli/codex/0.167.0/flags
#
# Runs with a scratch HOME and no stdin, so a first-run wizard or an updater
# cannot touch the user's own install.
set -uo pipefail
[ $# -ge 3 ] || { sed -n '2,9p' "$0"; exit 2; }
cli=$1 label=$2 bin=$3; shift 3
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$ROOT/scripts/lib/brand.sh"
out="${VERIFY_OUT:-$ROOT/tmp/verify-cli}/$cli/$label/flags"
home="${VERIFY_OUT:-$ROOT/tmp/verify-cli}/$cli/$label/h-flags"
mkdir -p "$out" "$home"
run() {
  env -u "${APP_ENV_PREFIX}TAB_UID" -u "${APP_LEGACY_ENV_PREFIX}TAB_UID" \
      -u "${APP_ENV_PREFIX}TAB_AGENT" -u "${APP_LEGACY_ENV_PREFIX}TAB_AGENT" \
      HOME="$home" XDG_CONFIG_HOME="$home/.config" XDG_DATA_HOME="$home/.local/share" \
      XDG_STATE_HOME="$home/.local/state" XDG_CACHE_HOME="$home/.cache" \
      timeout 30 "$bin" "$@" </dev/null 2>&1
}
run --version > "$out/version.txt"
run --help > "$out/help.txt"
for sub in "$@"; do run "$sub" --help > "$out/help-$sub.txt"; done
echo "$out"
head -n 3 "$out/version.txt"
